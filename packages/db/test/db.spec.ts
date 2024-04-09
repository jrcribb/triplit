import { InMemoryTupleStorage } from '@triplit/tuple-database';
import { describe, expect, it, beforeEach, beforeAll, vi } from 'vitest';
import {
  and,
  Migration,
  DB,
  or,
  Schema as S,
  CollectionQueryBuilder,
  queryResultToJson,
  WriteRuleError,
  InvalidFilterError,
  DBTransaction,
  schemaToJSON,
  DBSerializationError,
  InvalidInternalEntityIdError,
  InvalidEntityIdError,
  EntityNotFoundError,
  InvalidMigrationOperationError,
  InvalidOperationError,
  InvalidCollectionNameError,
  InvalidInsertDocumentError,
  CollectionNotFoundError,
  InvalidSchemaPathError,
  SessionVariableNotFoundError,
  InvalidOrderClauseError,
} from '../src';
import { Models, hashSchemaJSON } from '../src/schema.js';
import { classes, students, departments } from './sample_data/school.js';
import { MemoryBTreeStorage as MemoryStorage } from '../src/storage/memory-btree.js';
import {
  testSubscription,
  testSubscriptionTriples,
} from './utils/test-subscription.js';
import {
  appendCollectionToId,
  prepareQuery,
  stripCollectionFromId,
} from '../src/db-helpers.js';
import { TripleRow } from '../dist/types/triple-store-utils.js';
import { triplesToStateVector } from '../src/triple-store-utils.js';
import { fetchDeltaTriples } from '../src/collection-query.js';

const pause = async (ms: number = 100) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// const storage = new InMemoryTupleStorage();
const storage = new MemoryStorage();

async function testDBAndTransaction<M extends Models<any, any> | undefined>(
  // should return a new instance if you are performing writes in your test
  dbFactory: () => DB<M> | Promise<DB<M>>,
  test: (db: DB<M> | DBTransaction<M>) => void | Promise<void>,
  scope: { db: boolean; tx: boolean } = { db: true, tx: true }
) {
  if (scope.db) await test(await dbFactory());
  if (scope.tx)
    await (
      await dbFactory()
    ).transact(async (tx) => {
      await test(tx);
    });
}

describe('Database API', () => {
  let db: DB<any>;
  beforeEach(async () => {
    db = new DB({});
    for (const student of students) {
      await db.insert('Student', student);
    }
    for (const schoolClass of classes) {
      await db.insert('Class', schoolClass);
    }
    for (const department of departments) {
      await db.insert('Department', department);
    }
    for (const rapper of RAPPERS_AND_PRODUCERS) {
      await db.insert('Rapper', rapper);
    }
  });
  it('can furnish the client id', async () => {
    expect(await db.getClientId()).toBeTruthy();
  });

  it('will throw an error if the provided entity id has a # sign in it', async () => {
    expect(
      async () =>
        await db.insert('Student', { name: 'John Doe', id: 'John#Doe' })
    ).rejects.toThrowError(InvalidEntityIdError);
    expect(
      db.transact((tx) =>
        tx.insert('Student', { name: 'John Doe', id: 'John#Doe' })
      )
    ).rejects.toThrowError(InvalidEntityIdError);
  });

  it('will throw an error when it parses an ID with a # in it', async () => {
    expect(() => stripCollectionFromId('Student#john#1')).toThrowError(
      InvalidInternalEntityIdError
    );
  });

  it('can lookup entity by Id', async () => {
    const student1 = await db.fetchById('Student', students[0].id);
    expect(student1).not.toBeNull();

    const notAStudent = await db.fetchById('Student', `not_a_real_id`);
    expect(notAStudent).toBeNull();
  });

  it('supports basic queries with filters', async () => {
    const eq = await db.fetch(
      CollectionQueryBuilder('Class')
        .where([['level', '=', 100]])
        .build()
    );
    expect(eq.size).toBe(classes.filter((cls) => cls.level === 100).length);
    const neq = await db.fetch(
      CollectionQueryBuilder('Class')
        .where([['level', '!=', 100]])
        .build()
    );
    expect(neq.size).toBe(classes.filter((cls) => cls.level !== 100).length);
    const gt = await db.fetch(
      CollectionQueryBuilder('Class')
        .where([['level', '>', 100]])
        .build()
    );
    expect(gt.size).toBe(classes.filter((cls) => cls.level > 100).length);
    const gte = await db.fetch(
      CollectionQueryBuilder('Class')
        .where([['level', '>=', 100]])
        .build()
    );
    expect(gte.size).toBe(classes.filter((cls) => cls.level >= 100).length);
    const lt = await db.fetch(
      CollectionQueryBuilder('Class')
        .where([['level', '<', 200]])
        .build()
    );
    expect(lt.size).toBe(classes.filter((cls) => cls.level < 200).length);
    const lte = await db.fetch(
      CollectionQueryBuilder('Class')
        .where([['level', '<=', 200]])
        .build()
    );
    expect(lte.size).toBe(classes.filter((cls) => cls.level <= 200).length);
    const _in = await db.fetch(
      CollectionQueryBuilder('Class')
        .where([['level', 'in', [100, 200]]])
        .build()
    );
    expect(_in.size).toBe(4);
    const nin = await db.fetch(
      CollectionQueryBuilder('Class')
        .where([['level', 'nin', [100, 200]]])
        .build()
    );
    expect(nin.size).toBe(1);
  });
  it('treats "in" operations on sets as a defacto "intersects"', async () => {
    const newDb = new DB({
      schema: {
        collections: {
          test: { schema: S.Schema({ id: S.Id(), set: S.Set(S.String()) }) },
        },
      },
    });
    await newDb.insert('test', { id: '1', set: new Set(['a', 'b', 'c']) });
    await newDb.insert('test', { id: '2', set: new Set(['a']) });
    await newDb.insert('test', { id: '3', set: new Set(['d', 'e']) });
    let results = await newDb.fetch(
      CollectionQueryBuilder('test')
        .where([['set', 'in', ['a', 'd']]])
        .build()
    );
    expect(results.size).toBe(3);
    results = await newDb.fetch(
      CollectionQueryBuilder('test')
        .where([['set', 'in', ['d']]])
        .build()
    );
    expect(results.size).toBe(1);
    results = await newDb.fetch(
      CollectionQueryBuilder('test')
        .where([['set', 'in', ['a', 'b']]])
        .build()
    );
    expect(results.size).toBe(2);
  });

  it('supports basic queries with the "like" operator', async () => {
    const studentsNamedJohn = await db.fetch(
      CollectionQueryBuilder('Student').where(['name', 'like', 'John%']).build()
    );
    expect(studentsNamedJohn.size).toBe(
      students.filter((s) => s.name.startsWith('John')).length
    );

    const studentswithIeIntheirName = await db.fetch(
      CollectionQueryBuilder('Student')
        .where([['name', 'like', '%ie%']])
        .build()
    );
    expect(studentswithIeIntheirName.size).toBe(
      students.filter((s) => s.name.includes('ie')).length
    );

    const calculusClasses = await db.fetch(
      CollectionQueryBuilder('Class')
        .where([['name', 'like', 'Calculus _']])
        .build()
    );
    expect(calculusClasses.size).toBe(
      classes.filter((c) => new RegExp('Calculus *').test(c.name)).length
    );

    const escapeOutRegex = await db.fetch(
      CollectionQueryBuilder('Class')
        .where([['name', 'like', 'Calculus*+']])
        .build()
    );
    expect(escapeOutRegex.size).not.toBe(
      classes.filter((c) => new RegExp('Calculus *').test(c.name)).length
    );
    const departmentsWithSinTheMiddleOfTheirName = await db.fetch(
      CollectionQueryBuilder('Department')
        .where([['name', 'like', '%_s_%']])
        .build()
    );
    expect(departmentsWithSinTheMiddleOfTheirName.size).toBe(2);
    const artistsWithDashInTheirName = await db.fetch(
      CollectionQueryBuilder('Rapper')
        .where([['name', 'like', '%-%']])
        .build()
    );
    expect(artistsWithDashInTheirName.size).toBe(2);
    const artistsWithDollaSignInTheirName = await db.fetch(
      CollectionQueryBuilder('Rapper')
        .where([['name', 'like', '%$%']])
        .build()
    );
    expect(artistsWithDollaSignInTheirName.size).toBe(1);

    const artistsWithQuotesInTheirName = await db.fetch(
      CollectionQueryBuilder('Rapper')
        .where([['name', 'like', "%'%'%"]])
        .build()
    );
    expect(artistsWithQuotesInTheirName.size).toBe(2);

    const Biggie = await db.fetch(
      CollectionQueryBuilder('Rapper')
        .where([['name', 'like', '%B.I.G%.']])
        .build()
    );
    expect(Biggie.size).toBe(1);
  });

  it('support basic queries with the "nlike" operator', async () => {
    const Biggie = await db.fetch(
      CollectionQueryBuilder('Rapper')
        .where([['name', 'nlike', '%B.I.G%.']])
        .build()
    );
    expect(Biggie.size).toBe(RAPPERS_AND_PRODUCERS.length - 1);
    const artistsWithoutQuotesInTheirName = await db.fetch(
      CollectionQueryBuilder('Rapper')
        .where([['name', 'nlike', "%'%'%"]])
        .build()
    );
    expect(artistsWithoutQuotesInTheirName.size).toBe(
      RAPPERS_AND_PRODUCERS.length - 2
    );
  });

  const RAPPERS_AND_PRODUCERS = [
    { name: 'Ty Dolla $ign', id: '1', rank: 1 },
    { name: 'Boi-1da', id: '2', rank: 2 },
    { name: 'Mike Will Made-It', id: '3', rank: 3 },
    { name: "Noah '40' Shebib", id: '4', rank: 4 },
    { name: 'The Notoious B.I.G.', id: '5', rank: 5 },
    { name: "Travis 'LaFlame' Scott", id: '6', rank: 6 },
  ];

  it('supports basic queries with the has and !has operators', async () => {
    const db = new DB({
      schema: {
        collections: {
          Classes: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
              level: S.Number(),
              department: S.String(),
              enrolled_students: S.Set(S.String()),
            }),
          },
        },
      },
    });
    await Promise.all(
      classes.map((cls) =>
        db.insert('Classes', {
          ...cls,
          enrolled_students: new Set(cls.enrolled_students),
        })
      )
    );
    const results = await db.fetch(
      CollectionQueryBuilder('Classes')
        .where([['enrolled_students', 'has', 'student-1']])
        .build()
    );
    expect([...results.keys()]).toStrictEqual(['class-2', 'class-3']);
    const results2 = await db.fetch(
      CollectionQueryBuilder('Classes')
        .where([['enrolled_students', 'has', 'bad-id']])
        .build()
    );
    expect(results2.size).toBe(0);
    const results3 = await db.fetch(
      CollectionQueryBuilder('Classes')
        .where([['enrolled_students', '!has', 'student-1']])
        .build()
    );
    expect([...results3.keys()]).toStrictEqual([
      'class-1',
      'class-4',
      'class-5',
    ]);
    const results4 = await db.fetch(
      CollectionQueryBuilder('Classes')
        .where([['enrolled_students', '!has', 'bad-id']])
        .build()
    );
    expect(results4.size).toBe(5);
  });

  it('supports basic queries without filters', async () => {
    const results = await db.fetch(CollectionQueryBuilder('Student').build());
    expect(results.size).toBe(students.length);
  });

  it('throws an error when filtering with an unimplmented operator', async () => {
    await expect(
      db.fetch(
        CollectionQueryBuilder('Rapper')
          .where([['name', 'not a real operator', 'Boi-1da']])
          .build()
      )
    ).rejects.toThrowError(InvalidFilterError);
  });

  it('supports filtering on one attribute with multiple operators (and() helper)', async () => {
    const results = await db.fetch(
      CollectionQueryBuilder('Rapper')
        .where([
          and([
            ['rank', '<', 5],
            ['rank', '>=', 2],
          ]),
        ])
        .build()
    );
    const ranks = [...results.values()].map((r) => r.rank);
    expect(Math.max(...ranks)).toBe(4);
    expect(Math.min(...ranks)).toBe(2);
    expect(results.size).toBe(3);
  });

  it('supports filtering on one attribute with multiple operators (additive)', async () => {
    const results = await db.fetch(
      CollectionQueryBuilder('Rapper')
        .where([['rank', '<', 5]])
        .where('rank', '>=', 2)
        .where()
        .build()
    );
    const ranks = [...results.values()].map((r) => r.rank);
    expect(Math.max(...ranks)).toBe(4);
    expect(Math.min(...ranks)).toBe(2);
    expect(results.size).toBe(3);
  });

  it('throws an error when a non-terminal object path is provided', async () => {
    await db.insert('Rapper', {
      id: '7',
      name: 'Jay-Z',
      album: { name: 'The Blueprint', released: '2001' },
    });
    await expect(
      db.fetch(
        CollectionQueryBuilder('Rapper')
          .where([['album', '=', 'The Blueprint']])
          .build()
      )
    ).rejects.toThrowError(InvalidFilterError);
    await expect(
      db.fetch(
        CollectionQueryBuilder('Rapper')
          .where([['album.name', '=', 'The Blueprint']])
          .build()
      )
    ).resolves.not.toThrowError();
  });

  it.todo('supports compound queries', async () => {
    const twoHundredLevelClasses = db
      .collection('Class')
      .query()
      .where([['level', '=', 200]])
      .fetch();
    const twoHundredMathClasses = twoHundredLevelClasses
      .query({
        where: [['department>Department.name', '=', 'math']],
      })
      .fetch();
    expect(twoHundredLevelClasses.query()).toHaveLength(2);
    expect(twoHundredMathClasses).toHaveLength(1);
  });

  it('supports basic select statements', async () => {
    const results = await db.fetch(
      CollectionQueryBuilder('Class').select(['name', 'level']).build()
    );
    [...results.values()].forEach((entityObj) => {
      expect(entityObj).toHaveProperty('name');
      expect(entityObj).toHaveProperty('level');
      expect(entityObj).not.toHaveProperty('department');
      expect(entityObj).not.toHaveProperty('enrolled_students');
    });
  });

  it('can report basic collection stats from the database', async () => {
    const stats = await db.getCollectionStats();
    expect([...stats.keys()]).toEqual([
      'Class',
      'Department',
      'Rapper',
      'Student',
    ]);
    expect(stats.get('Student')).toBe(students.length);
    expect(stats.get('Class')).toBe(classes.length);
    expect(stats.get('Department')).toBe(departments.length);
  });
  it('can convert query results to JSON', async () => {
    const results = await db.fetch(
      CollectionQueryBuilder('Class').select(['name', 'level']).build()
    );
    const json = queryResultToJson(results);
    expect(json).toBeTypeOf('object');
  });

  it('transactions return the txId and result of the callback', async () => {
    const db = new DB();
    {
      const result = await db.transact(async (tx) => {
        await tx.insert('Student', { name: 'John Doe', id: '1' });
        return 'hello';
      });
      expect(result.txId).toBeTruthy();
      expect(result.output).toBe('hello');
    }
    {
      const result = await db.transact(async (tx) => {
        await tx.insert('Student', { name: 'Jane Doe', id: '2' });
      });
      expect(result.txId).toBeTruthy();
      expect(result.output).toBe(undefined);
    }
  });

  it('insert throws an error if no collection name is provided', async () => {
    const db = new DB();
    await expect(
      db.insert(undefined, { name: 'John Doe', id: '1' })
    ).rejects.toThrowError(InvalidCollectionNameError);
    await expect(
      db.insert('', { name: 'John Doe', id: '1' })
    ).rejects.toThrowError(InvalidCollectionNameError);
  });

  it('insert throws an error if no document is provided', async () => {
    const db = new DB();
    await expect(db.insert('Student', undefined)).rejects.toThrowError(
      InvalidInsertDocumentError
    );
  });

  it('insert throws an error if the document is not an object', async () => {
    const db = new DB();
    await expect(db.insert('Student', undefined)).rejects.toThrowError(
      InvalidInsertDocumentError
    );
    await expect(db.insert('Student', 123)).rejects.toThrowError(
      InvalidInsertDocumentError
    );
  });

  it('delete throws an error if no collection name is provided', async () => {
    const db = new DB();
    await expect(db.delete(undefined, '1')).rejects.toThrowError(
      InvalidCollectionNameError
    );
    await expect(db.delete('', '1')).rejects.toThrowError(
      InvalidCollectionNameError
    );
  });

  it('update throws an error if you attempt to mutate the entity id', async () => {
    // Schemaless
    const db = new DB();
    await db.insert('Student', {
      name: 'John Doe',
      id: '1',
      not: { id: 'not_id' },
    });
    await expect(
      db.update('Student', '1', (entity) => {
        entity.id = '2';
      })
    ).rejects.toThrowError(InvalidOperationError);
    await expect(
      db.update('Student', '1', (entity) => {
        delete entity.id;
      })
    ).rejects.toThrowError(InvalidOperationError);
    await expect(
      db.update('Student', '1', (entity) => {
        entity.not.id = 'updated';
      })
    ).resolves.not.toThrow();

    // Schemaful
    const schemaDb = new DB({
      schema: {
        collections: {
          Student: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
              not: S.Record({ id: S.String() }),
            }),
          },
        },
      },
    });
    await schemaDb.insert('Student', {
      id: '1',
      name: 'John Doe',
      not: { id: 'not_id' },
    });
    await expect(
      schemaDb.update('Student', '1', (entity) => {
        entity.id = '2';
      })
    ).rejects.toThrowError(InvalidOperationError);
    await expect(
      schemaDb.update('Student', '1', (entity) => {
        delete entity.id;
      })
    ).rejects.toThrowError(InvalidOperationError);
    await expect(
      schemaDb.update('Student', '1', (entity) => {
        entity.not.id = 'updated';
      })
    ).resolves.not.toThrow();
  });

  it('checks the schema has proper fields on an insert', async () => {
    const db = new DB({
      schema: {
        collections: {
          test: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
              age: S.Number(),
              email: S.String({ nullable: true, default: null }),
            }),
          },
        },
      },
    });
    // TODO: use more specific error, validation function should probably return a string or list of errors as context messages so we can give context to why the failure occurred
    // no missing fields
    await expect(
      db.insert('test', {
        id: '1',
      })
    ).rejects.toThrowError(DBSerializationError);

    // no extra fields
    await expect(
      db.insert('test', {
        id: '1',
        name: 'John Doe',
        age: 22,
        extraField: 'extra',
      })
    ).rejects.toThrowError(DBSerializationError);

    // fields have valid types
    await expect(
      db.insert('test', {
        id: '1',
        name: 'John Doe',
        age: '22',
      })
    )
      .rejects.toThrowError(DBSerializationError)
      // TODO: maybe setup custom matchers to test messages: https://jestjs.io/docs/expect#expectextendmatchers
      // Ugly but so is setting up try / catch
      .then((assertion) => {
        const error = assertion.__flags.object;
        expect(error.message).toContain(
          'invalid value for age (Expected a number value, but got string instead.)'
        );
      });
  });

  it('updater function returns js values on reads', async () => {
    const db = new DB({
      schema: {
        collections: {
          test: {
            schema: S.Schema({
              id: S.Id(),
              string: S.String(),
              number: S.Number(),
              nullable: S.String({ nullable: true }),
              date: S.Date(),
              set: S.Set(S.String()),
            }),
          },
        },
      },
    });
    const NOW = new Date();
    await db.insert('test', {
      id: '1',
      string: 'string',
      number: 1,
      nullable: null,
      date: NOW,
      set: new Set(['a', 'b', 'c']),
    });
    await db.update('test', '1', (entity) => {
      expect(entity.string).toBe('string');
      expect(entity.number).toBe(1);
      expect(entity.nullable).toBe(null);
      expect(entity.date).toStrictEqual(NOW);
      expect(entity.set).toBeInstanceOf(Set);
      expect([...entity.set.values()]).toEqual(['a', 'b', 'c']);
      // For now just logging
      // TODO: figure out what to do with 'constructor' prop
      // Also figure out how to test without going through proxy
      console.log(entity);
    });
  });
});

it('fetchOne gets first match or null', async () => {
  await testDBAndTransaction(
    () => new DB(),
    async (db) => {
      await db.insert('Student', { name: 'John Doe', id: '1' });
      await db.insert('Student', { name: 'Jane Doe', id: '2' });
      await db.insert('Student', { name: 'John Smith', id: '3' });
      await db.insert('Student', { name: 'Jane Smith', id: '4' });
      const johnQuery = CollectionQueryBuilder('Student')
        .where([['name', 'like', 'John%']])
        .build();
      const ettaQuery = CollectionQueryBuilder('Student')
        .where([['name', 'like', '%Etta%']])
        .build();
      const john = await db.fetchOne(johnQuery);
      expect(john).toBeDefined();
      expect(john.id).toBe('1');
      expect(john.name).toBe('John Doe');

      const etta = await db.fetchOne(ettaQuery);
      expect(etta).toBeNull();
    }
  );
});

describe('OR queries', () => {
  it('supports OR queries', async () => {
    const db = new DB({ source: new InMemoryTupleStorage() });
    // storage.data = [];
    await db.insert('roster', { id: '1', name: 'Alice', age: 22 });

    await db.insert('roster', { id: '2', name: 'Bob', age: 23, team: 'blue' });
    await db.insert('roster', {
      id: '3',
      name: 'Charlie',
      age: 22,
      team: 'blue',
    });
    await db.insert('roster', {
      id: '4',
      name: 'Dennis',
      age: 24,
      team: 'blue',
    });
    await db.insert('roster', { id: '5', name: 'Ella', age: 23, team: 'red' });
    const redOr22 = await db.fetch(
      CollectionQueryBuilder('roster')
        .where([
          or([
            ['team', '=', 'red'],
            ['age', '=', 22],
          ]),
        ])
        .build()
    );
    expect(redOr22).toHaveLength(3);
    expect([...redOr22.keys()]).toEqual(
      expect.arrayContaining(
        ['1', '3', '5'].map((id) => expect.stringContaining(id.toString()))
      )
    );

    const blue23Or22 = await db.fetch(
      CollectionQueryBuilder('roster')
        .where([
          or([
            and([
              ['team', '=', 'blue'],
              ['age', '=', 23],
            ]),
            ['age', '=', 22],
          ]),
        ])
        .build()
    );
    expect(blue23Or22).toHaveLength(3);
    expect([...blue23Or22.keys()]).toEqual(
      expect.arrayContaining(
        [1, 2, 3].map((id) => expect.stringContaining(id.toString()))
      )
    );
  });

  it('can use Sets in or queries', async () => {
    const db = new DB({
      schema: {
        collections: {
          characters: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
              playedBy: S.Set(S.String()),
            }),
          },
        },
      },
    });
    await db.insert('characters', {
      id: '1',
      name: 'Jon Snow',
      playedBy: new Set(['Kit Harington']),
    });
    await db.insert('characters', {
      id: '2',
      name: 'Arya Stark',
      playedBy: new Set(['Maisie Williams']),
    });
    await db.insert('characters', {
      id: '3',
      name: 'Sansa Stark',
      playedBy: new Set(['Sophie Turner']),
    });
    await db.insert('characters', {
      id: '4',
      name: 'Daenerys Targaryen',
      playedBy: new Set(['Emilia Clarke']),
    });
    await db.insert('characters', {
      id: '5',
      name: 'Tyrion Lannister',
      playedBy: new Set(['Peter Dinklage']),
    });
    const result = await db.fetch(
      db
        .query('characters')
        .where(
          or([
            ['name', 'like', '%Stark'],
            ['playedBy', 'has', 'Peter Dinklage'],
          ])
        )
        .build()
    );
    expect(result.size).toBe(3);
  });
});

describe('Register operations', () => {
  let db;
  beforeEach(async () => {
    db = new DB({ source: new InMemoryTupleStorage() });
    await db.insert('employees', { id: 1, name: 'Philip J. Fry' });
    await db.insert('employees', { id: 2, name: 'Turanga Leela' });
    await db.insert('employees', { id: 3, name: 'Amy Wong' });
    await db.insert(
      'employees',
      { id: 4, name: 'Bender Bending Rodriguez' },
      4
    );
    await db.insert('employees', { id: 5, name: 'Hermes Conrad' }, 5);
  });

  it('can set register', async () => {
    const preUpdateQuery = CollectionQueryBuilder('employees')
      .select(['id'])
      .where([['name', '=', 'Philip J. Fry']])
      .build();

    const preUpdateLookup = await db.fetch(preUpdateQuery);
    expect(preUpdateLookup).toHaveLength(1);
    expect(preUpdateLookup.get('1')).toBeTruthy();

    const NEW_NAME = 'Dr. Zoidberg';

    await db.update('employees', '1', async (entity) => {
      entity.name = NEW_NAME;
      expect(entity.name).toBe(NEW_NAME);
    });

    const postUpdateQuery = CollectionQueryBuilder('employees')
      .select(['id', 'name'])
      .where([['name', '=', NEW_NAME]])
      .build();

    const oldQueryResult = await db.fetch(preUpdateQuery);
    const newQueryResult = await db.fetch(postUpdateQuery);
    expect(oldQueryResult).toHaveLength(0);
    expect(newQueryResult).toHaveLength(1);
    expect(newQueryResult.get('1')).toBeTruthy();
    expect(newQueryResult.get('1').name).toBe(NEW_NAME);
  });
});

describe('Set operations', () => {
  const schema = {
    collections: {
      Users: {
        schema: S.Schema({
          id: S.String(),
          name: S.String(),
          friends: S.Set(S.String()),
        }),
      },
    },
  };
  const defaultUser = {
    id: 'user-1',
    name: 'Alice',
    friends: new Set(['Bob', 'Charlie']),
  };

  it('can insert a set', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    const result = await db.fetchById('Users', 'user-1');
    expect(result!.friends).toBeInstanceOf(Set);
    expect([...result!.friends.values()]).toEqual(['Bob', 'Charlie']);
  });

  it('can insert an empty set', async () => {
    const db = new DB({ schema });
    await db.insert('Users', {
      id: 'user-1',
      name: 'Alice',
      friends: new Set(),
    });
    const result = await db.fetchById('Users', 'user-1');
    expect(result!.friends).toBeInstanceOf(Set);
    expect([...result!.friends.values()]).toEqual([]);
  });

  it('sets default to empty set', async () => {
    const db = new DB({ schema });
    await db.insert('Users', {
      id: 'user-1',
      name: 'Alice',
    });
    const result = await db.fetchById('Users', 'user-1');
    expect(result!.friends).toBeInstanceOf(Set);
    expect([...result!.friends.values()]).toEqual([]);
  });

  it('cannot insert a non-set', async () => {
    const db = new DB({ schema });
    await expect(
      db.insert('Users', {
        id: 'user-1',
        name: 'Alice',
        friends: 123,
      })
    ).rejects.toThrowError(DBSerializationError);
  });

  it('cannot insert a set with non-matching values', async () => {
    const db = new DB({ schema });
    await expect(
      db.insert('Users', {
        id: 'user-1',
        name: 'Alice',
        friends: new Set([123]),
      })
    ).rejects.toThrowError(DBSerializationError);
  });

  it('cannot insert a set with null', async () => {
    const db = new DB({ schema });
    await expect(
      db.insert('Users', {
        id: 'user-1',
        name: 'Alice',
        friends: new Set(['Bob', null]),
      })
    ).rejects.toThrowError(DBSerializationError);
  });

  it('can add to set', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    await db.update('Users', 'user-1', async (entity) => {
      entity.friends.add('Diane');
      expect([...entity.friends.values()]).toEqual(['Bob', 'Charlie', 'Diane']);
    });
    const result = await db.fetchById('Users', 'user-1');
    expect(result!.friends).toBeInstanceOf(Set);
    expect([...result!.friends.values()]).toEqual(['Bob', 'Charlie', 'Diane']);
  });

  it('can remove from set', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    await db.update('Users', 'user-1', async (entity) => {
      entity.friends.delete('Bob');
      expect([...entity.friends.values()]).toEqual(['Charlie']);
    });
    {
      const result = await db.fetchById('Users', 'user-1');
      expect(result!.friends).toBeInstanceOf(Set);
      expect([...result!.friends.values()]).toEqual(['Charlie']);
    }
    await db.update('Users', 'user-1', async (entity) => {
      entity.friends.delete('Charlie');
      expect([...entity.friends.values()]).toEqual([]);
    });
    {
      const result = await db.fetchById('Users', 'user-1');
      expect(result!.friends).toBeInstanceOf(Set);
      expect([...result!.friends.values()]).toEqual([]);
    }
  });

  it('can clear a set', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    await db.update('Users', 'user-1', async (entity) => {
      entity.friends.clear();
      expect([...entity.friends.values()]).toEqual([]);
    });
    const result = await db.fetchById('Users', 'user-1');
    expect(result!.friends).toBeInstanceOf(Set);
    expect([...result!.friends.values()]).toEqual([]);
  });

  it('set.size correctly tracks updates', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    await db.update('Users', 'user-1', async (entity) => {
      // initial check
      expect(entity.friends.size).toBe(2);

      // can add and size is updated
      entity.friends.add('Diane');
      expect(entity.friends.size).toBe(3);

      // can delete and size is updated
      entity.friends.delete('Bob');
      expect(entity.friends.size).toBe(2);

      // can clear and size is updated
      entity.friends.clear();
      expect(entity.friends.size).toBe(0);
    });
  });

  it('set.has correctly tracks updates', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    await db.update('Users', 'user-1', async (entity) => {
      // initial check
      expect(entity.friends.has('Bob')).toBe(true);
      expect(entity.friends.has('Diane')).toBe(false);

      // can add and has result is updated
      entity.friends.add('Diane');
      expect(entity.friends.has('Diane')).toBe(true);

      // can delete and has result is updated
      entity.friends.delete('Bob');
      expect(entity.friends.has('Bob')).toBe(false);

      entity.friends.clear();
      expect(entity.friends.has('Bob')).toBe(false);
      expect(entity.friends.has('Charlie')).toBe(false);
      expect(entity.friends.has('Diane')).toBe(false);
    });
  });

  it('set iteration works properly', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    await db.update('Users', 'user-1', async (entity) => {
      // Array.from
      expect(Array.from(entity.friends)).toEqual(['Bob', 'Charlie']);

      // keys
      const keys: string[] = [];
      for (const key of entity.friends.keys()) {
        keys.push(key);
      }
      expect(keys).toEqual(['Bob', 'Charlie']);

      // values
      const values: string[] = [];
      for (const value of entity.friends.values()) {
        values.push(value);
      }
      expect(values).toEqual(['Bob', 'Charlie']);

      // entries
      const entries: [string, string][] = [];
      for (const entry of entity.friends.entries()) {
        entries.push(entry);
      }
      expect(entries).toEqual([
        ['Bob', 'Bob'],
        ['Charlie', 'Charlie'],
      ]);
    });
  });

  it('can assign to a set', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    await db.update('Users', 'user-1', async (entity) => {
      entity.friends = new Set(['test']);
      expect([...entity.friends.values()]).toEqual(['test']);
    });
    const result = await db.fetchById('Users', 'user-1');
    expect([...result!.friends.values()]).toEqual(['test']);
  });

  it('can assign an empty set', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    await db.update('Users', 'user-1', async (entity) => {
      entity.friends = new Set();
      expect([...entity.friends.values()]).toEqual([]);
    });
    const result = await db.fetchById('Users', 'user-1');
    expect([...result!.friends.values()]).toEqual([]);
  });

  it('cannot assign a non-set', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    await expect(
      db.update('Users', 'user-1', async (entity) => {
        entity.friends = 123;
      })
    ).rejects.toThrowError(DBSerializationError);
  });

  it('cannot add the wrong type to a set', async () => {
    const db = new DB({ schema });
    await db.insert('Users', defaultUser);
    await expect(
      db.update('Users', 'user-1', async (entity) => {
        entity.friends.add(123);
      })
    ).rejects.toThrowError(DBSerializationError);
  });

  it('cannot add null to a set', async () => {
    const db = new DB({
      schema,
    });
    await db.insert('Users', defaultUser);
    await expect(
      db.update('Users', 'user-1', async (entity) => {
        entity.friends.add(null);
      })
    ).rejects.toThrowError(DBSerializationError);
  });

  it('can create sets with different types', async () => {
    const schema = {
      collections: {
        test: {
          schema: S.Schema({
            id: S.Id(),
            stringSet: S.Set(S.String()),
            numberSet: S.Set(S.Number()),
            booleanSet: S.Set(S.Boolean()),
            dateSet: S.Set(S.Date()),
          }),
        },
      },
    };
    const db = new DB({
      schema,
    });
    await db.insert('test', {
      id: 'test1',
      stringSet: new Set(['a']),
      numberSet: new Set([1]),
      booleanSet: new Set([true]),
      dateSet: new Set([new Date(2020, 1, 1)]),
    });

    await db.update('test', 'test1', async (entity) => {
      entity.stringSet.add('b');
      entity.numberSet.add(2);
      entity.booleanSet.add(false);
      entity.dateSet.add(new Date(2020, 1, 2));
    });

    const result = await db.fetchById('test', 'test1');
    expect(result.stringSet).toBeInstanceOf(Set);
    expect(result.numberSet).toBeInstanceOf(Set);
    expect(result.booleanSet).toBeInstanceOf(Set);
    expect(result.dateSet).toBeInstanceOf(Set);

    expect(
      [...result.stringSet.values()].every((val) => typeof val === 'string')
    ).toBeTruthy();
    expect(
      [...result.numberSet.values()].every((val) => typeof val === 'number')
    ).toBeTruthy();
    expect(
      [...result.dateSet.values()].every((val) => val instanceof Date)
    ).toBeTruthy();
    expect(
      [...result.booleanSet.values()].every((val) => typeof val === 'boolean')
    ).toBeTruthy();
  });

  // Sets cant really be deleted at the moment, but entities with sets can, make sure fetch still works
  it('set filters can fetch deleted entities', async () => {
    const schema = {
      collections: {
        students: {
          schema: S.Schema({
            id: S.Id(),
            name: S.String(),
            classes: S.Set(S.String()),
          }),
        },
      },
    };
    const db = new DB({ schema });
    await db.insert('students', {
      id: '1',
      name: 'Alice',
      classes: new Set(['math', 'science']),
    });
    await db.insert('students', {
      id: '2',
      name: 'Bob',
      classes: new Set(['math', 'science']),
    });
    await db.delete('students', '1');

    const query = db
      .query('students')
      .where([['classes', '=', 'math']])
      .build();

    const results = await db.fetch(query);
    expect(results.size).toBe(1);
    expect(results.get('2')).toBeDefined();
  });

  it('Can subscribe to queries with a set in the filter', async () => {
    const schema = {
      collections: {
        students: {
          schema: S.Schema({
            id: S.Id(),
            name: S.String(),
            classes: S.Set(S.String()),
          }),
        },
      },
    };

    const db = new DB({ schema });
    const query = db
      .query('students')
      .where([['classes', '=', 'math']])
      .build();
    await db.insert('students', {
      id: '1',
      name: 'Alice',
      classes: new Set(['math', 'science']),
    });

    await testSubscription(db, query, [
      { check: (data) => expect(Array.from(data.keys())).toEqual(['1']) },
      // Insert
      {
        action: async () => {
          await db.transact(async (tx) => {
            await tx.insert('students', {
              id: '2',
              name: 'Bob',
              classes: new Set(['history', 'science']),
            });
            await tx.insert('students', {
              id: '3',
              name: 'Charlie',
              classes: new Set(['math', 'history']),
            });
          });
        },
        check: (data) => expect(Array.from(data.keys())).toEqual(['1', '3']),
      },
      // Update
      {
        action: async () => {
          await db.transact(async (tx) => {
            await tx.update('students', '2', async (entity) => {
              entity.classes.add('math');
            });
            await tx.update('students', '3', async (entity) => {
              entity.classes.delete('math');
            });
          });
        },
        check: (data) => expect(Array.from(data.keys())).toEqual(['1', '2']),
      },
      // Delete
      {
        action: async () => {
          await db.delete('students', '1');
        },
        check: (data) => expect(Array.from(data.keys())).toEqual(['2']),
      },
    ]);
  });
  describe('nullable sets', () => {
    it('can define nullable sets in schema', async () => {
      const schema = {
        collections: {
          test: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
              friends: S.Set(S.String(), { nullable: true }),
            }),
          },
        },
      };
      const db = new DB({ schema });
      await db.insert('test', {
        id: '1',
        name: 'Alice',
        friends: new Set(['Bob', 'Charlie']),
      });
      await db.insert('test', {
        id: '2',
        name: 'Bob',
        friends: null,
      });
      await db.insert('test', {
        id: '3',
        name: 'Charlie',
        friends: new Set(),
      });
      await db.insert('test', {
        id: '4',
        name: 'Diane',
        friends: new Set(['Ella']),
      });

      const result = await db.fetchById('test', '2');
      expect(result!.friends).toBeNull();
      const result2 = await db.fetchById('test', '3');
      expect(result2!.friends).toBeInstanceOf(Set);
      expect([...result2!.friends!.values()]).toEqual([]);
    });

    it('can update a null set to a non-null set', async () => {
      const schema = {
        collections: {
          test: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
              friends: S.Set(S.String(), { nullable: true }),
            }),
          },
        },
      };
      const db = new DB({ schema });
      await db.insert('test', {
        id: '1',
        name: 'Alice',
        friends: null,
      });
      await db.update('test', '1', async (entity) => {
        entity.friends = new Set(['Bob', 'Charlie']);
      });
      const result = await db.fetchById('test', '1');
      expect(result!.friends).toBeInstanceOf(Set);
      expect([...result!.friends!.values()]).toEqual(['Bob', 'Charlie']);
    });
    it('can update update a nullable set to null', async () => {
      const schema = {
        collections: {
          test: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
              friends: S.Set(S.String(), { nullable: true }),
            }),
          },
        },
      };
      const db = new DB({ schema });
      await db.insert('test', {
        id: '1',
        name: 'Alice',
        friends: new Set(['Bob', 'Charlie']),
      });
      await db.update('test', '1', async (entity) => {
        entity.friends = null;
      });
      const result = await db.fetchById('test', '1');
      expect(result!.friends).toBeNull();
    });
  });

  describe('optional sets', () => {
    const schema = {
      collections: {
        test: {
          schema: S.Schema({
            id: S.Id(),
            name: S.String(),
            friends: S.Optional(S.Set(S.String())),
          }),
        },
      },
    };

    it('can delete an optional set', async () => {
      const db = new DB({ schema });
      await db.insert('test', {
        id: '1',
        name: 'Alice',
        friends: new Set(['Bob', 'Charlie']),
      });
      {
        const result = await db.fetchById('test', '1');
        expect(result!.friends).toBeInstanceOf(Set);
        expect([...result!.friends!.values()]).toEqual(['Bob', 'Charlie']);
      }
      await db.update('test', '1', async (entity) => {
        delete entity.friends;
      });
      const result = await db.fetchById('test', '1');
      expect(result!.friends).toBeUndefined();
    });

    it('can assign undefined to optional sets', async () => {
      const db = new DB({ schema });
      await db.insert('test', {
        id: '1',
        name: 'Alice',
        friends: new Set(['Bob', 'Charlie']),
      });
      {
        const result = await db.fetchById('test', '1');
        expect(result!.friends).toBeInstanceOf(Set);
        expect([...result!.friends!.values()]).toEqual(['Bob', 'Charlie']);
      }
      await db.update('test', '1', async (entity) => {
        entity.friends = undefined;
      });
      {
        const result = await db.fetchById('test', '1');
        expect(result!.friends).toBeUndefined();
      }
    });
  });
});

describe('record operations', () => {
  it('schemaless: can insert an empty record', async () => {
    const db = new DB();
    await db.insert('test', {
      id: 'item1',
      shallow: {},
      deep: {
        deeper: {
          deepest: {},
        },
      },
      value: 'test',
    });
    const result = await db.fetchById('test', 'item1');
    expect(result.shallow).toEqual({});
    expect(result.deep.deeper.deepest).toEqual({});
  });

  const defaultRecord = {
    id: 'alice',
    data: {
      firstName: 'Alice',
      lastName: 'Smith',
      address: {
        street: '123 Main St',
        city: 'San Francisco',
      },
    },
  };

  it('schemaless: can update a record to empty', async () => {
    const db = new DB();
    await db.insert('test', defaultRecord);
    await db.update('test', 'alice', async (entity) => {
      entity.data.address = {};
      expect(entity.data).toEqual({
        firstName: 'Alice',
        lastName: 'Smith',
        address: {},
      });
    });
    const result = await db.fetchById('test', 'alice');
    expect(result.data).toEqual({
      firstName: 'Alice',
      lastName: 'Smith',
      address: {},
    });
  });

  it('schemaless: can assign a record to a new attribute', async () => {
    const db = new DB();
    await db.insert('test', defaultRecord);
    await db.update('test', 'alice', async (entity) => {
      entity.data.test = {
        att1: 'val1',
      };
      expect(entity.data.test).toEqual({
        att1: 'val1',
      });
    });
    const result = await db.fetchById('test', 'alice');
    expect(result.data).toEqual({
      ...defaultRecord.data,
      test: {
        att1: 'val1',
      },
    });
  });

  it('schemaless: can assign values', async () => {
    const db = new DB();
    await db.insert('test', defaultRecord);
    await db.update('test', 'alice', async (entity) => {
      entity.data.address = 'val1';
      expect(entity.data.address).toEqual('val1');
    });
    const result = await db.fetchById('test', 'alice');
    expect(result.data).toEqual({
      ...defaultRecord.data,
      address: 'val1',
    });
  });
  it('schemaless: can assign null', async () => {
    const db = new DB();
    await db.insert('test', defaultRecord);
    await db.update('test', 'alice', async (entity) => {
      entity.data.address = null;
      expect(entity.data.address).toEqual(null);
    });
    const result = await db.fetchById('test', 'alice');
    expect(result.data).toEqual({
      ...defaultRecord.data,
      address: null,
    });
  });
  it('schemaless: can assign another record', async () => {
    const db = new DB();
    await db.insert('test', defaultRecord);
    await db.update('test', 'alice', async (entity) => {
      entity.data.address = {
        att1: 'val1',
        attr2: {
          att3: 'val3',
        },
      };
      expect(entity.data.address).toEqual({
        att1: 'val1',
        attr2: {
          att3: 'val3',
        },
      });
    });
    const result = await db.fetchById('test', 'alice');
    expect(result.data).toEqual({
      ...defaultRecord.data,
      address: {
        att1: 'val1',
        attr2: {
          att3: 'val3',
        },
      },
    });
  });
  it('schemaless: can delete properties', async () => {
    const db = new DB();
    await db.insert('test', defaultRecord);
    await db.update('test', 'alice', async (entity) => {
      delete entity.data.firstName;
      delete entity.data.address.city;
      expect(entity.data).toEqual({
        lastName: 'Smith',
        address: {
          street: '123 Main St',
        },
      });
    });
    {
      const result = await db.fetchById('test', 'alice');
      expect(result.data).toEqual({
        lastName: 'Smith',
        address: {
          street: '123 Main St',
        },
      });
    }
    await db.update('test', 'alice', async (entity) => {
      delete entity.data.lastName;
      delete entity.data.address;
      expect(entity.data).toEqual({});
    });
    {
      const result = await db.fetchById('test', 'alice');
      expect(result.data).toEqual({});
    }
  });

  it('schemaless: can delete deep properties', async () => {
    const db = new DB();
    await db.insert('test', {
      id: 'alice',
      data: {
        firstName: 'Alice',
        lastName: 'Smith',
        deep: {
          deeper: {
            deepest: {
              address: {
                street: '123 Main St',
                city: 'San Francisco',
              },
            },
          },
        },
      },
    });
    await db.update('test', 'alice', async (entity) => {
      delete entity.data.deep;
      expect(entity.data).toEqual({
        firstName: 'Alice',
        lastName: 'Smith',
      });
    });
    const result = await db.fetchById('test', 'alice');
    expect(result.data).toEqual({
      firstName: 'Alice',
      lastName: 'Smith',
    });
  });

  const schema = {
    collections: {
      test: {
        schema: S.Schema({
          id: S.Id(),
          data: S.Record({
            firstName: S.String(),
            lastName: S.String(),
            address: S.Record({
              street: S.String(),
              city: S.String(),
            }),
          }),
        }),
      },
    },
  };

  it('schemaful: can insert an empty record', async () => {
    const db = new DB({
      schema: {
        collections: {
          test: {
            schema: S.Schema({
              id: S.Id(),
              shallow: S.Record({}),
              deep: S.Record({
                deeper: S.Record({
                  deepest: S.Record({}),
                }),
              }),
              value: S.String(),
            }),
          },
        },
      },
    });
    await db.insert('test', {
      id: 'item1',
      shallow: {},
      deep: {
        deeper: {
          deepest: {},
        },
      },
      value: 'test',
    });
    const result = await db.fetchById('test', 'item1');
    expect(result.shallow).toEqual({});
    expect(result.deep.deeper.deepest).toEqual({});
  });

  it('schemaful: can update a record', async () => {
    const db = new DB({
      schema,
    });
    await db.insert('test', defaultRecord);
    await db.update('test', 'alice', async (entity) => {
      entity.data = {
        ...entity.data,
        address: {
          city: 'New York',
          street: '123 Main St',
        },
      };
      expect(entity.data).toEqual({
        firstName: 'Alice',
        lastName: 'Smith',
        address: {
          street: '123 Main St',
          city: 'New York',
        },
      });
    });
    const result = await db.fetchById('test', 'alice');
    expect(result.data).toEqual({
      firstName: 'Alice',
      lastName: 'Smith',
      address: {
        street: '123 Main St',
        city: 'New York',
      },
    });
  });

  it('schemaful: cannot update a record to include a new property', async () => {
    const db = new DB({
      schema,
    });
    await db.insert('test', defaultRecord);
    await expect(
      db.update('test', 'alice', async (entity) => {
        entity.data = {
          ...entity.data,
          address: {
            city: 'New York',
            street: '123 Main St',
            foo: 'bar',
          },
        };
      })
    ).rejects.toThrowError(DBSerializationError);
  });

  it('schemaful: cannot update a record with an invalid property', async () => {
    const db = new DB({
      schema,
    });
    await db.insert('test', defaultRecord);
    await expect(
      db.update('test', 'alice', async (entity) => {
        entity.data = {
          ...entity.data,
          address: {
            city: 'New York',
            street: 123,
          },
        };
      })
    ).rejects.toThrowError(DBSerializationError);
  });

  it('schemaful: deleting an attiribute throws an error', async () => {
    const db = new DB({
      schema,
    });
    await db.insert('test', defaultRecord);
    await expect(
      db.update('test', 'alice', async (entity) => {
        delete entity.data.firstName;
      })
    ).rejects.toThrowError(InvalidOperationError);
  });

  it('schemaful: cannot assign a non record', async () => {
    const db = new DB({
      schema,
    });
    await db.insert('test', defaultRecord);
    // TODO: this waits for triple validation to freak out, not sure if we should do it sooner
    await expect(
      db.update('test', 'alice', async (entity) => {
        entity.data = 123;
      })
    ).rejects.toThrowError();
  });

  describe('optional properties', async () => {
    const schema = {
      collections: {
        test: {
          schema: S.Schema({
            id: S.Id(),
            optionalAttr: S.Optional(S.String()),
            record: S.Record({
              attr: S.String(),
              optionalAttr: S.Optional(S.String()),
            }),
          }),
        },
      },
    };

    it('can insert optional properties', async () => {
      const db = new DB({
        schema,
      });
      await db.insert('test', {
        id: 'item1',
        record: {
          attr: 'attr',
        },
      });
      {
        const result = await db.fetchById('test', 'item1');
        expect(result).toEqual({
          id: 'item1',
          record: {
            attr: 'attr',
          },
        });
      }
      await db.insert('test', {
        id: 'item2',
        optionalAttr: undefined,
        record: {
          attr: 'attr',
          optionalAttr: undefined,
        },
      });
      {
        const result = await db.fetchById('test', 'item1');
        expect(result).toEqual({
          id: 'item1',
          record: {
            attr: 'attr',
          },
        });
      }
    });

    it('can update optional properties', async () => {
      const db = new DB({
        schema,
      });
      await db.insert('test', {
        id: 'item1',
        record: {
          attr: 'attr',
        },
      });
      await db.update('test', 'item1', async (entity) => {
        entity.optionalAttr = 'optional';
        entity.record.optionalAttr = 'optional';
      });
      {
        const result = await db.fetchById('test', 'item1');
        expect(result).toEqual({
          id: 'item1',
          optionalAttr: 'optional',
          record: {
            attr: 'attr',
            optionalAttr: 'optional',
          },
        });
      }
      await db.update('test', 'item1', async (entity) => {
        entity.optionalAttr = undefined;
        entity.record.optionalAttr = undefined;
      });
      {
        const result = await db.fetchById('test', 'item1');
        expect(result).toEqual({
          id: 'item1',
          record: {
            attr: 'attr',
          },
        });
      }
    });

    it('can delete optional properties', async () => {
      const db = new DB({
        schema,
      });
      await db.insert('test', {
        id: 'item1',
        record: {
          attr: 'attr',
          optionalAttr: 'optional',
        },
      });
      await db.update('test', 'item1', async (entity) => {
        delete entity.optionalAttr;
        delete entity.record.optionalAttr;
      });
      const result = await db.fetchById('test', 'item1');
      expect(result).toEqual({
        id: 'item1',
        record: {
          attr: 'attr',
        },
      });
    });

    it('can select optional types without values', async () => {
      const db = new DB({
        schema,
      });
      await db.insert('test', {
        id: 'item1',
        record: {
          attr: 'attr',
        },
      });
      {
        const result = await db.fetch(
          db.query('test').select(['optionalAttr']).build()
        );
        expect(result.get('item1')).toEqual({});
      }
      {
        const result = await db.fetch(
          db.query('test').select(['optionalAttr', 'record']).build()
        );
        expect(result.get('item1')).toEqual({
          record: {
            attr: 'attr',
          },
        });
      }
    });

    it('optional properties are read as undefined in the updater if not set', async () => {
      const db = new DB({
        schema,
      });
      await db.insert('test', {
        id: 'item1',
        record: {
          attr: 'attr',
        },
      });
      await db.update('test', 'item1', async (entity) => {
        expect(entity.optionalAttr).toBeUndefined();
        expect(entity.record.optionalAttr).toBeUndefined();
        entity.optionalAttr = 'assigned';
        entity.record.optionalAttr = 'assigned';
        expect(entity.optionalAttr).toBe('assigned');
        expect(entity.record.optionalAttr).toBe('assigned');
      });
    });
  });

  describe('optional records', async () => {
    const schema = {
      collections: {
        test: {
          schema: S.Schema({
            id: S.Id(),
            optionalRecord: S.Optional(
              S.Record({
                attr: S.String(),
              })
            ),
          }),
        },
      },
    };

    it('can delete optional records', async () => {
      const db = new DB({
        schema,
      });
      await db.insert('test', {
        id: 'item1',
        optionalRecord: {
          attr: 'attr',
        },
      });
      {
        const result = await db.fetchById('test', 'item1');
        expect(result).toEqual({
          id: 'item1',
          optionalRecord: {
            attr: 'attr',
          },
        });
      }
      await db.update('test', 'item1', async (entity) => {
        delete entity.optionalRecord;
      });
      {
        const result = await db.fetchById('test', 'item1');
        expect(result).toEqual({
          id: 'item1',
        });
      }
    });
    it('can set optional records to undefined', async () => {
      const db = new DB({
        schema,
      });
      await db.insert('test', {
        id: 'item1',
        optionalRecord: {
          attr: 'attr',
        },
      });
      {
        const result = await db.fetchById('test', 'item1');
        expect(result).toEqual({
          id: 'item1',
          optionalRecord: {
            attr: 'attr',
          },
        });
      }
      await db.update('test', 'item1', async (entity) => {
        entity.optionalRecord = undefined;
      });
      {
        const result = await db.fetchById('test', 'item1');
        expect(result).toEqual({
          id: 'item1',
        });
      }
    });
  });
  it('can add and delete from optional sets', async () => {
    const schema = {
      collections: {
        test: {
          schema: S.Schema({
            id: S.Id(),
            optionalSet: S.Optional(S.Set(S.Number())),
          }),
        },
      },
    };
    const db = new DB({
      schema,
    });
    await db.insert('test', {
      id: 'item1',
      optionalSet: new Set([1, 2]),
    });
    await db.update('test', 'item1', async (entity) => {
      entity.optionalSet.add(3);
    });
    await db.update('test', 'item1', async (entity) => {
      entity.optionalSet.delete(1);
    });
    const result = await db.fetchById('test', 'item1');
    expect(result!.optionalSet?.entries()).toEqual(new Set([2, 3]).entries());
    await db.update('test', 'item1', async (entity) => {
      entity.optionalSet = undefined;
    });
    expect((await db.fetchById('test', 'item1'))!.optionalSet).toBeUndefined();
  });
});

describe('date operations', () => {
  const storage = new InMemoryTupleStorage();
  const schema = {
    collections: {
      students: {
        schema: S.Schema({
          id: S.String(),
          name: S.String(),
          birthday: S.Date(),
        }),
      },
    },
  };
  const db = new DB({
    source: storage,
    schema,
  });
  const defaultData = [
    { id: '1', name: 'Alice', birthday: new Date(1995, 0, 1) },
    { id: '2', name: 'Bob', birthday: new Date(2000, 0, 31) },
    { id: '3', name: 'Charlie', birthday: new Date(1990, 11, 31) },
  ];

  beforeAll(async () => {
    await Promise.all(defaultData.map((doc) => db.insert('students', doc)));
  });

  it('can fetch dates', async () => {
    const student = await db.fetchById('students', '1');
    expect(student.birthday).toBeInstanceOf(Date);
  });
  it('can filter with equal dates', async () => {
    const query = db
      .query('students')
      .where([
        or([
          ['birthday', '=', new Date(2000, 0, 31)],
          ['birthday', '=', new Date(1990, 11, 31)],
        ]),
      ])
      .order(['birthday', 'ASC'])
      .build();
    db.fetch(query).then((results) => {
      expect(results.size).toBe(2);
      expect([...results.values()].map((r) => r.id)).toEqual(['3', '2']);
    });
  });
  it('can filter with not equal dates', async () => {
    const query = db
      .query('students')
      .where([['birthday', '!=', new Date(2000, 0, 31)]])
      .order(['birthday', 'DESC'])
      .build();
    db.fetch(query).then((results) => {
      expect(results.size).toBe(2);
      expect([...results.values()].map((r) => r.id)).toEqual(['1', '3']);
    });
  });
  it('can filter with greater or less than dates', async () => {
    const query = db
      .query('students')
      .where([
        and([
          ['birthday', '<', new Date(2000, 0, 31)],
          ['birthday', '>', new Date(1990, 11, 31)],
        ]),
      ])
      .order(['birthday', 'ASC'])
      .build();
    db.fetch(query).then((results) => {
      expect(results.size).toBe(1);
      expect([...results.values()].map((r) => r.id)).toEqual(['1']);
    });
  });
  it('can filter with greater/less than or equal to dates', async () => {
    const query = db
      .query('students')
      .where([
        and([
          ['birthday', '<=', new Date(2000, 0, 31)],
          ['birthday', '>=', new Date(1990, 11, 31)],
        ]),
      ])
      .order(['birthday', 'ASC'])
      .build();
    db.fetch(query).then((results) => {
      expect(results.size).toBe(3);
      expect([...results.values()].map((r) => r.id)).toEqual(['3', '1', '2']);
    });
  });
});

describe.todo('array operations');

describe('subscriptions', () => {
  let db: DB<any>;
  beforeEach(async () => {
    db = new DB({ source: new InMemoryTupleStorage() });
    const docs = [
      { id: '1', name: 'Alice', major: 'Computer Science', dorm: 'Allen' },
      { id: '2', name: 'Bob', major: 'Biology', dorm: 'Battell' },
      { id: '3', name: 'Charlie', major: 'Computer Science', dorm: 'Battell' },
      { id: '4', name: 'David', major: 'Math', dorm: 'Allen' },
      { id: '5', name: 'Emily', major: 'Biology', dorm: 'Allen' },
    ];
    await Promise.all(docs.map((doc) => db.insert('students', doc)));
  });

  it('handles selection updates', async (done) => {
    const query = db
      .query('students')
      .select(['major'])
      .where([['name', '=', 'Alice']])
      .build();
    await testSubscription(db, query, [
      { check: (data) => expect(data.get('1').major).toBe('Computer Science') },
      {
        action: async () => {
          await db.update('students', 1, async (entity) => {
            entity.major = 'Math';
          });
        },
        check: (data) => expect(data.get('1').major).toBe('Math'),
      },
    ]);
  });

  it('handles data entering query', async () => {
    const query = db
      .query('students')
      .select(['name', 'major'])
      .where([['dorm', '=', 'Battell']])
      .build();
    await testSubscription(db, query, [
      { check: (data) => expect(data.size).toBe(2) },
      {
        action: async () => {
          await db.update('students', '1', async (entity) => {
            entity.dorm = 'Battell';
          });
        },
        check: (data) => expect(data.size).toBe(3),
      },
    ]);
  });

  it('can subscribe to Triples', async () => {
    const query = db
      .query('students')
      .select(['name', 'major'])
      .where([['dorm', '=', 'Battell']])
      .build();
    await testSubscriptionTriples(db, query, [
      { check: (data) => expect(data.length).toBe(10) },
      {
        action: async () => {
          await db.update('students', '1', async (entity) => {
            entity.dorm = 'Battell';
          });
        },
        check: (data) => expect(data.length).toBe(5),
      },
    ]);
  });

  it('handles data leaving query', async () => {
    const query = db
      .query('students')
      .select(['name', 'dorm'])
      .where([['dorm', '=', 'Allen']])
      .build();
    await testSubscription(db, query, [
      {
        check: (data) => expect(data.size).toBe(3),
      },
      {
        action: async () => {
          await db.update('students', '1', async (entity) => {
            entity.dorm = 'Battell';
          });
        },
        check: (data) => expect(data.size).toBe(2),
      },
    ]);
  });

  it('emits triples even when entity is removed from query', async () => {
    const spy = vi.fn();
    const unsubscribe = db.subscribeTriples(
      CollectionQueryBuilder('students')
        .select(['name', 'major'])
        .where([['dorm', '!=', 'Battell']])
        .build(),
      (triples) => {
        spy(triples);
      }
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    await db.update('students', '1', async (entity) => {
      entity.dorm = 'Battell';
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(spy).toHaveBeenCalledTimes(2);

    expect(spy.mock.calls[0][0].length).toBeGreaterThan(0);
    expect(spy.mock.calls[1][0].length).toBeGreaterThan(0);

    await unsubscribe();
  });

  it('data properly backfills with order and limit', async () => {
    const query = db
      .query('students')
      .limit(2)
      .order('major', 'ASC')
      .where([['dorm', '=', 'Allen']])
      .build();

    await testSubscription(db, query, [
      {
        check: (data) => expect(data.size).toBe(2), // initial data
      },
      {
        action: async () => {
          await db.update('students', '1', async (entity) => {
            entity.dorm = 'Battell';
          });
        },
        check: (data) => expect(data.size).toBe(2), // backfills after delete
      },
      {
        action: async () => {
          await db.update('students', '4', async (entity) => {
            entity.dorm = 'Battell';
          });
        },
        check: (data) => expect(data.size).toBe(1), // cant backfill, no more matching data
      },
      {
        action: async () => {
          await db.update('students', '5', async (entity) => {
            entity.dorm = 'Battell';
          });
        },
        check: (data) => expect(data.size).toBe(0), // handles down to zero
      },
    ]);
  });

  it('handles order and limit', async () => {
    // return new Promise<void>(async (resolve, reject) => {
    let i = 0;
    let LIMIT = 2;

    await testSubscription(
      db,
      db.query('students').limit(2).order(['major', 'ASC']).build(),
      [
        {
          check: (data) => {
            expect(data.size).toBe(LIMIT);
            expect([...data.values()].map((r) => r.major)).toEqual([
              'Biology',
              'Biology',
            ]);
          },
        },
        {
          action: async (results) => {
            await db.insert('students', {
              id: '6',
              name: 'Frank',
              major: 'Astronomy',
              dorm: 'Allen',
            });
          },
          check: (data) => {
            expect(data.size).toBe(LIMIT);
            expect([...data.values()].map((r) => r.major)).toEqual([
              'Astronomy',
              'Biology',
            ]);
          },
        },
      ]
    );
  });

  it('maintains order in subscription', async () => {
    const db = new DB({ source: new InMemoryTupleStorage() });
    await testSubscription(
      db,
      db
        .query('students')
        .where([['deleted', '=', false]])
        .order(['age', 'ASC'])
        .build(),
      [
        { check: (data) => expect(Array.from(data.keys())).toEqual([]) },
        {
          action: async () => {
            await db.insert('students', {
              id: '1',
              name: 'Alice',
              age: 30,
              deleted: false,
            });
          },
          check: (data) => expect(Array.from(data.keys())).toEqual(['1']),
        },
        {
          action: async () => {
            await db.insert('students', {
              id: '2',
              name: 'Bob',
              age: 21,
              deleted: false,
            });
          },
          check: (data) => expect(Array.from(data.keys())).toEqual(['2', '1']),
        },
        {
          action: async () => {
            await db.insert('students', {
              id: '3',
              name: 'Charlie',
              age: 35,
              deleted: false,
            });
          },
          check: (data) =>
            expect(Array.from(data.keys())).toEqual(['2', '1', '3']),
        },
        {
          action: async () => {
            await db.insert('students', {
              id: '4',
              name: 'Alice',
              age: 32,
              deleted: false,
            });
          },
          check: (data) =>
            expect(Array.from(data.keys())).toEqual(['2', '1', '4', '3']),
        },
        {
          action: async () => {
            await db.update('students', '4', async (entity) => {
              entity.age = 29;
            });
          },
          check: (data) =>
            expect(Array.from(data.keys())).toEqual(['2', '4', '1', '3']),
        },
        {
          action: async () => {
            await db.update('students', '4', async (entity) => {
              entity.deleted = true;
            });
          },
          check: (data) =>
            expect(Array.from(data.keys())).toEqual(['2', '1', '3']),
        },
        {
          action: async () => {
            await db.update('students', '3', async (entity) => {
              entity.deleted = true;
            });
          },
          check: (data) => expect(Array.from(data.keys())).toEqual(['2', '1']),
        },
        {
          action: async () => {
            await db.update('students', '2', async (entity) => {
              entity.deleted = true;
            });
          },
          check: (data) => expect(Array.from(data.keys())).toEqual(['1']),
        },
        {
          action: async () => {
            await db.update('students', '1', async (entity) => {
              entity.deleted = true;
            });
          },
          check: (data) => expect(Array.from(data.keys())).toEqual([]),
        },
      ]
    );
  });

  it('can subscribe to just triples', async () => {
    const LIMIT = 2;
    await testSubscriptionTriples(
      db,
      db.query('students').limit(2).order(['major', 'ASC']).build(),
      [
        { check: (data) => expect(data.length).toBe(LIMIT * 5) },
        {
          action: async () => {
            await db.insert('students', {
              id: '6',
              name: 'Frank',
              major: 'Astronomy',
              dorm: 'Allen',
            });
          },
          check: (data) => {
            expect(data).toHaveLength(5);
          },
        },
      ]
    );
  });

  // Covers bug in past where subscriptions failed to fire if a transaction contained irrelevant data
  it('can handle multiple subscriptions', async () => {
    const db = new DB();
    const completedTodosQuery = db
      .query('todos')
      .where('completed', '=', true)
      .build();
    const incompleteTodosQuery = db
      .query('todos')
      .where('completed', '=', false)
      .build();

    let completedCalls = 0;
    let completedAssertions = [
      (results: Map<string, any>) => {
        expect(results.size).toBe(0);
      },
      (results: Map<string, any>) => {
        expect(results.size).toBe(1);
        expect(results.get('1')).toBeTruthy();
      },
      (results: Map<string, any>) => {
        expect(results.size).toBe(2);
        expect(results.get('1')).toBeTruthy();
        expect(results.get('3')).toBeTruthy();
      },
    ];
    db.subscribe(completedTodosQuery, (data) => {
      completedAssertions[completedCalls](data);
      completedCalls++;
    });

    let incompleteCalls = 0;
    let incompleteAssertions = [
      (results: Map<string, any>) => {
        expect(results.size).toBe(0);
      },
      (results: Map<string, any>) => {
        expect(results.size).toBe(1);
        expect(results.get('2')).toBeTruthy();
      },
      (results: Map<string, any>) => {
        expect(results.size).toBe(2);
        expect(results.get('2')).toBeTruthy();
        expect(results.get('4')).toBeTruthy();
      },
    ];
    db.subscribe(incompleteTodosQuery, (data) => {
      incompleteAssertions[incompleteCalls](data);
      incompleteCalls++;
    });

    // only subscription A fires
    await new Promise<void>((res) =>
      setTimeout(async () => {
        await db.insert('todos', {
          text: 'Buy milk',
          completed: true,
          id: '1',
        });
        res();
      }, 20)
    );
    // only subscription B fires
    await new Promise<void>((res) =>
      setTimeout(async () => {
        await db.insert('todos', {
          text: 'Buy eggs',
          completed: false,
          id: '2',
        });
        res();
      }, 20)
    );

    // Both fire
    await new Promise<void>((res) =>
      setTimeout(async () => {
        await db.transact(async (tx) => {
          await tx.insert('todos', {
            text: 'Buy bread',
            completed: true,
            id: '3',
          });
          await tx.insert('todos', {
            text: 'Buy butter',
            completed: false,
            id: '4',
          });
        });
        res();
      }, 20)
    );

    await new Promise<void>((res) => setTimeout(res, 20));
    expect(completedCalls).toEqual(3);
    expect(incompleteCalls).toEqual(3);
  });
});

describe("Entity Id'ing", () => {
  describe('schemaless', () => {
    it('can insert an entity with an id attribute and retrieve it using the same id', async () => {
      const db = new DB();
      const id = 'myId';
      const entity = { id, name: 'Alice' };
      await db.insert('students', entity);
      const result = await db.fetchById('students', id);
      expect(result).toMatchObject(entity);
    });
    it('can insert an entity without an id attribute and have it generated', async () => {
      const db = new DB();
      const entityDoc = { name: 'Alice' };
      await db.insert('students', entityDoc);
      const result = await db.fetchOne(db.query('students').build());
      expect(result).not.toBeNull();
      expect(result.id).toBeDefined();
    });
  });

  describe('with schema', () => {
    it('can define a schema with a required id attribute and fail if its not provided', async () => {
      const db = new DB({
        schema: {
          collections: {
            students: {
              schema: S.Schema({
                id: S.String({ nullable: false }),
                name: S.String(),
              }),
            },
          },
        },
      });
      const entityDoc = { name: 'Alice' };
      await expect(db.insert('students', entityDoc)).rejects.toThrow();
    });

    it('can define a schema with an auto generated id attribute and have it generated', async () => {
      const db = new DB({
        schema: {
          collections: {
            students: {
              schema: S.Schema({
                id: S.String({ default: { func: 'uuid' } }),
                name: S.String(),
              }),
            },
          },
        },
      });
      const entityDoc = { name: 'Alice' };
      await db.insert('students', entityDoc);
      const entity = await db.fetchOne(db.query('students').build());
      expect(entity).not.toBeNull();
      expect(entity.id).toBeDefined();
    });
  });

  it.todo("prevent's updating ID's on entities");
});

describe('single entity subscriptions', async () => {
  const storage = new InMemoryTupleStorage();
  const db = new DB({
    source: storage,
    schema: {
      collections: {
        students: {
          schema: S.Schema({
            id: S.String(),
            name: S.String(),
            major: S.String(),
            dorm: S.String(),
          }),
        },
      },
    },
  });
  const defaultData = [
    { id: '1', name: 'Alice', major: 'Computer Science', dorm: 'Allen' },
    { id: '2', name: 'Bob', major: 'Biology', dorm: 'Battell' },
    { id: '3', name: 'Charlie', major: 'Computer Science', dorm: 'Battell' },
    { id: '4', name: 'David', major: 'Math', dorm: 'Allen' },
    { id: '5', name: 'Emily', major: 'Biology', dorm: 'Allen' },
  ];
  beforeEach(async () => {
    await db.clear();
  });
  // 3) update other entities and not have it fire

  it('can subscribe to an entity', async () => {
    await Promise.all(defaultData.map((doc) => db.insert('students', doc)));
    await testSubscription(db, db.query('students').entityId('3').build(), [
      {
        check: (results) => {
          const entity = results.get('3');
          expect(entity).toBeDefined();
          expect(results.size).toBe(1);
          expect(entity.id).toBe('3');
        },
      },
      {
        action: async (results) => {
          await db.transact(async (tx) => {
            await tx.update('students', '3', async (entity) => {
              entity.major = 'sociology';
            });
          });
        },
        check: (results) => {
          expect(results.get('3').major).toBe('sociology');
        },
      },
    ]);
  });
  it("can should return nothing if the entity doesn't exist, and then update when it is inserted and deleted", async () => {
    await Promise.all(defaultData.map((doc) => db.insert('students', doc)));
    await testSubscription(db, db.query('students').entityId('6').build(), [
      {
        check: (results) => {
          const entity = results.get('6');
          expect(entity).not.toBeDefined();
          expect(results.size).toBe(0);
        },
      },
      {
        action: async (results) => {
          await db.transact(async (tx) => {
            await tx.insert('students', {
              id: '6',
              name: 'Helen',
              major: 'Virtual Reality',
              dorm: 'Painter',
            });
          });
        },
        check: (results) => {
          const entity = results.get('6');
          expect(entity).toBeDefined();
          expect(results.size).toBe(1);
          expect(entity.id).toBe('6');
        },
      },
      {
        action: async () => {
          const allTriples = await db.tripleStore.findByEntity();
          await db.tripleStore.deleteTriples(allTriples);
        },
        check: async (results) => {
          const entity = results.get('6');
          expect(entity).not.toBeDefined();
        },
      },
    ]);
  });
  it('should only fire updates when the entity in question is affected', async () => {
    await Promise.all(defaultData.map((doc) => db.insert('students', doc)));
    await new Promise<void>(async (resolve) => {
      const spy = vi.fn();
      db.subscribe(db.query('students').entityId('3').build(), spy);
      setTimeout(() => {
        expect(spy).toHaveBeenCalledOnce();
        resolve();
      }, 50);
    });
    await new Promise<void>(async (resolve) => {
      const spy = vi.fn();
      db.subscribe(db.query('students').entityId('3').build(), spy);
      await db.transact(async (tx) => {
        await tx.update('students', '1', async (entity) => {
          entity.major = 'sociology';
        });
      });
      await db.transact(async (tx) => {
        await tx.update('students', '2', async (entity) => {
          entity.major = 'sociology';
        });
      });
      setTimeout(() => {
        expect(spy).toHaveBeenCalledOnce();
        resolve();
      }, 50);
    });
    await new Promise<void>(async (resolve) => {
      const spy = vi.fn();
      db.subscribe(db.query('students').entityId('3').build(), spy);
      await db.transact(async (tx) => {
        await tx.update('students', '1', async (entity) => {
          entity.major = 'sociology';
        });
      });
      await db.transact(async (tx) => {
        await tx.update('students', '3', async (entity) => {
          entity.major = 'sociology';
        });
      });
      setTimeout(() => {
        expect(spy).toHaveBeenCalledTimes(2);
        resolve();
      }, 50);
    });
  });
});

describe('delete api', () => {
  it('can delete an entity', async () => {
    const db = new DB();
    await db.insert('posts', { id: 'post-1', author_id: 'user-1' });
    {
      const post = await db.fetchById('posts', 'post-1');
      expect(post).toStrictEqual({
        id: 'post-1',
        author_id: 'user-1',
      });
    }
    await db.delete('posts', 'post-1');
    {
      const post = await db.fetchById('posts', 'post-1');
      expect(post).toBeNull();
    }
  });
  it('in a transaction, delete an entity and then insert the same one', async () => {
    const db = new DB();
    await db.insert('posts', { id: 'post-1', author_id: 'user-1' });
    await db.transact(async (tx) => {
      await tx.delete('posts', 'post-1');
      await tx.insert('posts', { id: 'post-1', author_id: 'user-1' });
    });
    const post = await db.fetchById('posts', 'post-1');
    expect(post).toStrictEqual({
      id: 'post-1',
      author_id: 'user-1',
    });
  });

  it('in a transaction, delete an entity and then update the same one', async () => {
    const db = new DB();
    await db.insert('posts', { id: 'post-1', author_id: 'user-1' });
    await db.transact(async (tx) => {
      await tx.delete('posts', 'post-1');
      expect(
        tx.update('posts', 'post-1', (entity) => {
          entity.author_id = 'user-2';
        })
      ).rejects.toThrowError(EntityNotFoundError);
    });
  });
  it('prevents deletes triples from returning when same Entity ID is reused after deleting', async () => {
    const db = new DB();
    // insert a post, delete it, and then insert a new post with the same id but different attribute
    await db.insert('posts', { id: 'post-1', author_id: 'user-1' });
    await db.delete('posts', 'post-1');
    await db.insert('posts', { id: 'post-1', title: 'user-2' });
    const result = await db.fetchById('posts', 'post-1');
    expect(result).not.toHaveProperty('author_id');
    expect(result).toStrictEqual({ id: 'post-1', title: 'user-2' });
  });
  it('tx: can reinsert, delete an entity and then insert the same one without polluting triples', async () => {
    const db = new DB();
    await db.transact(async (tx) => {
      await db.insert('posts', { id: 'post-1', author_id: 'user-1' });
      await db.delete('posts', 'post-1');
      await db.insert('posts', { id: 'post-1', title: 'user-2' });
      const result = await db.fetchById('posts', 'post-1');
      expect(result).not.toHaveProperty('author_id');
      expect(result).toStrictEqual({ id: 'post-1', title: 'user-2' });
    });
  });
});

// the onWrite hook for a subscription runs on EVERY transaction (even if its not relevant), should test subscritions can handle irrelevant transactions
it('safely handles multiple subscriptions', async () => {
  // Should error out if there is a problem (couldnt quite get an assertion that it errors out to work)
  const db = new DB({ source: new InMemoryTupleStorage() });
  const query1 = db
    .query('students')
    .where([['major', '=', 'Computer Science']])
    .order(['name', 'ASC'])
    .limit(2)
    .build();
  const query2 = db
    .query('bands')
    .where([['genre', '=', 'Rock']])
    .order(['founded', 'ASC'])
    .limit(2)
    .build();
  db.subscribe(query1, () => {});
  db.subscribe(query2, () => {});
  await db.insert('students', { name: 'Alice', major: 'Computer Science' });
  await db.insert('students', { name: 'Bill', major: 'Biology' });
  await db.insert('students', { name: 'Cam', major: 'Computer Science' });

  await db.insert('bands', {
    name: 'The Beatles',
    genre: 'Rock',
    founded: 1960,
  });
  await db.insert('bands', { name: 'NWA', genre: 'Hip Hop', founded: 1986 });
  await db.insert('bands', { name: 'The Who', genre: 'Rock', founded: 1964 });
});

const TEST_SCORES = [
  {
    score: 80,
    date: '2023-04-16',
  },
  {
    score: 76,
    date: '2023-03-06',
  },
  {
    score: 95,
    date: '2023-04-20',
  },
  {
    score: 87,
    date: '2023-04-21',
  },
  {
    score: 75,
    date: '2023-04-09',
  },
  {
    score: 70,
    date: '2023-05-28',
  },
  {
    score: 80,
    date: '2023-03-16',
  },
  {
    score: 78,
    date: '2023-05-01',
  },
  {
    score: 70,
    date: '2023-04-23',
  },
  {
    score: 76,
    date: '2023-04-06',
  },
  {
    score: 99,
    date: '2023-03-24',
  },
  {
    score: 73,
    date: '2023-03-13',
  },
  {
    score: 87,
    date: '2023-04-12',
  },
  {
    score: 99,
    date: '2023-03-17',
  },
  {
    score: 87,
    date: '2023-04-24',
  },
  {
    score: 96,
    date: '2023-03-26',
  },
  {
    score: 91,
    date: '2023-05-07',
  },
  {
    score: 75,
    date: '2023-04-17',
  },
  {
    score: 98,
    date: '2023-05-28',
  },
  {
    score: 96,
    date: '2023-05-24',
  },
];

describe('ORDER & LIMIT & Pagination', () => {
  const db = new DB({
    source: storage,
    schema: {
      collections: {
        TestScores: {
          schema: S.Schema({
            id: S.Id(),
            score: S.Number(),
            date: S.String(),
          }),
        },
      },
    },
  });
  beforeEach(async () => {
    storage.wipe();
    for (const result of TEST_SCORES) {
      await db.insert('TestScores', result);
    }
  });

  it('order by DESC', async () => {
    const descendingScoresResults = await db.fetch(
      CollectionQueryBuilder('TestScores').order(['score', 'DESC']).build()
    );
    expect(descendingScoresResults.size).toBe(TEST_SCORES.length);
    const areAllScoresDescending = Array.from(
      descendingScoresResults.values()
    ).every((result, i, arr) => {
      if (i === 0) return true;
      const previousScore = arr[i - 1].score;
      const currentScore = result.score;
      return previousScore >= currentScore;
    });
    expect(areAllScoresDescending).toBeTruthy();
  });

  it('order by ASC', async () => {
    const descendingScoresResults = await db.fetch(
      CollectionQueryBuilder('TestScores').order(['score', 'ASC']).build()
    );
    expect(descendingScoresResults.size).toBe(TEST_SCORES.length);
    const areAllScoresDescending = Array.from(
      descendingScoresResults.values()
    ).every((result, i, arr) => {
      if (i === 0) return true;
      const previousScore = arr[i - 1].score;
      const currentScore = result.score;
      return previousScore <= currentScore;
    });
    expect(areAllScoresDescending).toBeTruthy();
  });

  it('order by deep properties', async () => {
    const db = new DB({
      schema: {
        collections: {
          test: {
            schema: S.Schema({
              id: S.Id(),
              deep: S.Record({
                deeper: S.Record({
                  deepest: S.Record({
                    prop: S.Number(),
                  }),
                }),
                prop: S.Number(),
              }),
            }),
          },
        },
      },
    });
    await db.insert('test', {
      id: '1',
      deep: {
        deeper: {
          deepest: {
            prop: 400,
          },
        },
        prop: 299,
      },
    });
    await db.insert('test', {
      id: '2',
      deep: {
        deeper: {
          deepest: {
            prop: 399,
          },
        },
        prop: 300,
      },
    });
    await db.insert('test', {
      id: '3',
      deep: {
        deeper: {
          deepest: {
            prop: 401,
          },
        },
        prop: 301,
      },
    });

    {
      const resultsASC = await db.fetch(
        db.query('test').order(['deep.deeper.deepest.prop', 'ASC']).build()
      );
      const resultsDESC = await db.fetch(
        db.query('test').order(['deep.deeper.deepest.prop', 'DESC']).build()
      );
      expect([...resultsASC.keys()]).toEqual(['2', '1', '3']);
      expect([...resultsDESC.keys()]).toEqual(['3', '1', '2']);
    }
    {
      const resultsASC = await db.fetch(
        db.query('test').order(['deep.prop', 'ASC']).build()
      );
      const resultsDESC = await db.fetch(
        db.query('test').order(['deep.prop', 'DESC']).build()
      );
      expect([...resultsASC.keys()]).toEqual(['1', '2', '3']);
      expect([...resultsDESC.keys()]).toEqual(['3', '2', '1']);
    }
  });
  it('order by multiple properties', async () => {
    const descendingScoresResults = await db.fetch(
      db.query('TestScores').order(['score', 'ASC'], ['date', 'DESC']).build()
    );
    expect(descendingScoresResults.size).toBe(TEST_SCORES.length);
    const areAllScoresDescending = Array.from(
      descendingScoresResults.values()
    ).every((result, i, arr) => {
      if (i === 0) return true;
      const previous = arr[i - 1];
      const current = result;
      const hasCorrectOrder =
        previous.score < current.score ||
        (previous.score === current.score && previous.date >= current.date);
      return hasCorrectOrder;
    });
    expect(areAllScoresDescending).toBeTruthy();
  });

  // Note: builder unit test + test above make this test a little repetitive
  it('order by multiple properties (additive)', async () => {
    const descendingScoresResults = await db.fetch(
      db
        .query('TestScores')
        .order(['score', 'ASC'])
        .order('date', 'DESC')
        .build()
    );
    expect(descendingScoresResults.size).toBe(TEST_SCORES.length);
    const areAllScoresDescending = Array.from(
      descendingScoresResults.values()
    ).every((result, i, arr) => {
      if (i === 0) return true;
      const previous = arr[i - 1];
      const current = result;
      const hasCorrectOrder =
        previous.score < current.score ||
        (previous.score === current.score && previous.date >= current.date);
      return hasCorrectOrder;
    });
    expect(areAllScoresDescending).toBeTruthy();
  });

  it('limit', async () => {
    const descendingScoresResults = await db.fetch(
      CollectionQueryBuilder('TestScores')
        .order(['score', 'DESC'])
        .limit(5)
        .build()
    );
    expect(descendingScoresResults.size).toBe(5);
    const areAllScoresDescending = Array.from(
      descendingScoresResults.values()
    ).every((result, i, arr) => {
      if (i === 0) return true;
      const previousScore = arr[i - 1].score;
      const currentScore = result.score;
      return previousScore >= currentScore;
    });
    expect(areAllScoresDescending).toBeTruthy();
  });

  it('can paginate DESC', async () => {
    const firstPageResults = await db.fetch(
      CollectionQueryBuilder('TestScores')
        .order(['score', 'DESC'])
        .limit(5)
        .build()
    );
    expect([...firstPageResults.values()].map((r) => r.score)).toEqual([
      99, 99, 98, 96, 96,
    ]);

    const lastDoc = [...firstPageResults.entries()][4];

    const secondPageResults = await db.fetch(
      CollectionQueryBuilder('TestScores')
        .order(['score', 'DESC'])
        .limit(5)
        .after([lastDoc[1].score, lastDoc[0]])
        .build()
    );

    expect([...secondPageResults.values()].map((r) => r.score)).toEqual([
      95, 91, 87, 87, 87,
    ]);
  });

  it('can paginate ASC', async () => {
    const firstPageResults = await db.fetch(
      CollectionQueryBuilder('TestScores')
        .order(['score', 'ASC'])
        .limit(5)
        .build()
    );
    expect([...firstPageResults.values()].map((r) => r.score)).toEqual([
      70, 70, 73, 75, 75,
    ]);

    const lastDoc = [...firstPageResults.entries()][4];

    const secondPageResults = await db.fetch(
      CollectionQueryBuilder('TestScores')
        .order(['score', 'ASC'])
        .limit(5)
        .after([lastDoc[1].score, lastDoc[0]])
        .build()
    );
    expect([...secondPageResults.values()].map((r) => r.score)).toEqual([
      76, 76, 78, 80, 80,
    ]);
  });
  it('can pull in more results to satisfy limit in subscription when current result no longer satisfies FILTER', async () => {
    const LIMIT = 5;

    await testSubscription(
      db,
      db
        .query('TestScores')
        .where([['score', '>', 10]])
        .order(['score', 'DESC'], ['date', 'DESC'])
        .limit(LIMIT)
        .build(),
      [
        {
          check: (results) => {
            expect(results).toHaveLength(LIMIT);
          },
        },
        {
          action: async (results) => {
            const idFromResults = [...results.keys()][0];
            await db.transact(async (tx) => {
              await tx.update('TestScores', idFromResults, async (entity) => {
                entity.score = 0;
              });
            });
          },
          check: (results) => {
            expect(results.size).toBe(LIMIT);
            expect(
              [...results.values()].map((result) => result.score).includes(0)
            ).toBeFalsy();
          },
        },
        {
          action: async (results) => {
            const firstResult = [...results][0];
            await db.transact(async (tx) => {
              await tx.update('TestScores', firstResult[0], async (entity) => {
                entity.score = firstResult[1].score + 1;
              });
            });
          },
          check: (results) => {
            expect(results).toHaveLength(LIMIT);
            expect(
              [...results.values()].every((result, i, resultValues) => {
                if (i === 0) return true;
                const previous = resultValues[i - 1];
                const current = result;
                const hasCorrectOrder =
                  previous.score > current.score ||
                  (previous.score === current.score &&
                    previous.date >= current.date);
                return hasCorrectOrder;
              })
            ).toBeTruthy();
          },
        },
      ]
    );
  });

  it('can pull in more results to satisfy limit in subscription when current result no longer satisfies ORDER', async () => {
    const LIMIT = 5;

    await testSubscription(
      db,
      db
        .query('TestScores')
        .order(['score', 'DESC'], ['date', 'DESC'])
        .limit(LIMIT)
        .build(),
      [
        {
          check: (results) => {
            expect(results.size).toBe(LIMIT);
          },
        },
        {
          action: async (results) => {
            const idFromResults = [...results.keys()][0];
            await db.transact(async (tx) => {
              await tx.update('TestScores', idFromResults, async (entity) => {
                entity.score = 0;
              });
            });
          },
          check: (results) => {
            expect(results.size).toBe(LIMIT);
            expect(
              [...results.values()].map((result) => result.score).includes(0)
            ).toBeFalsy();
          },
        },
      ]
    );
  });

  it('limit ignores deleted entities', async () => {
    const db = new DB();
    await db.insert('test', { id: '1', name: 'alice' });
    await db.insert('test', { id: '4', name: 'david' });
    await db.insert('test', { id: '3', name: 'charlie' });
    await db.insert('test', { id: '5', name: 'eve' });
    await db.insert('test', { id: '2', name: 'bob' });

    await db.delete('test', '3');

    const query = db.query('test').order(['name', 'ASC']).limit(3).build();
    const result = await db.fetch(query);
    expect(result.size).toBe(3);
    expect([...result.keys()]).toEqual(['1', '2', '4']);
  });

  it('can handle secondary sorts on values with runs of equal primary values', async () => {
    const db = new DB();
    for (let i = 0; i < 20; i++) {
      await db.insert(
        'cars',
        {
          year: 2000 + i,
          make: 'Volvo',
        },
        i.toString()
      );
    }

    const results = await db.fetch(
      db.query('cars').order(['make', 'ASC'], ['year', 'DESC']).limit(5).build()
    );

    expect(results).toHaveLength(5);
    expect([...results.values()].map((r) => r.year)).toEqual([
      2019, 2018, 2017, 2016, 2015,
    ]);
  });
});

describe.each(['ASC', 'DESC'])('pagination stress test: %s', (sortOrder) => {
  const schema = {
    collections: {
      students: {
        schema: S.Schema({
          id: S.String(),
          name: S.String(),
          graduated: S.Boolean(),
          expected_graduation_date: S.Date(),
        }),
      },
    },
  };

  const PAGE_SIZE = 2;
  const entities = [
    {
      id: '5',
      name: 'Bob',
      graduated: false,
      expected_graduation_date: new Date('2023-04-16'),
    },
    {
      id: '3',
      name: 'Alice',
      graduated: false,
      expected_graduation_date: new Date('2022-01-02'),
    },
    {
      id: '2',
      name: 'David',
      graduated: false,
      expected_graduation_date: new Date('2021-05-02'),
    },
    {
      id: '1',
      name: 'Charlie',
      graduated: true,
      expected_graduation_date: new Date('2021-05-10'),
    },
    {
      id: '4',
      name: 'Emily',
      graduated: true,
      expected_graduation_date: new Date('2026-05-02'),
    },
  ];
  it.each(
    Object.keys(schema.collections.students.schema.properties).map((prop) => ({
      prop,
      type: schema.collections.students.schema.properties[prop].type,
    }))
  )('can sort and paginate by $prop ($type)', async ({ prop }) => {
    const db = new DB({
      schema,
      source: new InMemoryTupleStorage(),
    });
    await Promise.all(entities.map((doc) => db.insert('students', doc)));
    const correctOrder = entities
      .sort((a, b) => {
        if (a[prop] < b[prop]) return sortOrder === 'ASC' ? -1 : 1;
        if (a[prop] > b[prop]) return sortOrder === 'ASC' ? 1 : -1;
        return 0;
      })
      .map((e) => e[prop]);
    const correctPages = [];
    for (let i = 0; i < correctOrder.length; i += PAGE_SIZE) {
      correctPages.push(correctOrder.slice(i, i + PAGE_SIZE));
    }
    let lastEntity: (typeof entities)[number] | undefined = undefined;
    for (let i = 0; i < correctPages.length; i++) {
      const results = await db.fetch(
        db
          .query('students')
          .order([prop, sortOrder])
          .limit(PAGE_SIZE)
          .after(lastEntity)
          .build()
      );
      lastEntity = Array.from(
        results.values()
      ).pop() as (typeof entities)[number];

      expect(Array.from(results.values()).map((e) => e[prop])).toEqual(
        correctPages[i]
      );
    }
  });
});

describe('database transactions', () => {
  // beforeEach(() => {
  //   storage.data = [];
  // });
  it('can implicitly commit a transaction', async () => {
    const db = new DB({
      source: new InMemoryTupleStorage(),
      schema: {
        collections: {
          TestScores: {
            schema: S.Schema({
              id: S.String({ default: { func: 'uuid' } }),
              score: S.Number(),
              date: S.String(),
            }),
          },
        },
      },
    });
    await db.transact(async (tx) => {
      await tx.insert('TestScores', {
        score: 80,
        date: '2023-04-16',
      });
      expect(
        (await db.fetch(CollectionQueryBuilder('TestScores').build())).size
      ).toBe(0);
      expect(
        (await tx.fetch(CollectionQueryBuilder('TestScores').build())).size
      ).toBe(1);
    });
    expect(
      (await db.fetch(CollectionQueryBuilder('TestScores').build())).size
    ).toBe(1);
    // expect(() => tx.collection('TestScores').query().fetch()).toThrowError();
  });
  it('can rollback an insert transaction', async () => {
    const db = new DB({
      source: new InMemoryTupleStorage(),
      schema: {
        collections: {
          TestScores: {
            schema: S.Schema({
              id: S.String({ default: { func: 'uuid' } }),
              score: S.Number(),
              date: S.String(),
            }),
          },
        },
      },
    });
    await db.transact(async (tx) => {
      await tx.insert('TestScores', {
        score: 80,
        date: '2023-04-16',
      });
      expect(
        (await db.fetch(CollectionQueryBuilder('TestScores').build())).size
      ).toBe(0);
      expect(
        (await tx.fetch(CollectionQueryBuilder('TestScores').build())).size
      ).toBe(1);
      await tx.cancel();
    });
    expect(
      (await db.fetch(CollectionQueryBuilder('TestScores').build())).size
    ).toBe(0);
    // expect(() => tx.collection('TestScores').query().fetch()).toThrowError();
  });
  it('can rollback an update transaction', async () => {
    const db = new DB({
      source: new InMemoryTupleStorage(),
      schema: {
        collections: {
          TestScores: {
            schema: S.Schema({
              id: S.String(),
              score: S.Number(),
              date: S.String(),
            }),
          },
        },
      },
    });
    const DOC_ID = 'my-score';
    await db.insert('TestScores', {
      score: 80,
      date: '2023-04-16',
      id: DOC_ID,
    });
    await db.transact(async (tx) => {
      await tx.update('TestScores', DOC_ID, async (entity) => {
        entity.score = 999;
      });
      expect((await db.fetchById('TestScores', DOC_ID))?.score).toBe(80);
      expect((await tx.fetchById('TestScores', DOC_ID))?.score).toBe(999);
      await tx.cancel();
    });
    expect((await db.fetchById('TestScores', DOC_ID))?.score).toBe(80);
  });
  it("can't commit inside the transaction callback", async () => {
    const db = new DB({});
    expect(
      db.transact(async (tx) => {
        tx.commit();
      })
    ).rejects.toThrowError();
  });
  it('can fetch by id in a transaction', async () => {
    const db = new DB({});
    await db.transact(async (tx) => {
      await tx.insert('TestScores', {
        score: 80,
        date: '2023-04-16',
        id: '1',
      });
      const result = await tx.fetchById('TestScores', '1');
      expect(result.score).toBe(80);
    });
    expect((await db.fetchById('TestScores', '1'))?.score).toBe(80);
  });
  it('can update an entity in a transaction', async () => {
    const db = new DB({
      schema: {
        collections: {
          TestScores: {
            schema: S.Schema({
              id: S.String({ default: { func: 'uuid' } }),
              score: S.Number(),
              date: S.String(),
            }),
          },
        },
      },
    });
    await db.insert('TestScores', {
      id: 'score-1',
      score: 80,
      date: '2023-04-16',
    });
    await db.transact(async (tx) => {
      expect((await db.fetchById('TestScores', 'score-1'))!.score).toBe(80);
      await tx.update('TestScores', 'score-1', async (entity) => {
        entity.score = 100;
      });
      expect((await tx.fetchById('TestScores', 'score-1'))!.score).toBe(100);
    });
    expect((await db.fetchById('TestScores', 'score-1'))!.score).toBe(100);
  });
  it('awaits firing subscription until transaction is committed', async () => {
    const db = new DB({
      source: new InMemoryTupleStorage(),
      schema: {
        collections: {
          TestScores: {
            schema: S.Schema({
              id: S.String({ default: { func: 'uuid' } }),
              score: S.Number(),
              date: S.String(),
            }),
          },
        },
      },
    });
    // Adding this check to ensure the onInsert isn't called with schema/metadata triples
    await db.ensureMigrated;
    const insertSpy = vi.fn();
    db.tripleStore.onInsert(insertSpy);
    await db.transact(async (tx) => {
      await tx.insert('TestScores', {
        score: 80,
        date: '2023-04-16',
      });
      await tx.insert('TestScores', {
        score: 90,
        date: '2023-04-17',
      });
      expect(insertSpy).not.toHaveBeenCalled();
    });
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it('can delete and set the same attribute within a transaction', async () => {
    // set then delete
    {
      const db = new DB();
      await db.insert('test', {
        id: '1',
      });

      await db.transact(async (tx) => {
        await tx.update('test', '1', async (entity) => {
          entity.attr = {
            test: 'obj',
          };
        });
        await tx.update('test', '1', async (entity) => {
          delete entity['attr'];
        });
      });
      const result = await db.fetchById('test', '1');
      expect(result.attr).toBeUndefined();
    }

    // delete then set
    {
      const db = new DB();
      await db.insert('test', {
        id: '1',
        attr: 'foo',
      });

      await db.transact(async (tx) => {
        await tx.update('test', '1', async (entity) => {
          delete entity['attr'];
        });
        await tx.update('test', '1', async (entity) => {
          entity.attr = {
            test: 'obj',
          };
        });
      });
      const result = await db.fetchById('test', '1');
      expect(result.attr).toStrictEqual({ test: 'obj' });
    }
  });
});

describe('schema changes', async () => {
  describe('createCollection', () => {
    it('can create a collection definition', async () => {
      const db = new DB();
      await db.createCollection({
        name: 'students',
        schema: {
          id: { type: 'number', options: {} },
          name: { type: 'string', options: {} },
        },
      });
      const schema = await db.getSchema();
      expect(schema?.collections).toHaveProperty('students');
      expect(schema?.collections.students.schema.properties).toHaveProperty(
        'id'
      );
      expect(schema?.collections.students.schema.properties).toHaveProperty(
        'name'
      );
    });

    it('can add a collection and observe changes in a transaction', async () => {
      const db = new DB();
      let txSchema;
      await db.transact(async (tx) => {
        expect(tx.schema).toBeUndefined();
        const newCollection = {
          name: 'students',
          schema: {
            id: { type: 'number', options: {} },
            name: { type: 'string', options: {} },
          },
        };
        await tx.createCollection(newCollection);
        txSchema = tx.schema;
        expect(tx.schema).not.toBeUndefined();
        expect(tx.schema).toHaveProperty('collections');
        expect(tx.schema?.collections).toHaveProperty(newCollection.name);
      });
      expect(schemaToJSON((await db.getSchema())!)).toEqual(
        schemaToJSON(txSchema)
      );
    });

    it('can create a collection with rules', async () => {
      await testDBAndTransaction(
        () =>
          new DB({
            source: new InMemoryTupleStorage(),
          }),
        async (db) => {
          await db.createCollection({
            name: 'students',
            schema: {
              id: { type: 'number', options: {} },
              name: { type: 'string', options: {} },
            },
            rules: {
              read: {
                'only-read-self': {
                  filter: [['id', '=', '$SESSION_USER_ID']],
                  description: 'Can only read your own student record',
                },
              },
            },
          });
          const dbSchema = await db.getSchema();
          expect(
            Object.keys(dbSchema?.collections.students.rules?.read!)
          ).toHaveLength(1);
          const rule =
            dbSchema?.collections.students.rules?.read!['only-read-self']!;
          expect(rule.filter).toEqual([['id', '=', '$SESSION_USER_ID']]);
          expect(rule.description).toEqual(
            'Can only read your own student record'
          );
        }
      );
    });
  });

  describe('dropCollection', () => {
    it('can drop a collection definition from the schema', async () => {
      const schema = {
        collections: {
          students: {
            schema: S.Schema({
              id: S.String(),
              name: S.String(),
            }),
          },
        },
      };
      const db = new DB({ schema: schema });
      const dbSchemaBefore = await db.getSchema();
      expect(dbSchemaBefore?.collections).toHaveProperty('students');
      await db.dropCollection({ name: 'students' });
      const dbSchemaAfter = await db.getSchema();
      expect(dbSchemaAfter?.collections).not.toHaveProperty('students');

      // TODO: test data is actually dropped if we decide it should be
    });
  });

  describe('addAttribute', () => {
    const defaultSchema = {
      collections: {
        students: {
          schema: S.Schema({
            id: S.String(),
            name: S.String(),
            address: S.Record({
              street: S.String(),
            }),
          }),
        },
      },
    };

    it('can add an attribute', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.addAttribute({
            collection: 'students',
            path: ['age'],
            attribute: { type: 'number', options: {} },
          });
          const dbSchema = await db.getSchema();
          expect(dbSchema?.collections).toHaveProperty('students');
          expect(
            dbSchema?.collections.students.schema.properties
          ).toHaveProperty('age');
          expect(
            dbSchema?.collections.students.schema.properties
          ).toHaveProperty('name');
        }
      );
    });

    it('can add an optional attribute', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.addAttribute({
            collection: 'students',
            path: ['age'],
            attribute: { type: 'number', options: {} },
            optional: true,
          });
          const dbSchema = await db.getSchema();
          expect(dbSchema?.collections).toHaveProperty('students');
          expect(
            dbSchema?.collections.students.schema.properties
          ).toHaveProperty('age');
          expect(
            dbSchema?.collections.students.schema.optional?.includes('age')
          ).toBe(true);
        }
      );
    });

    it('can add a nested attribute', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.addAttribute({
            collection: 'students',
            path: ['address', 'state'],
            attribute: { type: 'string', options: {} },
          });
          const dbSchema = await db.getSchema();
          expect(dbSchema?.collections).toHaveProperty('students');
          expect(
            dbSchema?.collections.students.schema.properties
          ).toHaveProperty('address');
          expect(
            dbSchema?.collections.students.schema.properties.address.properties
          ).toHaveProperty('state');
        }
      );
    });

    it('addAttribute throws if the collection doesnt exist', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await expect(
            db.addAttribute({
              collection: 'todos',
              path: ['text'],
              attribute: { type: 'string', options: {} },
            })
          ).rejects.toThrowError(CollectionNotFoundError);
        }
      );
    });

    it('addAttribute throws if the path is not valid', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await expect(
            db.addAttribute({
              collection: 'students',
              path: [],
              attribute: { type: 'string', options: {} },
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
          await expect(
            db.addAttribute({
              collection: 'students',
              path: ['addresss', 'state'],
              attribute: { type: 'string', options: {} },
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
        }
      );
    });

    it('addAttribute is idempoent', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.addAttribute({
            collection: 'students',
            path: ['age'],
            attribute: { type: 'number', options: {} },
          });
          const hash1 = hashSchemaJSON(
            schemaToJSON(await db.getSchema())?.collections
          );
          await db.addAttribute({
            collection: 'students',
            path: ['age'],
            attribute: { type: 'number', options: {} },
          });
          const dbSchema = await db.getSchema();
          expect(dbSchema?.collections).toHaveProperty('students');
          expect(
            dbSchema?.collections.students.schema.properties
          ).toHaveProperty('age');
          const hash2 = hashSchemaJSON(schemaToJSON(dbSchema)?.collections);

          expect(hash1).toBe(hash2);
        }
      );
    });
  });

  describe('dropAttribute', () => {
    const defaultSchema = {
      collections: {
        students: {
          schema: S.Schema({
            id: S.String(),
            name: S.String(),
            age: S.String(),
            address: S.Record({
              street: S.String(),
              state: S.String(),
            }),
          }),
        },
      },
    };

    it('can drop an attribute', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.dropAttribute({ collection: 'students', path: ['age'] });
          const dbSchema = await db.getSchema();
          expect(dbSchema?.collections).toHaveProperty('students');
          expect(
            dbSchema?.collections.students.schema.properties
          ).not.toHaveProperty('age');
          expect(
            dbSchema?.collections.students.schema.properties
          ).toHaveProperty('name');
        }
      );
    });

    it('Dropping an optional attribute cleans up data', async () => {
      const db = new DB({
        schema: {
          collections: {
            students: {
              schema: S.Schema({
                id: S.String(),
                name: S.String(),
                age: S.Optional(S.Number()),
              }),
            },
          },
        },
      });
      await db.dropAttribute({ collection: 'students', path: ['age'] });
      const dbSchema = await db.getSchema();

      expect(
        dbSchema?.collections.students.schema.properties
      ).not.toHaveProperty('age');
      expect(dbSchema?.collections.students.schema.optional).not.toContain(
        'age'
      );
    });

    it('can drop a nested attribute', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.dropAttribute({
            collection: 'students',
            path: ['address', 'state'],
          });
          const dbSchema = await db.getSchema();
          expect(dbSchema?.collections).toHaveProperty('students');
          expect(
            dbSchema?.collections.students.schema.properties
          ).toHaveProperty('address');
          expect(
            dbSchema?.collections.students.schema.properties.address.properties
          ).not.toHaveProperty('state');
        }
      );
    });

    it('dropAttribute throws if the collection doesnt exist', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await expect(
            db.dropAttribute({
              collection: 'todos',
              path: ['text'],
            })
          ).rejects.toThrowError(CollectionNotFoundError);
        }
      );
    });

    it('dropAttribute throws if the path is not valid', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await expect(
            db.dropAttribute({
              collection: 'students',
              path: [],
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
          await expect(
            db.dropAttribute({
              collection: 'students',
              path: ['addresss', 'state'],
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
        }
      );
    });

    it('dropAttribute is idempoent', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.dropAttribute({ collection: 'students', path: ['age'] });
          const hash1 = hashSchemaJSON(
            schemaToJSON(await db.getSchema())?.collections
          );
          await db.dropAttribute({ collection: 'students', path: ['age'] });
          const dbSchema = await db.getSchema();
          expect(dbSchema?.collections).toHaveProperty('students');
          expect(
            dbSchema?.collections.students.schema.properties
          ).not.toHaveProperty('age');
          const hash2 = hashSchemaJSON(schemaToJSON(dbSchema)?.collections);

          expect(hash1).toBe(hash2);
        }
      );
    });
  });

  describe('alterAttributeOption', () => {
    const defaultSchema = {
      collections: {
        students: {
          schema: S.Schema({
            id: S.String(),
            name: S.String(),
            address: S.Record({
              street: S.String(),
              zip: S.String(),
            }),
          }),
        },
      },
    };
    it('can update attribute options', async () => {
      await testDBAndTransaction(
        () =>
          new DB({
            schema: defaultSchema,
          }),
        async (db) => {
          // new values
          await db.alterAttributeOption({
            collection: 'students',
            path: ['name'],
            options: {
              nullable: true,
              default: "Robert'); DROP TABLE Students;--",
            },
          });

          let dbSchema = await db.getSchema();
          expect(
            dbSchema?.collections.students.schema.properties.name.options
              .nullable
          ).toBe(true);
          expect(
            dbSchema?.collections.students.schema.properties.name.options
              .default
          ).toBe("Robert'); DROP TABLE Students;--");

          // update values
          await db.alterAttributeOption({
            collection: 'students',
            path: ['name'],
            options: {
              nullable: false,
              default: 'Bobby Tables',
            },
          });

          dbSchema = await db.getSchema();
          expect(
            dbSchema?.collections.students.schema.properties.name.options
              .nullable
          ).toBe(false);
          expect(
            dbSchema?.collections.students.schema.properties.name.options
              .default
          ).toBe('Bobby Tables');
        }
      );
    });

    it('alterAttributeOption can update a nested attribute', async () => {
      await testDBAndTransaction(
        () =>
          new DB({
            schema: defaultSchema,
          }),
        async (db) => {
          await db.alterAttributeOption({
            collection: 'students',
            path: ['address', 'zip'],
            options: {
              nullable: true,
              default: '12345',
            },
          });

          {
            const dbSchema = await db.getSchema();
            expect(
              dbSchema?.collections.students.schema.properties.address
                .properties.zip.options.nullable
            ).toBe(true);
            expect(
              dbSchema?.collections.students.schema.properties.address
                .properties.zip.options.default
            ).toBe('12345');
          }

          await db.alterAttributeOption({
            collection: 'students',
            path: ['address', 'zip'],
            options: {
              nullable: false,
              default: '54321',
            },
          });

          {
            const dbSchema = await db.getSchema();
            expect(
              dbSchema?.collections.students.schema.properties.address
                .properties.zip.options.nullable
            ).toBe(false);
            expect(
              dbSchema?.collections.students.schema.properties.address
                .properties.zip.options.default
            ).toBe('54321');
          }
        }
      );
    });

    it('alterAttributeOption throws if the collection doesnt exist', async () => {
      await testDBAndTransaction(
        () =>
          new DB({
            schema: defaultSchema,
          }),
        async (db) => {
          await expect(
            db.alterAttributeOption({
              collection: 'todos',
              path: ['text'],
              options: { nullable: true },
            })
          ).rejects.toThrowError(CollectionNotFoundError);
        }
      );
    });

    it('alterAttributeOption throws if the path is not valid', async () => {
      await testDBAndTransaction(
        () =>
          new DB({
            schema: defaultSchema,
          }),
        async (db) => {
          await expect(
            db.alterAttributeOption({
              collection: 'students',
              path: [],
              options: { nullable: true },
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
          await expect(
            db.alterAttributeOption({
              collection: 'students',
              path: ['addresss', 'state'],
              options: { nullable: true },
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
          await expect(
            db.alterAttributeOption({
              collection: 'students',
              path: ['address', 'foo'],
              options: { nullable: true },
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
        }
      );
    });

    it('alterAttributeOption is idempoent', async () => {
      await testDBAndTransaction(
        () =>
          new DB({
            schema: defaultSchema,
          }),
        async (db) => {
          await db.alterAttributeOption({
            collection: 'students',
            path: ['name'],
            options: { nullable: true },
          });
          const hash1 = hashSchemaJSON(
            schemaToJSON(await db.getSchema())?.collections
          );
          await db.alterAttributeOption({
            collection: 'students',
            path: ['name'],
            options: { nullable: true },
          });
          const dbSchema = await db.getSchema();
          expect(
            dbSchema?.collections.students.schema.properties.name.options
              .nullable
          ).toBe(true);
          const hash2 = hashSchemaJSON(schemaToJSON(dbSchema)?.collections);

          expect(hash1).toBe(hash2);
        }
      );
    });
  });

  describe('dropAttributeOption', () => {
    const defaultSchema = {
      collections: {
        students: {
          schema: S.Schema({
            id: S.String(),
            name: S.String({
              nullable: true,
              default: 'Bobby Tables',
            }),
            address: S.Record({
              street: S.String(),
              state: S.String(),
              zip: S.String({
                nullable: true,
                default: '54321',
              }),
            }),
          }),
        },
      },
    };
    it('can drop attribute options', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.dropAttributeOption({
            collection: 'students',
            path: ['name'],
            option: 'nullable',
          });
          {
            const dbSchema = await db.getSchema();
            expect(
              dbSchema?.collections.students.schema.properties.name.options
            ).not.toHaveProperty('nullable');
          }
          await db.dropAttributeOption({
            collection: 'students',
            path: ['name'],
            option: 'default',
          });
          {
            const dbSchema = await db.getSchema();
            expect(
              dbSchema?.collections.students.schema.properties.name.options
            ).not.toHaveProperty('default');
          }
        }
      );
    });
    it('dropAttributeOption can drop a nested attribute option', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.dropAttributeOption({
            collection: 'students',
            path: ['address', 'zip'],
            option: 'nullable',
          });
          {
            const dbSchema = await db.getSchema();
            expect(
              dbSchema?.collections.students.schema.properties.address
                .properties.zip.options
            ).not.toHaveProperty('nullable');
          }
          await db.dropAttributeOption({
            collection: 'students',
            path: ['address', 'zip'],
            option: 'default',
          });
          {
            const dbSchema = await db.getSchema();
            expect(
              dbSchema?.collections.students.schema.properties.address
                .properties.zip.options
            ).not.toHaveProperty('default');
          }
        }
      );
    });

    it('dropAttributeOption throws if the collection doesnt exist', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await expect(
            db.dropAttributeOption({
              collection: 'todos',
              path: ['text'],
              option: 'nullable',
            })
          ).rejects.toThrowError(CollectionNotFoundError);
        }
      );
    });

    it('dropAttributeOption throws if the path is not valid', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await expect(
            db.dropAttributeOption({
              collection: 'students',
              path: [],
              option: 'nullable',
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
          await expect(
            db.dropAttributeOption({
              collection: 'students',
              path: ['addresss', 'zip'],
              option: 'nullable',
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
          await expect(
            db.dropAttributeOption({
              collection: 'students',
              path: ['address', 'foo'],
              option: 'nullable',
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
        }
      );
    });

    it('dropAttributeOption is idempoent', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.dropAttributeOption({
            collection: 'students',
            path: ['name'],
            option: 'nullable',
          });
          const hash1 = hashSchemaJSON(
            schemaToJSON(await db.getSchema())?.collections
          );
          await db.dropAttributeOption({
            collection: 'students',
            path: ['name'],
            option: 'nullable',
          });
          const dbSchema = await db.getSchema();
          expect(
            dbSchema?.collections.students.schema.properties.name.options
          ).not.toHaveProperty('nullable');
          const hash2 = hashSchemaJSON(schemaToJSON(dbSchema)?.collections);

          expect(hash1).toBe(hash2);
        }
      );
    });
  });

  describe('addRule', () => {
    it('can add a rule to a collection', async () => {
      await testDBAndTransaction(
        () =>
          new DB({
            source: new InMemoryTupleStorage(),
            schema: {
              collections: {
                students: {
                  schema: S.Schema({
                    id: S.String(),
                    name: S.String(),
                  }),
                },
              },
            },
          }),
        async (db) => {
          {
            const schema = await db.getSchema();
            const rules = schema?.collections.students.rules?.read ?? {};
            expect(Object.keys(rules)).toHaveLength(0);
          }

          await db.addRule({
            scope: 'read',
            collection: 'students',
            id: 'only-read-self',
            rule: {
              filter: [['id', '=', '$SESSION_USER_ID']],
              description: 'Can only read your own student record',
            },
          });

          {
            const schema = await db.getSchema();
            const rules = schema?.collections.students.rules?.read!;
            expect(Object.keys(rules)).toHaveLength(1);
            const rule = rules['only-read-self']!;
            expect(rule.filter).toEqual([['id', '=', '$SESSION_USER_ID']]);
            expect(rule.description).toEqual(
              'Can only read your own student record'
            );
          }
        }
      );
    });
  });

  describe('dropRule', () => {
    it('can drop a rule from a collection', async () => {
      await testDBAndTransaction(
        () =>
          new DB({
            source: new InMemoryTupleStorage(),
            schema: {
              collections: {
                students: {
                  schema: S.Schema({
                    id: S.String(),
                    name: S.String(),
                  }),
                  rules: {
                    read: {
                      'only-read-self': {
                        filter: [['id', '=', '$SESSION_USER_ID']],
                        description: 'Can only read your own student record',
                      },
                    },
                  },
                },
              },
            },
          }),
        async (db) => {
          {
            const schema = await db.getSchema();
            const rules = schema?.collections.students.rules?.read!;
            expect(Object.keys(rules)).toHaveLength(1);
            const rule = rules['only-read-self']!;
            expect(rule.filter).toEqual([['id', '=', '$SESSION_USER_ID']]);
            expect(rule.description).toEqual(
              'Can only read your own student record'
            );
          }

          await db.dropRule({
            scope: 'read',
            collection: 'students',
            id: 'only-read-self',
          });

          {
            const schema = await db.getSchema();
            const rules = schema?.collections.students.rules?.read ?? {};
            expect(Object.keys(rules)).toHaveLength(0);
          }
        }
      );
    });
  });

  describe('setAttributeOptional', () => {
    const defaultSchema = {
      collections: {
        test: {
          schema: S.Schema({
            id: S.String(),
            required: S.String(),
            optional: S.Optional(S.String()),
            record: S.Record({
              required: S.String(),
              optional: S.Optional(S.String()),
            }),
          }),
        },
      },
    };
    it('can set an attribute to optional', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          {
            const schema = await db.getSchema();
            expect(schema?.collections.test.schema.optional?.length).toBe(1);
            expect(
              schema?.collections.test.schema.optional?.includes('optional')
            ).toBe(true);
          }
          await db.setAttributeOptional({
            collection: 'test',
            path: ['required'],
            optional: true,
          });
          {
            const schema = await db.getSchema();
            expect(schema?.collections.test.schema.optional?.length).toBe(2);
            expect(
              schema?.collections.test.schema.optional?.includes('required')
            ).toBe(true);
            expect(
              schema?.collections.test.schema.optional?.includes('optional')
            ).toBe(true);
          }
          await db.setAttributeOptional({
            collection: 'test',
            path: ['optional'],
            optional: false,
          });
          {
            const schema = await db.getSchema();
            expect(schema?.collections.test.schema.optional?.length).toBe(1);
            expect(
              schema?.collections.test.schema.optional?.includes('required')
            ).toBe(true);
          }
        }
      );
    });

    it('setAttributeOptional can set a nested attribute optional', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          {
            const schema = await db.getSchema();
            expect(
              schema?.collections.test.schema.properties.record.optional?.length
            ).toBe(1);
            expect(
              schema?.collections.test.schema.properties.record.optional?.includes(
                'optional'
              )
            ).toBe(true);
          }
          await db.setAttributeOptional({
            collection: 'test',
            path: ['record', 'required'],
            optional: true,
          });
          {
            const schema = await db.getSchema();
            expect(
              schema?.collections.test.schema.properties.record.optional?.length
            ).toBe(2);
            expect(
              schema?.collections.test.schema.properties.record.optional?.includes(
                'required'
              )
            ).toBe(true);
            expect(
              schema?.collections.test.schema.properties.record.optional?.includes(
                'optional'
              )
            ).toBe(true);
          }
          await db.setAttributeOptional({
            collection: 'test',
            path: ['record', 'optional'],
            optional: false,
          });
          {
            const schema = await db.getSchema();
            expect(
              schema?.collections.test.schema.properties.record.optional?.length
            ).toBe(1);
            expect(
              schema?.collections.test.schema.properties.record.optional?.includes(
                'required'
              )
            ).toBe(true);
          }
        }
      );
    });

    it('setAttributeOptional throws if the collection doesnt exist', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await expect(
            db.setAttributeOptional({
              collection: 'todos',
              path: ['text'],
              optional: true,
            })
          ).rejects.toThrowError(CollectionNotFoundError);
        }
      );
    });

    it('setAttributeOptional throws if the path is not valid', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await expect(
            db.setAttributeOptional({
              collection: 'test',
              path: [],
              optional: true,
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
          await expect(
            db.setAttributeOptional({
              collection: 'test',
              path: ['recordd', 'required'],
              optional: true,
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
          await expect(
            db.setAttributeOptional({
              collection: 'test',
              path: ['record', 'foo'],
              optional: true,
            })
          ).rejects.toThrowError(InvalidSchemaPathError);
        }
      );
    });

    it('setAttributeOptional is idempoent', async () => {
      await testDBAndTransaction(
        () => new DB({ schema: defaultSchema }),
        async (db) => {
          await db.setAttributeOptional({
            collection: 'test',
            path: ['required'],
            optional: true,
          });
          await db.setAttributeOptional({
            collection: 'test',
            path: ['optional'],
            optional: false,
          });
          const hash1 = hashSchemaJSON(
            schemaToJSON(await db.getSchema())?.collections
          );
          await db.setAttributeOptional({
            collection: 'test',
            path: ['required'],
            optional: true,
          });
          await db.setAttributeOptional({
            collection: 'test',
            path: ['optional'],
            optional: false,
          });
          const dbSchema = await db.getSchema();
          expect(dbSchema?.collections.test.schema.optional?.length).toBe(1);
          expect(
            dbSchema?.collections.test.schema.optional?.includes('required')
          ).toBe(true);

          const hash2 = hashSchemaJSON(schemaToJSON(dbSchema)?.collections);

          expect(hash1).toBe(hash2);
        }
      );
    });
  });

  it('can override an existing schema', async () => {
    const dataSource = new MemoryStorage();
    const schemaOne = {
      collections: {
        students: {
          schema: S.Schema({
            id: S.String(),
            name: S.String(),
          }),
        },
      },
    };
    const schemaTwo = {
      collections: {
        products: {
          schema: S.Schema({
            id: S.String(),
            name: S.String(),
            price: S.Number(),
          }),
        },
      },
    };
    const dbOne = new DB({ source: dataSource, schema: schemaOne });
    await dbOne.ensureMigrated;
    const beforeSchema = await dbOne.getSchema();
    expect(beforeSchema).toBeDefined();
    expect(beforeSchema.collections.students).toBeDefined();
  });
});

describe('migrations', () => {
  const migrations: Migration[] = [
    {
      parent: 0,
      version: 1,
      up: [
        [
          'create_collection',
          {
            name: 'students',
            schema: {
              id: { type: 'number', options: {} },
              name: { type: 'string', options: {} },
            },
          },
        ],
      ],
      down: [['drop_collection', { name: 'students' }]],
    },
    {
      parent: 1,
      version: 2,
      up: [
        [
          'create_collection',
          {
            name: 'classes',
            schema: {
              id: { type: 'number', options: {} },
              department: { type: 'string', options: {} },
            },
          },
        ],
      ],
      down: [['drop_collection', { name: 'classes' }]],
    },
  ];

  it('initializing a DB with migrations sets the schema and migrations tracker', async () => {
    const db = new DB({ migrations });
    const dbSchema = await db.getSchema();
    expect(dbSchema?.collections).toHaveProperty('students');
    expect(dbSchema?.collections).toHaveProperty('classes');
    expect(dbSchema?.version).toEqual(2);

    const appliedMigrations = Object.values(await db.getAppliedMigrations());
    expect(appliedMigrations.length).toEqual(2);
    expect(appliedMigrations[0].id).toEqual(1);
    expect(appliedMigrations[0].parent).toEqual(0);
    expect(appliedMigrations[1].id).toEqual(2);
    expect(appliedMigrations[1].parent).toEqual(1);
  });

  it('migrating updates migrations tracker', async () => {
    const db = new DB();
    await db.ensureMigrated;
    {
      const appliedMigrations = Object.values(await db.getAppliedMigrations());
      expect(appliedMigrations.length).toEqual(0);
    }
    await db.migrate([migrations[0]], 'up');
    {
      const appliedMigrations = Object.values(await db.getAppliedMigrations());
      expect(appliedMigrations.length).toEqual(1);
    }
    await db.migrate([migrations[1]], 'up');
    {
      const appliedMigrations = Object.values(await db.getAppliedMigrations());
      expect(appliedMigrations.length).toEqual(2);
    }
    await db.migrate([migrations[1]], 'down');
    {
      const appliedMigrations = Object.values(await db.getAppliedMigrations());
      expect(appliedMigrations.length).toEqual(1);
    }
    await db.migrate([migrations[0]], 'down');
    {
      const appliedMigrations = Object.values(await db.getAppliedMigrations());
      expect(appliedMigrations.length).toEqual(0);
    }
  });

  it('will stop migrating on an error', async () => {
    const migrationsCopy = JSON.parse(
      JSON.stringify(migrations)
    ) as Migration[];
    migrationsCopy[1].up.push([
      'bad_op',
      {
        arg: 'foo',
      },
    ]);
    const db = new DB({ migrations: migrationsCopy });
    await expect(db.ensureMigrated).rejects.toThrowError(
      InvalidMigrationOperationError
    );
    // const db = new DB({ migrations: migrationsCopy });

    // const dbSchema = await db.getSchema();
    // expect(dbSchema?.collections).toHaveProperty('students');
    // expect(dbSchema?.collections).not.toHaveProperty('classes');
    // expect(dbSchema?.version).toEqual(1);
  });

  it('will only run migrations if version and parent pointer match', async () => {
    const migration01 = { parent: 0, version: 1, up: [], down: [] };
    const migration12 = { parent: 1, version: 2, up: [], down: [] };
    const migration13 = { parent: 1, version: 3, up: [], down: [] };
    const migration23 = { parent: 2, version: 3, up: [], down: [] };
    const migration34 = { parent: 3, version: 4, up: [], down: [] };

    // Standard case
    const migrationsLinked = [
      migration01,
      migration12,
      migration23,
      migration34,
    ];
    // Branch at 1->2, 1->3, must apply a migration with parent 2 to continue
    const migrationsUnlinked = [
      migration01,
      migration12,
      migration13,
      migration34,
    ];
    // Skip 1->3, continue with 2->3
    const migrationsAll = [
      migration01,
      migration12,
      migration13,
      migration23,
      migration34,
    ];

    const dbLinked = new DB({ migrations: migrationsLinked });
    const dbUnlinked = new DB({ migrations: migrationsUnlinked });
    const dbAll = new DB({ migrations: migrationsAll });

    const dbLinkedSchema = await dbLinked.getSchema();
    const dbUnlinkedSchema = await dbUnlinked.getSchema();
    const dbAllSchema = await dbAll.getSchema();
    expect(dbLinkedSchema?.version).toEqual(4);
    expect(dbUnlinkedSchema?.version).toEqual(2);
    expect(dbAllSchema?.version).toEqual(4);

    const linkedMigration = { parent: 4, version: 5, up: [], down: [] };
    const unlinkedMigration = { parent: 3, version: 5, up: [], down: [] };

    await dbAll.migrate([unlinkedMigration], 'up');
    const dbAllSchemaAfter = await dbAll.getSchema();
    expect(dbAllSchemaAfter?.version).toEqual(4);

    await dbAll.migrate([linkedMigration], 'up');
    const dbAllSchemaAfter2 = await dbAll.getSchema();
    expect(dbAllSchemaAfter2?.version).toEqual(5);

    // TODO: I think this would fail because migration would be applied since we dont actually store the migrations that were applied
    // dbAll.migrate([unlinkedMigration], 'down');
    // expect(dbAll.tripleStore.schema?.version).toEqual(5);
    await dbAll.migrate([linkedMigration], 'down');
    const dbAllSchemaAfter3 = await dbAll.getSchema();
    expect(dbAllSchemaAfter3?.version).toEqual(4);

    await dbAll.migrate([unlinkedMigration], 'down');
    const dbAllSchemaAfter4 = await dbAll.getSchema();
    expect(dbAllSchemaAfter4?.version).toEqual(4);
  });

  describe('Data deletion', () => {
    it('clear() removes all data from the database', async () => {
      // Schema provides us with metadata to delete
      const schema = {
        collections: {
          students: {
            schema: S.Schema({
              id: S.String(),
              name: S.String(),
            }),
          },
        },
      };
      const storage = new InMemoryTupleStorage();
      const db = new DB({ source: storage, schema: schema });
      await db.insert('students', { id: '1', name: 'Alice' });

      expect(storage.data.length).not.toBe(0);

      await db.clear();

      expect(storage.data.length).toBe(0);
    });
  });
});

describe('DB Variables', () => {
  const storage = new InMemoryTupleStorage();
  const DEPARTMENT = 'dep-1';
  const db = new DB({
    source: storage,
    variables: {
      DEPARTMENT,
    },
  });

  const classesInDep = classes.filter((c) => c.department === DEPARTMENT);

  beforeAll(async () => {
    await db.transact(async (tx) => {
      for (const cls of classes) {
        await tx.insert('classes', cls);
      }
      for (const dpt of departments) {
        await tx.insert('departments', dpt);
      }
    });
  });

  it('fetch supports variables', async () => {
    const query = db
      .query('classes')
      .where([['department', '=', '$DEPARTMENT']])
      .build();

    await testDBAndTransaction(
      () => db,
      async (db) => {
        const result = await db.fetch(query);
        expect(result).toHaveLength(classesInDep.length);
        expect(
          [...result.values()].every((r) => r.department === DEPARTMENT)
        ).toBeTruthy();
      }
    );
  });

  it('fetchOne supports variables', async () => {
    const query = db
      .query('classes')
      .where([['department', '=', '$DEPARTMENT']])
      .build();

    await testDBAndTransaction(
      () => db,
      async (db) => {
        const result = await db.fetchOne(query);
        expect(result.department).toBe(DEPARTMENT);
      }
    );
  });

  it('fetchById supports variables', async () => {
    await testDBAndTransaction(
      () => db,
      async (db) => {
        const result = await db.fetchById('departments', '$DEPARTMENT');
        expect(result?.id).toBe(DEPARTMENT);
      }
    );
  });

  it('entityId supports variables', async () => {
    const query = db.query('departments').entityId('$DEPARTMENT').build();
    await testDBAndTransaction(
      () => db,
      async (db) => {
        const result = await db.fetch(query);
        expect(result).toHaveLength(1);
        expect(result.get('dep-1')?.id).toBe(DEPARTMENT);
      }
    );
  });

  it('can use variables in query with simple grouped filter', async () => {
    const query = db
      .query('classes')
      .where([{ mod: 'and', filters: [['department', '=', '$DEPARTMENT']] }])
      .build();
    const result = await db.fetch(query);
    expect(result).toHaveLength(classesInDep.length);
    expect(
      [...result.values()].every((r) => r.department === DEPARTMENT)
    ).toBeTruthy();
  });

  it('can use variables in query deeply nested grouped filter', async () => {
    const query = db
      .query('classes')
      .where([
        {
          mod: 'and',
          filters: [
            {
              mod: 'and',
              filters: [
                { mod: 'and', filters: [['department', '=', '$DEPARTMENT']] },
              ],
            },
          ],
        },
      ])
      .build();
    await testDBAndTransaction(
      () => db,
      async (db) => {
        const result = await db.fetch(query);
        expect(result).toHaveLength(classesInDep.length);
        expect(
          [...result.values()].every((r) => r.department === DEPARTMENT)
        ).toBeTruthy();
      }
    );
  });

  it('can update global variables', async () => {
    const query = db
      .query('classes')
      .where([['department', '=', '$DEPARTMENT']])
      .build();

    const preUpdateResult = await db.fetch(query);
    expect(preUpdateResult.size).toBe(3);

    db.updateVariables({ DEPARTMENT: 'dep-2' });

    const postUpdateResult = await db.fetch(query);
    expect(postUpdateResult.size).toBe(2);
  });

  it('can provide variables via a query', async () => {
    const query = db
      .query('classes')
      .where([['department', '=', '$DEPARTMENT']]);

    const builtQuery1 = query.vars({ DEPARTMENT: 'dep-1' }).build();
    const builtQuery2 = query.vars({ DEPARTMENT: 'dep-2' }).build();

    await testDBAndTransaction(
      () => db,
      async (db) => {
        const result1 = await db.fetch(builtQuery1);
        const result2 = await db.fetch(builtQuery2);

        expect(result1.size).toBe(3);
        expect(result2.size).toBe(2);
      }
    );
  });

  it.todo('insert supports variables');
  it.todo('update supports variables');

  it.todo('supports updating variables with active subscriptions');
});

describe('Rules', () => {
  describe('Read', () => {
    const storage = new InMemoryTupleStorage();
    const USER_ID = 'student-2';
    const db = new DB({
      source: storage,
      variables: {
        user_id: USER_ID,
      },
    });

    beforeAll(async () => {
      await db.createCollection({
        name: 'classes',
        schema: {
          id: { type: 'string', options: {} },
          name: { type: 'string', options: {} },
          level: { type: 'number', options: {} },
          department: { type: 'string', options: {} },
          enrolled_students: {
            type: 'set',
            items: { type: 'string', options: {} },
          },
        },
        rules: {
          read: {
            enrolled_students_read: {
              description: "Students can only view classes they're enrolled in",
              filter: [['enrolled_students', '=', '$user_id']],
            },
          },
        },
      });

      await db.transact(async (tx) => {
        for (const cls of classes) {
          await tx.insert('classes', {
            ...cls,
            enrolled_students: new Set(cls.enrolled_students),
          });
        }
      });
    });

    it('fetch: filters results based on rules', async () => {
      const query = db.query('classes').build();
      await testDBAndTransaction(
        () => db,
        async (db) => {
          const results = await db.fetch(query);
          const classesWithStudent2 = classes.filter((cls) =>
            cls.enrolled_students.includes(USER_ID)
          );
          expect(results).toHaveLength(classesWithStudent2.length);
        }
      );
    });

    it('fetch: doesnt filter rules if skipRules is set', async () => {
      const query = db.query('classes').build();
      await testDBAndTransaction(
        () => db,
        async (db) => {
          const results = await db.fetch(query, { skipRules: true });
          expect(results).toHaveLength(classes.length);
        }
      );
    });

    it('fetchById: filters results based on rules', async () => {
      await testDBAndTransaction(
        () => db,
        async (db) => {
          const nonEnrolledClass = await db.fetchById('classes', 'class-2');
          expect(nonEnrolledClass).toBeNull();
          const enrolledClass = await db.fetchById('classes', 'class-1');
          expect(enrolledClass).not.toBeNull();
        }
      );
    });

    it('fetchById: doesnt filter rules if skipRules is set', async () => {
      await testDBAndTransaction(
        () => db,
        async (db) => {
          const nonEnrolledClass = await db.fetchById(
            'classes',
            'class-2',
            {},
            {
              skipRules: true,
            }
          );
          expect(nonEnrolledClass).not.toBeNull();
          const enrolledClass = await db.fetchById(
            'classes',
            'class-1',
            {},
            {
              skipRules: true,
            }
          );
          expect(enrolledClass).not.toBeNull();
        }
      );
    });

    it('subscriptions only fire if filter matches', async () => {
      const db = new DB();
      const completedTodosQuery = db
        .query('todos')
        .where('completed', '=', true)
        .build();

      let calls = 0;
      let assertions = [
        (results: Map<string, any>) => {
          expect(results.size).toBe(0);
        },
        (results: Map<string, any>) => {
          expect(results.size).toBe(1);
          expect(results.get('1')).toBeTruthy();
        },
        (results: Map<string, any>) => {
          expect(results.size).toBe(2);
          expect(results.get('1')).toBeTruthy();
          expect(results.get('2')).toBeFalsy();
          expect(results.get('3')).toBeTruthy();
        },
      ];
      db.subscribe(completedTodosQuery, (data) => {
        assertions[calls](data);
        calls++;
      });
      // Insert data over time
      await new Promise<void>((res) =>
        setTimeout(async () => {
          await db.insert('todos', {
            text: 'Buy milk',
            completed: true,
            id: '1',
          });
          res();
        }, 20)
      );
      await new Promise<void>((res) =>
        setTimeout(async () => {
          await db.insert('todos', {
            text: 'Buy eggs',
            completed: false,
            id: '2',
          });
          res();
        }, 20)
      );
      await new Promise<void>((res) =>
        setTimeout(async () => {
          await db.insert('todos', {
            text: 'Buy bread',
            completed: true,
            id: '3',
          });
          res();
        }, 20)
      );

      await new Promise<void>((res) => setTimeout(res, 20));
      expect(calls).toEqual(3);
    });
  });

  describe('Insert', () => {
    let db: DB<undefined>;
    const USER_ID = 'the-user-id';
    beforeAll(async () => {
      db = new DB({
        variables: {
          user_id: USER_ID,
        },
      });

      await db.createCollection({
        name: 'posts',
        schema: {
          id: { type: 'string', options: {} },
          author_id: { type: 'string', options: {} },
        },
        rules: {
          write: {
            'post-author': {
              description: 'Users can only post posts they authored',
              filter: [['author_id', '=', '$user_id']],
            },
          },
        },
      });
    });

    describe('insert single', () => {
      it('can insert an entity that matches the filter', async () => {
        expect(
          db.insert('posts', { id: 'post-1', author_id: USER_ID })
        ).resolves.not.toThrowError();
      });

      it("throws an error when inserting a obj that doesn't match filter", async () => {
        expect(
          db.insert('posts', {
            id: 'post-1',
            author_id: 'Not-the-current-user',
          })
        ).rejects.toThrowError(WriteRuleError);
      });
    });

    describe('insert in transaction', () => {
      it('can insert an entity that matches the filter', async () => {
        expect(
          db.transact(async (tx) => {
            await tx.insert('posts', { id: 'post-1', author_id: USER_ID });
          })
        ).resolves.not.toThrowError();
      });

      it("throws an error when inserting a obj that doesn't match filter", async () => {
        expect(
          db.transact(async (tx) => {
            await tx.insert(
              'posts',
              { id: 'post-1', author_id: 'Not-the-current-user' },
              'post-2'
            );
          })
        ).rejects.toThrowError(WriteRuleError);
      });

      it('ignores rules if skipRules is set', async () => {
        expect(
          db.transact(
            async (tx) => {
              await tx.insert('posts', {
                id: 'post-1',
                author_id: 'Not-the-current-user',
              });
            },
            { skipRules: true }
          )
        ).resolves.not.toThrowError();
      });
    });

    describe('rules with relationships', async () => {
      const schema = {
        collections: {
          posts: {
            schema: S.Schema({
              id: S.Id(),
              text: S.String(),
              author_id: S.String(),
              author: S.RelationById('users', '$author_id'),
            }),
            rules: {
              write: {
                'admin-write': {
                  description: 'Only admin users can create posts',
                  filter: [
                    ['author.admin', '=', true],
                    ['author_id', '=', '$user_id'],
                  ],
                },
              },
            },
          },
          users: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
              admin: S.Boolean(),
            }),
          },
        },
      };
      it('insert with relationship in rule', async () => {
        const db = new DB({ schema });

        const aliceDB = db.withVars({ user_id: 'user-1' });
        const bobDB = db.withVars({ user_id: 'user-2' });

        await db.insert('users', { id: 'user-1', name: 'Alice', admin: true });
        await db.insert('users', { id: 'user-2', name: 'Bob', admin: false });

        await expect(
          aliceDB.insert('posts', {
            id: 'post-1',
            text: 'post-1',
            author_id: 'user-1',
          })
        ).resolves.not.toThrowError();
        await expect(
          bobDB.insert('posts', {
            id: 'post-2',
            text: 'post-2',
            author_id: 'user-2',
          })
        ).rejects.toThrowError(WriteRuleError);
      });

      it('update with relationship in rule', async () => {
        const db = new DB({ schema });
        const aliceDB = db.withVars({ user_id: 'user-1' });
        const bobDB = db.withVars({ user_id: 'user-2' });

        await db.insert('users', { id: 'user-1', name: 'Alice', admin: true });
        await db.insert('users', { id: 'user-2', name: 'Bob', admin: false });

        await aliceDB.insert('posts', {
          id: 'post-1',
          text: 'post-1',
          author_id: 'user-1',
        });
        await aliceDB.insert('posts', {
          id: 'post-2',
          text: 'post-2',
          author_id: 'user-1',
        });

        await expect(
          aliceDB.update('posts', 'post-1', async (entity) => {
            entity.text = 'post-1 updated';
          })
        ).resolves.not.toThrowError();
        await expect(
          bobDB.update('posts', 'post-2', async (entity) => {
            entity.text = 'post-2 updated';
          })
        ).rejects.toThrowError(WriteRuleError);
      });

      it('delete with relationship in rule', async () => {
        const db = new DB({ schema });
        const aliceDB = db.withVars({ user_id: 'user-1' });
        const bobDB = db.withVars({ user_id: 'user-2' });

        await db.insert('users', { id: 'user-1', name: 'Alice', admin: true });
        await db.insert('users', { id: 'user-2', name: 'Bob', admin: false });

        await aliceDB.insert('posts', {
          id: 'post-1',
          text: 'post-1',
          author_id: 'user-1',
        });
        await aliceDB.insert('posts', {
          id: 'post-2',
          text: 'post-2',
          author_id: 'user-1',
        });

        await expect(
          aliceDB.delete('posts', 'post-1')
        ).resolves.not.toThrowError();
        await expect(bobDB.delete('posts', 'post-2')).rejects.toThrowError(
          WriteRuleError
        );
      });
    });
  });

  describe('Update', () => {
    let db: DB<any>;
    const USER_ID = 'the-user-id';
    const POST_ID = 'post-1';
    const POST = { id: POST_ID, author_id: USER_ID, content: 'before' };
    beforeEach(async () => {
      db = new DB({
        variables: {
          user_id: USER_ID,
        },
      });

      await db.createCollection({
        name: 'posts',
        schema: {
          id: { type: 'string', options: {} },
          author_id: { type: 'string', options: {} },
          content: { type: 'string', options: {} },
        },
        rules: {
          write: {
            'post-author': {
              description: 'Users can only post posts they authored',
              filter: [['author_id', '=', '$user_id']],
            },
          },
        },
      });

      await db.insert('posts', POST);
    });

    describe('update single', () => {
      it('can update an entity that passes filter', async () => {
        await expect(
          db.update('posts', POST_ID, async (entity) => {
            entity.content = 'after';
          })
        ).resolves.not.toThrowError();
      });

      it("throws an error when updating an obj that doesn't match filter", async () => {
        await expect(
          db
            .withVars({ user_id: 'not the user' })
            .update('posts', POST_ID, async (entity) => {
              entity.content = 'hax0r';
            })
        ).rejects.toThrowError(WriteRuleError);
        const post = await db.fetchById('posts', POST_ID);
        expect(post.author_id).not.toBe('not me');
      });

      it('ignores rules if skipRules is set', async () => {
        await expect(
          db.update(
            'posts',
            POST_ID,
            async (entity) => {
              entity.author_id = 'not me';
            },
            { skipRules: true }
          )
        ).resolves.not.toThrowError();
        const post = await db.fetchById('posts', POST_ID);
        expect(post.author_id).toBe('not me');
      });
    });

    describe('update in transaction', () => {
      it('can update an entity that passes the filter', async () => {
        const post = await db.fetchById('posts', POST_ID);
        await expect(
          db.transact(async (tx) => {
            await tx.update('posts', POST_ID, async (entity) => {
              entity.content = 'after';
            });
          })
        ).resolves.not.toThrowError();
      });

      it("throws an error when updating a obj that doesn't match filter", async () => {
        await expect(
          db.transact(async (tx) => {
            await tx.update('posts', POST_ID, async (entity) => {
              entity.author_id = 'not me';
            });
          })
        ).rejects.toThrowError(WriteRuleError);
        const post = await db.fetchById('posts', POST_ID);
        expect(post!.author_id).not.toBe('not me');
      });
    });
  });

  describe('Delete', () => {
    const schema = {
      collections: {
        posts: {
          schema: S.Schema({
            id: S.String(),
            author_id: S.String(),
          }),
          rules: {
            write: {
              'post-author': {
                description: 'Users can only post posts they authored',
                filter: [['author_id', '=', '$user_id']],
              },
            },
          },
        },
      },
    };

    const user_id = 'user-1';

    it('can delete entity that passes rule', async () => {
      const db = new DB({
        schema,
        variables: {
          user_id,
        },
      });
      await db.insert('posts', { id: 'post-1', author_id: user_id });
      await db.delete('posts', 'post-1');
    });

    it("throws an error when deleting an entity that doesn't pass rule", async () => {
      const storage = new InMemoryTupleStorage();
      const db1 = new DB({
        schema,
        variables: {
          user_id,
        },
        source: storage,
      });
      const db2 = new DB({
        schema,
        variables: {
          user_id: 'user-2',
        },
        source: storage,
      });
      await db1.insert('posts', { id: 'post-1', author_id: user_id }, 'post-1');
      await expect(db2.delete('posts', 'post-1')).rejects.toThrowError(
        WriteRuleError
      );
    });

    it('ignores rules if skipRules is set', async () => {
      const storage = new InMemoryTupleStorage();
      const db1 = new DB({
        schema,
        variables: {
          user_id,
        },
        source: storage,
      });
      const db2 = new DB({
        schema,
        variables: {
          user_id: 'user-2',
        },
        source: storage,
      });
      await db1.insert('posts', { id: 'post-1', author_id: user_id }, 'post-1');
      await expect(
        db2.delete('posts', 'post-1', { skipRules: true })
      ).resolves.not.toThrowError();
    });
  });
});

// When updating tests, please keep the deep nesting in the test data
describe('Nested Properties', () => {
  describe('Schemaless', () => {
    let db: DB<undefined>;
    const ENTITY_ID = 'business-1';
    beforeEach(async () => {
      db = new DB();
    });

    const defaultData = {
      [ENTITY_ID]: {
        name: 'My Business',
        address: {
          street: {
            number: '123',
            name: 'Main St',
          },
          city: 'San Francisco',
          state: 'CA',
        },
        id: ENTITY_ID,
      },
    };

    it('can insert an entity with nested properties', async () => {
      for (const [id, data] of Object.entries(defaultData)) {
        await db.insert('Businesses', data);
      }

      const query = db.query('Businesses').entityId(ENTITY_ID).build();
      const result = (await db.fetch(query)).get(ENTITY_ID);
      expect(result.address.street.number).toBe('123');
      expect(result.address.street.name).toBe('Main St');
      expect(result.address.city).toBe('San Francisco');
      expect(result.address.state).toBe('CA');
    });

    it('can update nested properties', async () => {
      for (const [id, data] of Object.entries(defaultData)) {
        await db.insert('Businesses', data);
      }

      const query = db.query('Businesses').entityId(ENTITY_ID).build();
      const preUpdateLookup = (await db.fetch(query)).get(ENTITY_ID);
      expect(preUpdateLookup.address.street.number).toBe('123');
      expect(preUpdateLookup.address.street.name).toBe('Main St');

      await db.update('Businesses', ENTITY_ID, async (entity) => {
        entity.address.street.number = '456';
      });

      const postUpdateLookup = (await db.fetch(query)).get(ENTITY_ID);
      expect(postUpdateLookup.address.street.number).toBe('456');
      expect(postUpdateLookup.address.street.name).toBe('Main St');
    });

    it('can query based on nested property', async () => {
      for (const [id, data] of Object.entries(defaultData)) {
        await db.insert('Businesses', data);
      }

      const positiveResults = await db.fetch(
        db
          .query('Businesses')
          .where([['address.city', '=', 'San Francisco']])
          .build()
      );
      expect(positiveResults).toHaveLength(1);

      const negativeResults = await db.fetch(
        db
          .query('Businesses')
          .where([['address.state', '=', 'TX']])
          .build()
      );
      expect(negativeResults).toHaveLength(0);
    });

    it('can select specific nested properties', async () => {
      for (const [id, data] of Object.entries(defaultData)) {
        await db.insert('Businesses', data);
      }

      const results = await db.fetch(
        db.query('Businesses').select(['address.city', 'address.state']).build()
      );
      expect(results).toHaveLength(1);
      const result = results.get(ENTITY_ID);
      expect(result).toHaveProperty('address.city');
      expect(result).toHaveProperty('address.state');
      expect(result).not.toHaveProperty('address.street');
    });
  });
  describe('Schemafull', async () => {
    const schema = {
      Businesses: {
        schema: S.Schema({
          id: S.Id(),
          name: S.String(),
          address: S.Record({
            street: S.Record({
              number: S.String(),
              name: S.String(),
            }),
            city: S.String(),
            state: S.String(),
          }),
        }),
      },
    };
    let db: DB<typeof schema>;
    beforeEach(async () => {
      db = new DB({
        schema: { collections: schema },
      });
    });
    const ENTITY_ID = 'business-1';
    const defaultData = {
      [ENTITY_ID]: {
        name: 'My Business',
        address: {
          street: {
            number: '123',
            name: 'Main St',
          },
          city: 'San Francisco',
          state: 'CA',
        },
      },
    };

    // May be duplicated in 'record operations'
    it('can insert an entity with nested properties', async () => {
      for (const [id, data] of Object.entries(defaultData)) {
        await db.insert('Businesses', { ...data, id });
      }

      const query = db.query('Businesses').entityId(ENTITY_ID).build();
      const result = (await db.fetch(query)).get(ENTITY_ID);
      expect(result.address.street.number).toBe('123');
      expect(result.address.street.name).toBe('Main St');
      expect(result.address.city).toBe('San Francisco');
      expect(result.address.state).toBe('CA');
    });

    // May be duplicated in 'record operations'
    it('rejects inserts of malformed objects', async () => {
      await expect(
        db.insert('Businesses', {
          name: 'My Business',
          address: {
            street: 59, // expects record
            city: 'San Francisco',
            state: 'CA',
          },
        })
      ).rejects.toThrowError(DBSerializationError);

      await expect(
        db.insert('Businesses', {
          name: 'My Business',
          address: {
            street: {
              number: 123, // expects string
              name: 'Main St',
            },
            city: 'San Francisco',
            state: 'CA',
          },
        })
      ).rejects.toThrowError(DBSerializationError);
    });

    it('can query based on nested property', async () => {
      for (const [id, data] of Object.entries(defaultData)) {
        await db.insert('Businesses', data);
      }

      const positiveResults = await db.fetch(
        db
          .query('Businesses')
          .where([['address.city', '=', 'San Francisco']])
          .build()
      );
      expect(positiveResults).toHaveLength(1);

      const negativeResults = await db.fetch(
        db
          .query('Businesses')
          .where([['address.state', '=', 'TX']])
          .build()
      );
      expect(negativeResults).toHaveLength(0);
    });
  });
});

// TODO: come back and un-todo this
describe('Nullable properties in a schema', () => {
  const schema = {
    collections: {
      Todos: {
        schema: S.Schema({
          id: S.Id(),
          text: S.String(),
          created_at: S.Date(),
          deleted_at: S.Date({ nullable: true }),
        }),
      },
    },
  };
  it('can create a database with a schema with nullable properties', async () => {
    expect(
      () =>
        new DB({
          schema,
        })
    ).not.toThrowError();
  });
  it('can insert with nullable properties', async () => {
    const db = new DB({
      schema,
    });
    expect(
      async () =>
        await db.insert('Todos', {
          id: 'todo-1',
          text: 'Do something',
          created_at: new Date(),
          deleted_at: null,
        })
    ).not.toThrowError();
    await db.insert('Todos', {
      id: 'todo-1',
      text: 'Do something',
      created_at: new Date(),
      deleted_at: null,
    });
    const result = await db.fetchById('Todos', 'todo-1');
    expect(result).toHaveProperty('deleted_at');
    expect(result.deleted_at).toBeNull();
  });
  it("can't insert with a non-nullable property set to null", async () => {
    const db = new DB({
      schema,
    });
    expect(
      async () =>
        await db.insert('Todos', {
          id: 'todo-1',
          text: 'Do something',
          created_at: new Date(),
          deleted_at: null,
        })
    ).not.toThrowError();
    await expect(
      db.insert('Todos', {
        id: 'todo-1',
        text: 'Do something',
        created_at: null,
        deleted_at: null,
      })
    ).rejects.toThrowError(DBSerializationError);
  });
  it('can update with nullable properties', async () => {
    const db = new DB({
      schema,
    });
    await db.insert('Todos', {
      id: 'todo-1',
      text: 'Do something',
      created_at: new Date(),
      deleted_at: null,
    });
    await db.update('Todos', 'todo-1', async (entity) => {
      entity.deleted_at = new Date();
    });
    let result = await db.fetchById('Todos', 'todo-1');
    expect(result).toHaveProperty('deleted_at');
    expect(result.deleted_at).not.toBeNull();
    await db.update('Todos', 'todo-1', async (entity) => {
      entity.deleted_at = null;
    });
    result = await db.fetchById('Todos', 'todo-1');
    expect(result).toHaveProperty('deleted_at');
    expect(result.deleted_at).toBeNull();
  });
  it("can't update with a non-nullable property set to null", async () => {
    const db = new DB({
      schema,
    });
    await db.insert('Todos', {
      id: 'todo-1',
      text: 'Do something',
      created_at: new Date(),
      deleted_at: null,
    });
    await expect(
      async () =>
        await db.update('Todos', 'todo-1', async (entity) => {
          entity.created_at = null;
        })
    ).rejects.toThrowError(DBSerializationError);
  });
});

it.skip('throws an error if a register filter is malformed', async () => {
  const db = new DB({
    schema: {
      collections: {
        Classes: {
          schema: S.Schema({
            id: S.Id(),
            name: S.String(),
            students: S.Set(S.String()),
          }),
        },
      },
    },
  });
  const query = db
    .query('Classes')
    .where([['students', '=', 'student-1']])
    .build();
  await db.insert('Classes', {
    name: 'Class 1',
    students: new Set(['student-1', 'student-2']),
  });
  await expect(db.fetch(query)).resolves.not.toThrowError();
  // Delete schema to allow malformed filter
  await db.tripleStore.deleteTriples(
    await db.tripleStore.findByEAT([
      appendCollectionToId('_metadata', '_schema'),
    ])
  );
  await expect(db.fetch(query)).rejects.toThrowError(InvalidFilterError);
});

describe('default values in a schema', () => {
  const schema = {
    collections: {
      Todos: {
        schema: S.Schema({
          id: S.String(),
          text: S.String(),
          created_at: S.Date(),
          completed: S.Boolean({ default: false }),
        }),
      },
    },
  };
  it('can create a database with a schema with default values', async () => {
    expect(
      () =>
        new DB({
          schema,
        })
    ).not.toThrowError();
  });
  it('can insert an entity with default values', async () => {
    await testDBAndTransaction(
      () =>
        new DB({
          schema,
        }),
      async (db) => {
        await db.insert('Todos', {
          id: 'todo-1',
          text: 'Do something',
          created_at: new Date(),
        });
        const result = await db.fetchById('Todos', 'todo-1');
        expect(result).toHaveProperty('completed');
        expect(result.completed).toBe(false);
      }
    );
  });
  it('can use function aliases in schemas as default values', async () => {
    await testDBAndTransaction(
      () =>
        new DB({
          schema: {
            collections: {
              Todos: {
                schema: S.Schema({
                  id: S.Id(),
                  todoId: S.String({
                    default: S.Default.now(),
                  }),
                  text: S.String(),
                  created_at: S.Date({
                    default: S.Default.now(),
                  }),
                }),
              },
            },
          },
        }),
      async (db) => {
        await db.insert('Todos', {
          id: 'todo-1',
          text: 'Do something',
        });
        const result = await db.fetchById('Todos', 'todo-1');
        expect(result).toHaveProperty('todoId');
        expect(result.todoId).toBeTypeOf('string');
        expect(result).toHaveProperty('created_at');
        expect(result.created_at instanceof Date).toBeTruthy();
      }
    );
  });
  //TODO: also should add the error type
  it.todo(
    'should reject schemas that pass invalid default values',
    async () => {
      expect(() =>
        S.Schema({ id: S.Id(), foo: S.String({ default: {} }) })
      ).toThrowError();
      expect(() =>
        S.Schema({ id: S.Id(), foo: S.String({ default: ['array'] }) })
      ).toThrowError();
    }
  );
});

describe('subscription errors', () => {
  it.todo('passes query errors to the callback', async () => {});
  it('handles errors in callback', () => {
    const db = new DB({
      schema: {
        collections: {
          Classes: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
              students: S.Set(S.String()),
            }),
          },
        },
      },
    });
    const query = db.query('Classes').build();
    db.subscribe(
      query,
      (data) => {
        throw new Error('Test Error');
      },
      (error) => {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Test Error');
      }
    );
  });
});

describe('DB variable index cache view thing', () => {
  it('maintains consistency across inserts', async () => {
    const db = new DB({});
    const query = db
      .query('cars')
      .where(['make', '=', 'Ford'], ['year', '>', '$year'])
      .vars({ year: 2010 })
      .build();

    let results;

    results = await db.fetch(query);
    expect(results).toHaveLength(0);

    await db.insert('cars', { make: 'Ford', year: 2011 });
    results = await db.fetch(query);
    expect(results).toHaveLength(1);

    await db.insert('cars', { make: 'Ford', year: 2009 });
    results = await db.fetch(query);
    expect(results).toHaveLength(1);

    await db.insert('cars', { make: 'Ford', year: 2010 });
    results = await db.fetch(query);
    expect(results).toHaveLength(1);

    await db.insert('cars', { make: 'Ford', year: 2020 });
    results = await db.fetch(query);
    expect(results).toHaveLength(2);
  });
});

describe('relational querying / sub querying', () => {
  const db = new DB({});
  const DATA = [
    [
      'manufacturers',
      {
        name: 'Ford',
        country: 'USA',
        id: 'ford',
      },
    ],
    [
      'manufacturers',
      {
        name: 'Toyota',
        country: 'Japan',
        id: 'toyota',
      },
    ],
    [
      'manufacturers',
      {
        name: 'Honda',
        country: 'Japan',
        id: 'honda',
      },
    ],
    [
      'manufacturers',
      {
        name: 'Volkswagen',
        country: 'Germany',
        id: 'vw',
      },
    ],
    [
      'cars',
      { year: 2021, model: 'F150', manufacturer: 'ford', type: 'truck' },
    ],
    [
      'cars',
      { year: 2022, model: 'Fusion', manufacturer: 'ford', type: 'sedan' },
    ],
    [
      'cars',
      { year: 2022, model: 'Explorer', manufacturer: 'ford', type: 'SUV' },
    ],
    [
      'cars',
      { year: 2022, model: 'Camry', manufacturer: 'toyota', type: 'sedan' },
    ],
    [
      'cars',
      { year: 2021, model: 'Tacoma', manufacturer: 'toyota', type: 'truck' },
    ],
    [
      'cars',
      { year: 2021, model: 'Civic', manufacturer: 'honda', type: 'sedan' },
    ],
    [
      'cars',
      { year: 2022, model: 'Accord', manufacturer: 'honda', type: 'sedan' },
    ],
    ['cars', { year: 2022, model: 'Jetta', manufacturer: 'vw', type: 'sedan' }],
    ['cars', { year: 2023, model: 'Atlas', manufacturer: 'vw', type: 'truck' }],
    ['cars', { year: 2022, model: 'Tiguan', manufacturer: 'vw', type: 'SUV' }],
  ];
  beforeAll(async () => {
    // Insert mock data for Cars and Manufacturers
    // Manufacturer - Contains name and country
    for (const [collection, data] of DATA) {
      await db.insert(collection, data);
    }
  });

  it('can handle sub queries that use variables', async () => {
    const query = db
      .query('manufacturers')
      .where([
        {
          exists: db
            .query('cars')
            .where([
              ['type', '=', 'SUV'],
              ['manufacturer', '=', '$id'],
            ])
            .build(),
        },
      ])
      .build();

    const result = await db.fetch(query);
    expect(result).toHaveLength(2);
  });

  it('can handle sub queries that use variables with deletes', async () => {
    const db = new DB({});
    for (const [collection, data] of DATA) {
      await db.insert(collection, data);
    }
    // Add matching data
    await db.insert('manufacturers', {
      name: 'Suburu',
      country: 'USA',
      id: 'suburu',
    });
    await db.insert('cars', {
      year: 2019,
      model: 'Outback',
      manufacturer: 'suburu',
      type: 'SUV',
    });
    // Delete a parent that would inject variables
    await db.delete('manufacturers', 'suburu');

    const query = db
      .query('manufacturers')
      .where([
        {
          exists: db
            .query('cars')
            .where([
              ['type', '=', 'SUV'],
              ['manufacturer', '=', '$id'],
            ])
            .build(),
        },
      ])
      .build();

    const result = await db.fetch(query, { noCache: true });
    expect(result).toHaveLength(2);
  });

  it('can handle nested subqueries', async () => {
    const query = db
      .query('cars')
      .where([
        {
          exists: db
            .query('manufacturers')
            .where([
              ['id', '=', '$manufacturer'],
              {
                exists: db
                  .query('cars')
                  .where([
                    ['type', '=', 'SUV'],
                    ['manufacturer', '=', '$id'],
                  ])
                  .build(),
              },
            ])
            .build(),
        },
      ])
      .build();

    const result = await db.fetch(query);
    // console.log('car results result', carResult);
    expect(result).toHaveLength(6);
  });

  it('can return triples with sub-queries', async () => {
    const query = db
      .query('manufacturers')
      .where([
        {
          exists: db
            .query('cars')
            .where([
              ['type', '=', 'SUV'],
              ['manufacturer', '=', '$id'],
            ])
            .build(),
        },
      ])
      .build();

    const result = await db.fetchTriples(query);
    const collectionsInTriples = result.reduce(
      (collectionSet, { attribute }) => {
        const collectionName = attribute[0];
        if (collectionName !== '_collection') {
          collectionSet.add(attribute[0]);
        }
        return collectionSet;
      },
      new Set()
    );
    expect(collectionsInTriples).toContain('manufacturers');
    expect(collectionsInTriples).toContain('cars');
  });

  it('can subscribe to queries with sub-queries', async () => {
    const query = db
      .query('manufacturers')
      .where([
        {
          exists: db
            .query('cars')
            .where([
              ['type', '=', 'SUV'],
              ['manufacturer', '=', '$id'],
            ])
            .build(),
        },
      ])
      .build();
    await testSubscription(db, query, [
      {
        check: (results) => {
          expect(results).toHaveLength(2);
        },
      },
      {
        action: async () => {
          db.transact(async (tx) => {
            await tx.insert('manufacturers', {
              name: 'Suburu',
              country: 'USA',
              id: 'suburu',
            });
            await tx.insert('cars', {
              year: 2019,
              model: 'Outback',
              manufacturer: 'suburu',
              type: 'SUV',
            });
          });
        },
        check: (results) => {
          expect(results).toHaveLength(3);
        },
      },
      {
        action: async () => {
          await db.insert('cars', {
            year: 2023,
            model: 'CRV',
            manufacturer: 'honda',
            type: 'SUV',
          });
        },
        check: (results) => {
          expect(results).toHaveLength(4);
        },
      },
    ]);
  });
});

describe('Subqueries in schema', () => {
  let db: DB<any>;
  beforeEach(async () => {
    db = new DB({
      schema: {
        collections: {
          departments: {
            schema: S.Schema({
              id: S.String(),
              name: S.String(),
              num_faculty: S.Number(),
              classes: S.RelationMany('classes', {
                where: [['department_id', '=', '$id']],
              }),
              dept_head_id: S.String(),
              dept_head: S.RelationById('faculty', '$dept_head_id'),
            }),
          },
          classes: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
              level: S.Number(),
              building: S.String(),
              department_id: S.String(),
              department: S.RelationById('departments', '$department_id'),
            }),
          },
          faculty: {
            schema: S.Schema({
              id: S.Id(),
              name: S.String(),
            }),
          },
        },
      },
    });

    const faculty = [
      { id: '1', name: 'Dr. Smith' },
      { id: '2', name: 'Dr. Johnson' },
      { id: '3', name: 'Dr. Lee' },
      { id: '4', name: 'Dr. Brown' },
    ];
    const departments = [
      { name: 'CS', num_faculty: 5, dept_head_id: '1' },
      { name: 'Math', num_faculty: 10, dept_head_id: '2' },
      { name: 'English', num_faculty: 15, dept_head_id: '3' },
      { name: 'History', num_faculty: 10, dept_head_id: '4' },
    ];
    const classes = [
      {
        name: 'CS 101',
        level: 100,
        building: 'Warner',
        department_id: 'CS',
      },
      {
        name: 'CS 201',
        level: 200,
        building: 'Warner',
        department_id: 'CS',
      },
      {
        name: 'CS 301',
        level: 300,
        building: 'Warner',
        department_id: 'CS',
      },
      {
        name: 'Math 101',
        level: 100,
        building: 'BiHall',
        department_id: 'Math',
      },
      {
        name: 'Math 201',
        level: 200,
        building: 'BiHall',
        department_id: 'Math',
      },
      {
        name: 'Math 301',
        level: 300,
        building: 'BiHall',
        department_id: 'Math',
      },
      {
        name: 'English 101',
        level: 100,
        building: 'Twilight',
        department_id: 'English',
      },
      {
        name: 'English 201',
        level: 200,
        building: 'Twilight',
        department_id: 'English',
      },
      {
        name: 'English 301',
        level: 300,
        building: 'Twilight',
        department_id: 'English',
      },
      {
        name: 'History 101',
        level: 100,
        building: 'Voter',
        department_id: 'History',
      },
      {
        name: 'History 201',
        level: 200,
        building: 'Voter',
        department_id: 'History',
      },
      {
        name: 'History 301',
        level: 300,
        building: 'Voter',
        department_id: 'History',
      },
    ];
    for (const f of faculty) {
      await db.insert('faculty', f);
    }
    for (const department of departments) {
      await db.insert('departments', { id: department.name, ...department });
    }
    for (const cls of classes) {
      await db.insert('classes', cls);
    }
  });

  it('can query a subquery in a schema', async () => {
    // test finding all departments in a Voter
    const results = await db.fetch(
      db
        .query('departments')
        .where([['classes.building', '=', 'Voter']])
        .build()
    );

    expect(results).toHaveLength(1);
  });

  it('can query a subquery in a transaction', async () => {
    // test finding all departments in a Voter
    await db.transact(async (tx) => {
      const results = await tx.fetch(
        db
          .query('departments')
          .where([['classes.building', '=', 'Voter']])
          .build()
      );

      expect(results).toHaveLength(1);
    });
  });

  it('can query a subquery with a set attribute', async () => {
    // find classes in the CS deparment
    const results = await db.fetch(
      db
        .query('classes')
        .where([['department.name', '=', 'CS']])
        .build()
    );

    expect(results).toHaveLength(3);
  });

  it('can query a subquery within a subscription', async () => {
    // find classes in the CS deparment
    const query = db
      .query('classes')
      .where([['department.name', '=', 'CS']])
      .build();

    await testSubscription(db, query, [
      {
        check: (results) => {
          expect(results).toHaveLength(3);
        },
      },
      {
        action: async () => {
          await db.insert('classes', {
            id: 'CS 401',
            name: 'CS 401',
            level: 400,
            building: 'Warner',
            department_id: 'CS',
          });
        },
        check: (results) => {
          expect(results).toHaveLength(4);
        },
      },
    ]);
  });

  it('can order query by a relation', async () => {
    const query = db
      .query('classes')
      .order(['department.name', 'ASC'], ['name', 'ASC'])
      .build();
    const results = await db.fetch(query);
    const classNames = Array.from(results.values()).map(
      (result) => result.name
    );
    expect(classNames).toEqual([
      'CS 101',
      'CS 201',
      'CS 301',
      'English 101',
      'English 201',
      'English 301',
      'History 101',
      'History 201',
      'History 301',
      'Math 101',
      'Math 201',
      'Math 301',
    ]);
  });

  it('can order query by a relation - mulitple related clauses', async () => {
    const query = db
      .query('classes')
      .order(
        ['department.num_faculty', 'ASC'],
        ['department.name', 'ASC'],
        ['name', 'ASC']
      )
      .build();
    const results = await db.fetch(query);
    const classNames = Array.from(results.values()).map(
      (result) => result.name
    );
    expect(classNames).toEqual([
      'CS 101',
      'CS 201',
      'CS 301',
      'History 101',
      'History 201',
      'History 301',
      'Math 101',
      'Math 201',
      'Math 301',
      'English 101',
      'English 201',
      'English 301',
    ]);
  });

  it('can order by deep relation', async () => {
    const query = db
      .query('classes')
      .order(['department.dept_head.name', 'ASC'], ['name', 'ASC'])
      .build();
    const results = await db.fetch(query);
    const classNames = Array.from(results.values()).map(
      (result) => result.name
    );
    expect(classNames).toEqual([
      'History 101',
      'History 201',
      'History 301',
      'Math 101',
      'Math 201',
      'Math 301',
      'English 101',
      'English 201',
      'English 301',
      'CS 101',
      'CS 201',
      'CS 301',
    ]);
  });

  it('order by cardinality many will throw error', async () => {
    const query = db
      .query('departments')
      .order(['classes.name', 'ASC'])
      .build();
    await expect(db.fetch(query)).rejects.toThrow(InvalidOrderClauseError);
  });

  it('order by non leaf will throw error', async () => {
    const query = db.query('classes').order(['department', 'ASC']).build();
    await expect(db.fetch(query)).rejects.toThrow(InvalidOrderClauseError);
  });

  it('order by relation with subscription', async () => {
    const query = db
      .query('classes')
      .order(['department.name', 'ASC'], ['name', 'ASC'])
      .build();

    await testSubscription(db, query, [
      {
        check: (results) => {
          const classNames = Array.from(results.values()).map(
            (result) => result.name
          );
          expect(classNames).toEqual([
            'CS 101',
            'CS 201',
            'CS 301',
            'English 101',
            'English 201',
            'English 301',
            'History 101',
            'History 201',
            'History 301',
            'Math 101',
            'Math 201',
            'Math 301',
          ]);
        },
      },
      {
        action: async () => {
          await db.insert('classes', {
            id: 'CS 401',
            name: 'CS 401',
            level: 400,
            building: 'Warner',
            department_id: 'CS',
          });
        },
        check: (results) => {
          const classNames = Array.from(results.values()).map(
            (result) => result.name
          );
          expect(classNames).toEqual([
            'CS 101',
            'CS 201',

            'CS 301',
            'CS 401',
            'English 101',
            'English 201',
            'English 301',
            'History 101',
            'History 201',
            'History 301',
            'Math 101',
            'Math 201',
            'Math 301',
          ]);
        },
      },
    ]);
  });
});

describe('social network test', () => {
  let db: DB<any>;
  beforeAll(async () => {
    db = new DB({
      schema: {
        collections: {
          users: {
            schema: S.Schema({
              id: S.String(),
              name: S.String(),
              friend_ids: S.Set(S.String()),
              friends: S.Query({
                collectionName: 'users',
                where: [['id', 'in', '$friend_ids']],
              }),
              posts: S.Query({
                collectionName: 'posts',
                where: [['author_id', '=', '$id']],
              }),
            }),
          },
          posts: {
            schema: S.Schema({
              id: S.String(),
              content: S.String(),
              author_id: S.String(),
              author: S.RelationById('users', '$author_id'),
            }),
          },
        },
      },
    });
    // insert sample data
    await db.insert('users', {
      id: 'user-1',
      name: 'Alice',
      friend_ids: new Set(['user-2', 'user-3']),
    });
    await db.insert('users', {
      id: 'user-2',
      name: 'Bob',
      friend_ids: new Set(['user-1', 'user-3']),
    });
    await db.insert('users', {
      id: 'user-3',
      name: 'Charlie',
      friend_ids: new Set(['user-1', 'user-2']),
    });
    await db.insert('posts', {
      id: 'post-1',
      content: 'Hello World!',
      author_id: 'user-1',
    });
    await db.insert('posts', {
      id: 'post-2',
      content: 'Hello World!',
      author_id: 'user-2',
    });
    await db.insert('posts', {
      id: 'post-3',
      content: 'Hello World!',
      author_id: 'user-3',
    });
  });

  it('can query posts from friends', async () => {
    const userDb = db.withVars({ USER_ID: 'user-1' });
    const query = userDb
      .query('posts')
      .where([['author.friend_ids', '=', '$USER_ID']])
      .build();
    const results = await userDb.fetch(query);
    expect(results).toHaveLength(2);
  });
});

describe('state vector querying', () => {
  it('respects rules when fetching after some state vector', async () => {
    const db = new DB({
      schema: {
        collections: {
          posts: {
            schema: S.Schema({
              id: S.String(),
              author_id: S.String(),
              content: S.String(),
            }),
            rules: {
              read: {
                'post-author': {
                  description: 'Users can only read posts they authored',
                  filter: [['author_id', '=', '$user_id']],
                },
              },
            },
          },
        },
      },
    });
    const user_id = 'user-1';
    const user_id2 = 'user-2';
    const post_id = 'post-1';
    const post_id2 = 'post-2';
    await db.insert('posts', { id: post_id, author_id: user_id, content: '' });
    await db.insert('posts', {
      id: post_id2,
      author_id: user_id2,
      content: '',
    });
    const query = db.query('posts').build();
    const userDB = db.withVars({ user_id });
    const results = await userDB.fetchTriples(query);
    const resultEntities = results.reduce(
      (entitySet: Set<string>, triple: TripleRow) => {
        entitySet.add(stripCollectionFromId(triple.id));
        return entitySet;
      },
      new Set()
    );

    expect(resultEntities).toHaveLength(1);
    expect(resultEntities).toContain(post_id);

    const stateVector = triplesToStateVector(results);
    const { txId } = await db.insert('posts', {
      id: 'post-3',
      author_id: user_id2,
      content: '',
    });
    const clientStates = new Map(
      (stateVector ?? []).map(([sequence, client]) => [client, sequence])
    );
    const callback = vi.fn();
    const unsub = userDB.subscribeTriples(query, callback, () => {}, {
      stateVector: clientStates,
    });
    await pause(10);
    unsub();
    expect(callback).toHaveBeenCalledTimes(1);
    const results2 = callback.mock.calls[0][0];
    const result2Entities = results2.reduce(
      (entitySet: Set<string>, triple: TripleRow) => {
        entitySet.add(stripCollectionFromId(triple.id));
        return entitySet;
      },
      new Set()
    );
    expect(result2Entities).toHaveLength(0);
  });
  it.todo('works with relational querying', async () => {
    const db = new DB({
      schema: {
        collections: {
          users: {
            schema: S.Schema({
              id: S.String(),
              name: S.String(),
              friend_ids: S.Set(S.String()),
              posts: S.RelationMany('posts', {
                where: [['author_id', '=', '$id']],
              }),
            }),
          },
          posts: {
            schema: S.Schema({
              id: S.String(),
              content: S.String(),
              author_id: S.String(),
            }),
          },
        },
      },
    });
    const user_id = 'user-1';
    const user_id2 = 'user-2';
    const post_id = 'post-1';
    const post_id2 = 'post-2';
    await db.insert('users', { id: user_id, name: 'Alice' });
    await db.insert('users', { id: user_id2, name: 'Bob' });
    await db.insert('posts', { id: post_id, author_id: user_id, content: '' });
    await db.insert('posts', {
      id: post_id2,
      author_id: user_id2,
      content: '',
    });
    const query = db.query('users').include('posts').build();
    const initialTriples = await db.fetchTriples(query);
    const stateVector = triplesToStateVector(initialTriples);
    await db.insert('posts', { id: 'post-3', author_id: user_id, content: '' });
    const queryStateVector = stateVector.reduce(
      (stateVector, [sequence, client]) => {
        stateVector.set(client, sequence);
        return stateVector;
      },
      new Map<string, number>()
    );
    // const afterTriples = await fetchDeltaTriplesFromStateVector(
    //   db.tripleStore,
    //   query,
    //   queryStateVector
    // );
    // TODO add expect / assertions
  });
});

describe('delta querying', async () => {
  describe('simple single collection queries', () => {
    const db = new DB({
      schema: {
        collections: {
          posts: {
            schema: S.Schema({
              id: S.String(),
              author_id: S.String(),
              content: S.String(),
            }),
          },
        },
      },
    });
    const user_id = 'user-1';
    const user_id2 = 'user-2';
    const post_id = 'post-1';
    const post_id2 = 'post-2';
    beforeEach(async () => {
      db.clear();
      await db.insert('posts', {
        id: post_id,
        author_id: user_id,
        content: '',
      });
      await db.insert('posts', {
        id: post_id2,
        author_id: user_id2,
        content: '',
      });
    });

    it('can fetch delta triples', async () => {
      const query = db.query('posts').where('author_id', '=', user_id).build();

      const addedTriples: TripleRow[] = [];
      db.tripleStore.onInsert((newTriples) => {
        addedTriples.push(...[...Object.values(newTriples)].flat());
      });
      await db.insert('posts', {
        id: 'post-3',
        author_id: user_id,
        content: '',
      });
      await db.insert('posts', {
        id: 'post-4',
        author_id: user_id2,
        content: '',
      });

      const deltaTriples = await fetchDeltaTriples(
        db.tripleStore,
        query,
        addedTriples,
        (
          await db.getSchema()
        )?.collections
      );
      expect(deltaTriples.length).toBeGreaterThan(0);
      expect(
        new Set(deltaTriples.map((triple) => stripCollectionFromId(triple.id)))
      ).toEqual(new Set(['post-3']));
    });

    it('captures deletes in delta triples', async () => {
      const query = db.query('posts').where('author_id', '=', user_id).build();

      const addedTriples: TripleRow[] = [];
      db.tripleStore.onInsert((newTriples) => {
        addedTriples.push(...[...Object.values(newTriples)].flat());
      });
      await db.delete('posts', post_id);

      const deltaTriples = await fetchDeltaTriples(
        db.tripleStore,
        query,
        addedTriples,
        (
          await db.getSchema()
        )?.collections
      );
      expect(deltaTriples.length).toBeGreaterThan(0);
      expect(
        new Set(deltaTriples.map((triple) => stripCollectionFromId(triple.id)))
      ).toEqual(new Set([post_id]));
    });

    it('captures invalidated results in delta triples', async () => {
      const query = db.query('posts').where('author_id', '=', user_id).build();

      const addedTriples: TripleRow[] = [];
      db.tripleStore.onInsert((newTriples) => {
        addedTriples.push(...[...Object.values(newTriples)].flat());
      });

      await db.update('posts', post_id, async (entity) => {
        entity.author_id = user_id2;
      });
      const deltaTriples = await fetchDeltaTriples(
        db.tripleStore,
        query,
        addedTriples,
        (
          await db.getSchema()
        )?.collections
      );
      expect(deltaTriples.length).toBeGreaterThan(0);
      expect(
        new Set(deltaTriples.map((triple) => stripCollectionFromId(triple.id)))
      ).toEqual(new Set([post_id]));
    });

    it('only returns relevant delta triples', async () => {
      const query = db.query('posts').where('author_id', '=', user_id).build();

      const addedTriples: TripleRow[] = [];
      db.tripleStore.onInsert((newTriples) => {
        addedTriples.push(...[...Object.values(newTriples)].flat());
      });
      await db.insert('posts', {
        id: 'post-4',
        author_id: user_id2,
        content: '',
      });
      const deltaTriples = await fetchDeltaTriples(
        db.tripleStore,
        query,
        addedTriples,
        (
          await db.getSchema()
        )?.collections
      );
      expect(deltaTriples).toHaveLength(0);
    });
  });

  describe('relational queries', () => {
    const schema = {
      collections: {
        users: {
          schema: S.Schema({
            id: S.String(),
            name: S.String(),
            friend_ids: S.Set(S.String()),
            friends: S.RelationMany('users', {
              where: [['id', 'in', '$friend_ids']],
            }),
            posts: S.RelationMany('posts', {
              where: [['author_id', '=', '$id']],
            }),
          }),
        },
        posts: {
          schema: S.Schema({
            id: S.String(),
            content: S.String(),
            created_at: S.Date(),
            author_id: S.String(),
            author: S.RelationById('users', '$author_id'),
          }),
        },
      },
    };

    const insertSampleData = async (db) => {
      // insert some test data
      await db.insert('users', {
        id: 'user-1',
        name: 'Alice',
        friend_ids: new Set(['user-2', 'user-3']),
      });
      await db.insert('users', {
        id: 'user-2',
        name: 'Bob',
        friend_ids: new Set(['user-1', 'user-3']),
      });
      await db.insert('users', {
        id: 'user-3',
        name: 'Charlie',
        friend_ids: new Set(['user-1', 'user-2']),
      });
      await db.insert('posts', {
        id: 'post-1',
        author_id: 'user-1',
        content: '',
        created_at: new Date('2022-06-01'),
      });
      await db.insert('posts', {
        id: 'post-2',
        author_id: 'user-2',
        content: '',
        created_at: new Date('2022-01-01'),
      });
      await db.insert('posts', {
        id: 'post-3',
        author_id: 'user-3',
        content: '',
        created_at: new Date('2022-03-01'),
      });
    };

    it('can fetch delta triples', async () => {
      const db = new DB({ schema });
      await insertSampleData(db);
      const query = db
        .query('users')
        .where('posts.created_at', '>', new Date('2022-05-01'))
        .build();
      const initialTriples = await db.fetchTriples(query);
      expect(initialTriples.length).toBeGreaterThan(0);

      const addedTriples: TripleRow[] = [];
      db.tripleStore.onInsert((newTriples) => {
        addedTriples.push(...[...Object.values(newTriples)].flat());
      });

      // insert another post after the queried date
      await db.insert('posts', {
        id: 'post-4',
        author_id: 'user-2',
        content: '',
        created_at: new Date('2022-06-02'),
      });
      const fetchQuery = prepareQuery(query, schema['collections'], {});
      const deltaTriples = await fetchDeltaTriples(
        db.tripleStore,
        fetchQuery,
        addedTriples,
        (
          await db.getSchema()
        )?.collections
      );
      expect(deltaTriples.length).toBeGreaterThan(0);
      expect(deltaTriples).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'posts#post-4' }),
        ])
      );
    });
    it('ignores irrelevant delta triples', async () => {
      const db = new DB({ schema });
      await insertSampleData(db);
      const query = db
        .query('users')
        .where('posts.created_at', '>', new Date('2022-05-01'))
        .build();
      const initialTriples = await db.fetchTriples(query);
      expect(initialTriples.length).toBeGreaterThan(0);

      const addedTriples: TripleRow[] = [];
      db.tripleStore.onInsert((newTriples) => {
        addedTriples.push(...[...Object.values(newTriples)].flat());
      });
      // insert another post after the queried date
      await db.insert('posts', {
        id: 'post-4',
        author_id: 'user-2',
        content: '',
        created_at: new Date('2022-01-02'),
      });

      const fetchQuery = prepareQuery(query, schema['collections'], {});
      const deltaTriples = await fetchDeltaTriples(
        db.tripleStore,
        fetchQuery,
        addedTriples,
        (
          await db.getSchema()
        )?.collections
      );

      expect(deltaTriples.length).toBe(0);
    });
  });

  describe('sync queries', async () => {
    // create two databases with a shared relational schema
    const schema = {
      collections: {
        users: {
          schema: S.Schema({
            id: S.String(),
            name: S.String(),
            friend_ids: S.Set(S.String()),
            friends: S.RelationMany('users', {
              where: [['id', 'in', '$friend_ids']],
            }),
            posts: S.RelationMany('posts', {
              where: [['author_id', '=', '$id']],
            }),
          }),
        },
        posts: {
          schema: S.Schema({
            id: S.String(),
            content: S.String(),
            created_at: S.Date(),
            author_id: S.String(),
            author: S.RelationById('users', '$author_id'),
          }),
        },
      },
    };
    const insertSampleData = async (db) => {
      // insert some test data
      await db.insert('users', {
        id: 'user-1',
        name: 'Alice',
        friend_ids: new Set(['user-2', 'user-3']),
      });
      await db.insert('users', {
        id: 'user-2',
        name: 'Bob',
        friend_ids: new Set(['user-1', 'user-3']),
      });
      await db.insert('users', {
        id: 'user-3',
        name: 'Charlie',
        friend_ids: new Set(['user-1', 'user-2']),
      });
      await db.insert('posts', {
        id: 'post-1',
        author_id: 'user-1',
        content: '',
        created_at: new Date('2022-06-01'),
      });
      await db.insert('posts', {
        id: 'post-2',
        author_id: 'user-2',
        content: '',
        created_at: new Date('2022-01-01'),
      });
      await db.insert('posts', {
        id: 'post-3',
        author_id: 'user-3',
        content: '',
        created_at: new Date('2022-03-01'),
      });
    };
    const QUERIES = [
      {
        query: (db) => db.query('users').build(),
        description: 'fetch all users',
      },
      {
        query: (db) =>
          db.query('posts').where('author.name', 'like', 'Alice%').build(),
        description: 'fetch all posts by users with name like Alice',
      },
      {
        description: 'Fetch posts from friends of user-1',
        query: (db) =>
          db.query('posts').where('author.friend_ids', '=', 'user-1').build(),
      },
      {
        description: 'Fetch posts from friends of Alice',
        query: (db) =>
          db
            .query('posts')
            .where('author.friends.name', 'like', 'Alice%')
            .build(),
      },
      {
        description: 'Fetch posts from friends of both Alice and Bob',
        query: (db) =>
          db
            .query('posts')
            .where(
              and([
                ['author.friends.name', 'like', 'Alice%'],
                ['author.friends.name', 'like', 'David%'],
              ])
            )
            .build(),
      },
      {
        description: 'Fetch users and include their posts',
        query: (db) => db.query('users').include('posts').build(),
      },
    ];
    describe.each(QUERIES)('$description', ({ query }) => {
      const MUTATIONS = [
        {
          description: 'insert a new user',
          action: async (db) => {
            await db.insert('users', {
              id: 'user-4',
              name: 'David',
              friend_ids: new Set(['user-1', 'user-2']),
            });
          },
        },
        {
          description: 'insert a new post',
          action: async (db) => {
            await db.insert('posts', {
              id: 'post-4',
              author_id: 'user-4',
              content: '',
              created_at: new Date('2022-06-01'),
            });
          },
        },
        {
          description: 'update a user',
          action: async (db) => {
            await db.update('users', 'user-1', (user) => {
              user.name = 'Alice Smith';
            });
          },
        },
        {
          description: 'delete a user',
          action: async (db) => {
            await db.delete('users', 'user-1');
          },
        },
        {
          description: 'delete a post',
          action: async (db) => {
            await db.delete('posts', 'post-1');
          },
        },
      ];
      it.each(MUTATIONS)('$description', async ({ action, description }) => {
        const serverDB = new DB({ schema });
        const clientDB = new DB({ schema });
        await insertSampleData(serverDB);

        const initialTriples = await serverDB.fetchTriples(query(serverDB));
        await clientDB.tripleStore.insertTriples(initialTriples);

        const addedTriples: TripleRow[] = [];
        serverDB.tripleStore.onInsert((newTriples) => {
          addedTriples.push(...[...Object.values(newTriples)].flat());
        });

        await action(serverDB);

        const fetchQuery = prepareQuery(
          query(clientDB),
          schema['collections'],
          {}
        );
        const deltaTriples = await fetchDeltaTriples(
          serverDB.tripleStore,
          fetchQuery,
          addedTriples,
          (
            await serverDB.getSchema()
          )?.collections
        );

        await clientDB.tripleStore.insertTriples(deltaTriples);
        const clientResults = await clientDB.fetch(query(clientDB));
        const serverResults = await serverDB.fetch(query(serverDB));
        expect(clientResults).toEqual(serverResults);
      });
    });
  });
});

/**
 * This tests the power of the query engine to handle complex relational queries
 * This test focuses on the classic graph example of aviation routes
 */
describe('Graph-like queries', () => {
  const db = new DB();
  beforeAll(async () => {
    // Insert a bunch of airplane, airport, and flights mock data
    // Airplanes - Contains a make, model, and capacity
    const airplanes = [
      { make: 'Boeing', model: '737', capacity: 200 },
      { make: 'Boeing', model: '747', capacity: 400 },
      { make: 'Airbus', model: 'A320', capacity: 200 },
      { make: 'Airbus', model: 'A380', capacity: 400 },
    ];
    for (const airplane of airplanes) {
      await db.insert('airplanes', {
        ...airplane,
        id: `${airplane.make}-${airplane.model}`,
      });
    }
    // Airports - Contains a name and location
    const airports = [
      { name: 'SFO', location: 'San Francisco, CA' },
      { name: 'LAX', location: 'Los Angeles, CA' },
      { name: 'JFK', location: 'New York, NY' },
      { name: 'ORD', location: 'Chicago, IL' },
    ];
    for (const airport of airports) {
      await db.insert('airports', airport);
    }
    // Flights - Contains a flight number, airplane, origin, and destination
    const flights = [
      {
        flight_number: 'UA-1',
        airplane: 'Boeing-737',
        origin: 'SFO',
        destination: 'JFK',
      },
      {
        flight_number: 'UA-2',
        airplane: 'Boeing-737',
        origin: 'JFK',
        destination: 'SFO',
      },
      {
        flight_number: 'UA-3',
        airplane: 'Boeing-747',
        origin: 'SFO',
        destination: 'ORD',
      },
      {
        flight_number: 'UA-4',
        airplane: 'Boeing-747',
        origin: 'ORD',
        destination: 'SFO',
      },
      {
        flight_number: 'UA-5',
        airplane: 'Airbus-A320',
        origin: 'SFO',
        destination: 'LAX',
      },
      {
        flight_number: 'UA-6',
        airplane: 'Airbus-A320',
        origin: 'LAX',
        destination: 'SFO',
      },
      {
        flight_number: 'UA-7',
        airplane: 'Airbus-A380',
        origin: 'SFO',
        destination: 'JFK',
      },
      {
        flight_number: 'UA-8',
        airplane: 'Airbus-A380',
        origin: 'JFK',
        destination: 'SFO',
      },
    ];
    for (const flight of flights) {
      await db.insert('flights', flight);
    }
  });

  it('can handle a deeply nested subquery', async () => {
    // Find all plane models that have flown to 'San Francisco, CA' from non-CA airports
    const query = db
      .query('airplanes')
      .where([
        {
          exists: db
            .query('flights')
            .where([
              ['airplane', '=', '$id'],
              {
                exists: db
                  .query('airports')
                  .where([
                    ['name', '=', '$origin'],
                    ['location', 'nlike', '%, CA'],
                    {
                      exists: db
                        .query('airports')
                        .where([
                          ['name', '=', '$destination'],
                          ['location', '=', 'San Francisco, CA'],
                        ])
                        .build(),
                    },
                  ])
                  .build(),
              },
            ])
            .build(),
        },
      ])
      .build();

    const result = await db.fetch(query);
    expect(Array.from(result.keys())).toEqual([
      'Airbus-A380',
      'Boeing-737',
      'Boeing-747',
    ]);
  });
});

describe('sessions', () => {
  it('can create scoped variables with sessions that leave the original variables unaffected', () => {
    const db = new DB();
    expect(db.variables).toEqual({});
    {
      const session = db.withVars({ foo: 'bar' });
      expect(session.variables).toEqual({ foo: 'bar' });
      expect(db.variables).toEqual({});
    }
    {
      const session = db
        .withVars({ foo: 'bar' })
        .withVars({ bar: 'baz' })
        .withVars({ foo: 'baz' });
      expect(session.variables).toEqual({ foo: 'baz', bar: 'baz' });
      expect(db.variables).toEqual({});
    }
  });

  it('can create multiple sessions and use their variables in queries independently', async () => {
    const db = new DB();
    const sessionFoo = db.withVars({ name: 'foo' });
    const sessionBar = db.withVars({ name: 'bar' });

    // Insert some data
    await sessionFoo.insert('test', { id: '1', name: 'bar', visible: false });
    await sessionBar.insert('test', { id: '2', name: 'foo', visible: true });
    await db.insert('test', { id: '3', bar: 'baz', visible: true });

    const query = db
      .query('test')
      .where(['name', '=', '$name'], ['visible', '=', true])
      .build();

    {
      expect(await db.fetch(db.query('test').build())).toHaveLength(3);
    }

    {
      const resp = await sessionFoo.fetch(query);
      expect(resp).toHaveLength(1);
      expect(resp.get('2')).toMatchObject({
        id: '2',
        name: 'foo',
        visible: true,
      });
    }
    {
      const resp = await sessionBar.fetch(query);
      expect(resp).toHaveLength(0);
    }
  });
});

describe('selecting subqueries', () => {
  const db = new DB({
    schema: {
      collections: {
        users: {
          schema: S.Schema({
            id: S.String(),
            name: S.String(),
            friend_ids: S.Set(S.String()),
            liked_post_ids: S.Set(S.String()),
          }),
        },
        posts: {
          schema: S.Schema({
            id: S.String(),
            content: S.String(),
            author_id: S.String(),
            topics: S.Set(S.String()),
          }),
        },
      },
    },
  });
  beforeAll(async () => {
    await db.insert('users', {
      id: 'user-1',
      name: 'Alice',
      friend_ids: new Set(['user-2', 'user-3']),
      liked_post_ids: new Set(['post-1']),
    });
    await db.insert('users', {
      id: 'user-2',
      name: 'Bob',
      friend_ids: new Set(['user-1', 'user-3']),
      liked_post_ids: new Set(['post-1']),
    });
    await db.insert('users', {
      id: 'user-3',
      name: 'Charlie',
      friend_ids: new Set(['user-1', 'user-2']),
      liked_post_ids: new Set(['post-1']),
    });
    await db.insert('posts', {
      id: 'post-1',
      content: 'Hello World!',
      author_id: 'user-1',
      topics: new Set(['comedy', 'sports']),
    });
    await db.insert('posts', {
      id: 'post-2',
      content: 'Hello World!',
      author_id: 'user-2',
    });
    await db.insert('posts', {
      id: 'post-3',
      content: 'Hello World!',
      author_id: 'user-3',
    });
  });
  it('can select subqueries', async () => {
    const query = db
      .query('users')
      .select([
        'id',
        {
          attributeName: 'posts',
          subquery: db
            .query('posts', {
              where: [['author_id', '=', '$id']],
            })
            .build(),
          cardinality: 'many',
        },
      ])
      .build();
    const result = await db.fetch(query);
    expect(result.get('user-1')).toHaveProperty('posts');
    expect(result.get('user-1').posts).toHaveLength(1);
    expect(result.get('user-1').posts.get('post-1')).toMatchObject({
      id: 'post-1',
      content: 'Hello World!',
      author_id: 'user-1',
      topics: new Set(['comedy', 'sports']),
    });
  });

  it('can select nested subqueries', async () => {
    const query = db
      .query('users')
      .select([
        'id',
        {
          attributeName: 'posts',
          subquery: db
            .query('posts', {
              where: [['author_id', '=', '$id']],
            })
            .select([
              'id',
              {
                attributeName: 'likedBy',
                subquery: db
                  .query('users', {
                    where: [['liked_post_ids', '=', '$id']],
                  })
                  .build(),
                cardinality: 'many',
              },
            ])
            .build(),
          cardinality: 'many',
        },
      ])
      .build();
    const result = await db.fetch(query);
    expect(result.get('user-1')).toHaveProperty('posts');
    expect(result.get('user-1')!.posts).toHaveLength(1);
    expect(result.get('user-1')!.posts.get('post-1').likedBy).toBeDefined();
    expect(result.get('user-1')!.posts.get('post-1').likedBy).toHaveLength(3);
  });

  it('can subscribe with subqueries', async () => {
    const query = db
      .query('users')
      .select([
        'id',
        {
          attributeName: 'posts',
          subquery: db
            .query('posts', {
              where: [['author_id', '=', '$id']],
            })
            .build(),
          cardinality: 'many',
        },
      ])
      .build();
    await testSubscription(db, query, [
      {
        check: (results) => {
          expect(results).toHaveLength(3);
          expect(results.get('user-1')).toHaveProperty('posts');
          expect(results.get('user-1').posts).toHaveLength(1);
          expect(results.get('user-1').posts.get('post-1')).toMatchObject({
            id: 'post-1',
            content: 'Hello World!',
            author_id: 'user-1',
            topics: new Set(['comedy', 'sports']),
          });
        },
      },
      {
        action: async () => {
          await db.insert('posts', {
            id: 'post-4',
            content: 'Hello World!',
            author_id: 'user-1',
          });
        },
        check: (results) => {
          expect(results).toHaveLength(3);
          expect(results.get('user-1')).toHaveProperty('posts');
          expect(results.get('user-1')!.posts).toHaveLength(2);
          expect(results.get('user-1')!.posts.get('post-4')).toMatchObject({
            id: 'post-4',
            content: 'Hello World!',
            author_id: 'user-1',
          });
        },
      },
    ]);
  });

  it('can select a singleton via a subquery', async () => {
    const query = db
      .query('users')
      .select([
        'id',
        {
          attributeName: 'favoritePost',
          subquery: db
            .query('posts', {
              where: [['author_id', '=', '$id']],
            })
            .build(),
          cardinality: 'one',
        },
      ])
      .build();
    const result = await db.fetch(query);
    expect(result.get('user-1')).toHaveProperty('favoritePost');
    expect(result.get('user-1').favoritePost).toMatchObject({
      id: 'post-1',
      content: 'Hello World!',
      author_id: 'user-1',
      topics: new Set(['comedy', 'sports']),
    });
  });
  it('should return null or undefined if a singleton subquery has no results', async () => {
    const query = db
      .query('users')
      .select([
        'id',
        {
          attributeName: 'favoritePost',
          subquery: db
            .query('posts', {
              where: [['author_id', '=', 'george']],
            })
            .build(),
          cardinality: 'one',
        },
      ])
      .build();
    const result = await db.fetch(query);
    expect(result.get('user-1')).toHaveProperty('favoritePost');
    expect(result.get('user-1').favoritePost).toEqual(null);
  });
});

describe('selecting subqueries from schema', () => {
  const db = new DB({
    schema: {
      collections: {
        users: {
          schema: S.Schema({
            id: S.String(),
            name: S.String(),
            friend_ids: S.Set(S.String()),
            posts: S.Query({
              collectionName: 'posts' as const,
              where: [['author_id', '=', '$id']],
            }),
            friends: S.Query({
              collectionName: 'users' as const,
              where: [['id', 'in', '$friend_ids']],
            }),
            likes: S.Query({
              collectionName: 'likes' as const,
              where: [['user_id', '=', '$id']],
            }),
          }),
        },
        posts: {
          schema: S.Schema({
            id: S.String(),
            content: S.String(),
            author_id: S.String(),
            author: S.RelationById('users', '$author_id'),
            topics: S.Set(S.String()),
            likes: S.Query({
              collectionName: 'likes' as const,
              where: [['post_id', '=', '$id']],
            }),
          }),
          rules: {
            read: {
              'read your own posts': {
                filter: [['author_id', '=', '$USER_ID']],
              },
            },
          },
        },
        likes: {
          schema: S.Schema({
            id: S.Id(),
            user_id: S.String(),
            post_id: S.String(),
          }),
        },
      },
    },
  });

  beforeAll(async () => {
    await db.insert('users', {
      id: 'user-1',
      name: 'Alice',
      friend_ids: new Set(['user-2', 'user-3']),
    });
    await db.insert('users', {
      id: 'user-2',
      name: 'Bob',
      friend_ids: new Set(['user-1', 'user-3']),
    });
    await db.insert('users', {
      id: 'user-3',
      name: 'Charlie',
      friend_ids: new Set(['user-1', 'user-2']),
    });
    await db.insert('posts', {
      id: 'post-1',
      content: 'Hello World!',
      author_id: 'user-1',
      topics: new Set(['comedy', 'sports']),
    });
    await db.insert('posts', {
      id: 'post-2',
      content: 'Hello World!',
      author_id: 'user-2',
    });
    await db.insert('posts', {
      id: 'post-3',
      content: 'Hello World!',
      author_id: 'user-3',
    });
    await db.insert('likes', {
      id: 'like-1',
      user_id: 'user-1',
      post_id: 'post-1',
    });
    await db.insert('likes', {
      id: 'like-2',
      user_id: 'user-2',
      post_id: 'post-1',
    });
    await db.insert('likes', {
      id: 'like-3',
      user_id: 'user-3',
      post_id: 'post-1',
    });
  });

  const user1DB = db.withVars({ USER_ID: 'user-1' });

  it('can select subqueries', async () => {
    const query = user1DB
      .query('users')
      .include('posts')
      .include('friends', { where: [['name', 'like', '%e']] })
      .build();

    const result = await user1DB.fetch(query);

    // Other fields are included in the selection
    expect(result.get('user-1')).toHaveProperty('name');

    expect(result.get('user-1')).toHaveProperty('posts');
    expect(result.get('user-1')!.posts).toHaveLength(1);
    expect(result.get('user-1')!.posts.get('post-1')).toMatchObject({
      id: 'post-1',
      content: 'Hello World!',
      author_id: 'user-1',
      topics: new Set(['comedy', 'sports']),
    });
    expect(result.get('user-1')!.friends).toHaveLength(1);
    expect(result.get('user-1')!.friends.get('user-3')).toMatchObject({
      id: 'user-3',
      name: 'Charlie',
      friend_ids: new Set(['user-1', 'user-2']),
    });
  });

  it('must use include to select subqueries', async () => {
    const query = user1DB.query('users').build();

    const result = await user1DB.fetch(query);
    expect(result.get('user-1')).not.toHaveProperty('posts');
    expect(result.get('user-1')).not.toHaveProperty('friends');
  });

  it('can include subqueries in fetch by id', async () => {
    const result = (await user1DB.fetchById('users', 'user-1', {
      include: { posts: null },
    }))!;
    expect(result).toHaveProperty('posts');
    expect(result.posts).toHaveLength(1);
    expect(result.posts.get('post-1')).toMatchObject({
      id: 'post-1',
      content: 'Hello World!',
      author_id: 'user-1',
      topics: new Set(['comedy', 'sports']),
    });
  });
  it('can select subsubqueries', async () => {
    const query = user1DB
      .query('users')
      .include('posts', { include: { likes: null } })
      .build();
    const result = await user1DB.fetch(query);
    // Other fields are included in the selection
    expect(result.get('user-1')).toHaveProperty('name');
    expect(result.get('user-1')).toHaveProperty('posts');
    expect(result.get('user-1')!.posts).toHaveLength(1);
    expect(result.get('user-1')!.posts.get('post-1')).toBeDefined();
    // fails
    expect(result.get('user-1')!.posts.get('post-1')?.likes).toBeDefined();
  });
  it('should throw an error if you try to update a subquery', async () => {
    expect(
      async () =>
        await user1DB.update('users', 'user-1', async (entity) => {
          entity.likes = new Set(['like-1', 'like-2']);
        })
    ).rejects.toThrowError();
    expect(
      async () =>
        await user1DB.update('users', 'user-1', async (entity) => {
          entity.posts = { hello: 'world' };
        })
    ).rejects.toThrowError();
  });

  it('correctly applies rules to subqueries', async () => {
    {
      const result = await user1DB.fetch(user1DB.query('posts').build());
      expect(result).toHaveLength(1);
    }
    {
      const result = await user1DB.fetch(
        user1DB.query('users').include('posts').build()
      );
      expect(result).toHaveLength(3);
      expect(result.get('user-1')).toHaveProperty('posts');
      expect(result.get('user-1')!.posts).toHaveLength(1);

      expect(result.get('user-2')).toHaveProperty('posts');
      expect(result.get('user-2')!.posts).toHaveLength(0);

      expect(result.get('user-3')).toHaveProperty('posts');
      expect(result.get('user-3')!.posts).toHaveLength(0);
    }
  });

  it('skipRules option should skip rules for subqueries', async () => {
    const query = db.query('users').include('posts').build();
    {
      const results = await db.fetch(query, { skipRules: false });
      expect([...results.values()].map((user) => user.posts)).toMatchObject([
        new Map(),
        new Map(),
        new Map(),
      ]);
    }

    const results = await db.fetch(query, {
      skipRules: true,
    });
    expect(results).toHaveLength(3);
    expect(results.get('user-1')).toHaveProperty('posts');
    expect(results.get('user-1')!.posts).toHaveLength(1);
    expect(results.get('user-2')).toHaveProperty('posts');
    expect(results.get('user-2')!.posts).toHaveLength(1);
    expect(results.get('user-3')).toHaveProperty('posts');
    expect(results.get('user-3')!.posts).toHaveLength(1);
  });

  it('can select a singleton via a subquery', async () => {
    const query = user1DB.query('posts').include('author').build();
    const result = await user1DB.fetch(query);
    expect(result.get('post-1')).toHaveProperty('author');
    expect(result.get('post-1').author).toMatchObject({
      id: 'user-1',
      name: 'Alice',
      friend_ids: new Set(['user-2', 'user-3']),
    });
  });

  it('will return null if a singleton subquery has no results', async () => {
    const query = user1DB
      .query('posts')
      .include('author', { where: [['id', '=', 'george']] })
      .build();
    const result = await user1DB.fetch(query);
    expect(result.get('post-1')).toHaveProperty('author');
    expect(result.get('post-1').author).toEqual(null);
  });
  it('subscribe to subqueries when using entityId in query', async () => {
    const query = user1DB
      .query('users')
      .entityId('user-1')
      .include('posts')
      .build();
    await testSubscription(user1DB, query, [
      {
        check: (results) => {
          expect(results).toHaveLength(1);
          expect(results.get('user-1')).toHaveProperty('posts');
          expect(results.get('user-1')!.posts).toHaveLength(1);
        },
      },
      {
        action: async () => {
          await user1DB.insert('posts', {
            id: 'post-4',
            content: 'Hello World!',
            author_id: 'user-1',
          });
        },
        check: (results) => {
          expect(results).toHaveLength(1);
          expect(results.get('user-1')).toHaveProperty('posts');
          expect(results.get('user-1')!.posts).toHaveLength(2);
          expect(results.get('user-1')!.posts.get('post-4')).toMatchObject({
            id: 'post-4',
            content: 'Hello World!',
            author_id: 'user-1',
          });
        },
      },
    ]);
  });
});

describe('hooks API', async () => {
  it('before write hooks will run on transaction', async () => {
    const db = new DB();
    const beforeCommitFn = vi.fn();
    db.addTrigger(
      { when: 'beforeCommit', collectionName: 'users' },
      beforeCommitFn
    );
    const beforeInsertFn = vi.fn();
    db.addTrigger(
      { when: 'beforeInsert', collectionName: 'users' },
      beforeInsertFn
    );
    const beforeUpdateFn = vi.fn();
    db.addTrigger(
      { when: 'beforeUpdate', collectionName: 'users' },
      beforeUpdateFn
    );
    const beforeDeleteFn = vi.fn();
    db.addTrigger(
      { when: 'beforeDelete', collectionName: 'users' },
      beforeDeleteFn
    );
    await db.transact(async (tx) => {
      await tx.insert('users', { id: '1', name: 'alice' });
      await tx.insert('users', { id: '2', name: 'bob' });
    });
    expect(beforeCommitFn).toHaveBeenCalledTimes(1);
    expect(beforeCommitFn.mock.calls[0][0].opSet).toStrictEqual({
      inserts: [
        ['users#1', { _collection: 'users', id: '1', name: 'alice' }],
        ['users#2', { _collection: 'users', id: '2', name: 'bob' }],
      ],
      updates: [],
      deletes: [],
    });
    expect(beforeInsertFn).toHaveBeenCalledTimes(2);
    expect(beforeInsertFn.mock.calls[0][0].entity).toStrictEqual({
      _collection: 'users',
      id: '1',
      name: 'alice',
    });
    expect(beforeInsertFn.mock.calls[1][0].entity).toStrictEqual({
      _collection: 'users',
      id: '2',
      name: 'bob',
    });
    expect(beforeUpdateFn).toHaveBeenCalledTimes(0);
    expect(beforeDeleteFn).toHaveBeenCalledTimes(0);
    await db.transact(async (tx) => {
      await tx.update('users', '1', (entity) => {
        entity.name = 'aaron';
      });
      await tx.update('users', '2', (entity) => {
        entity.name = 'blair';
      });
    });
    expect(beforeCommitFn).toHaveBeenCalledTimes(2);
    expect(beforeCommitFn.mock.calls[1][0].opSet).toStrictEqual({
      inserts: [],
      updates: [
        ['users#1', { _collection: 'users', id: '1', name: 'aaron' }],
        ['users#2', { _collection: 'users', id: '2', name: 'blair' }],
      ],
      deletes: [],
    });
    expect(beforeInsertFn).toHaveBeenCalledTimes(2);
    expect(beforeUpdateFn).toHaveBeenCalledTimes(2);
    expect(beforeUpdateFn.mock.calls[0][0].entity).toStrictEqual({
      _collection: 'users',
      id: '1',
      name: 'aaron',
    });
    expect(beforeUpdateFn.mock.calls[1][0].entity).toStrictEqual({
      _collection: 'users',
      id: '2',
      name: 'blair',
    });
    expect(beforeDeleteFn).toHaveBeenCalledTimes(0);
    await db.transact(async (tx) => {
      await tx.delete('users', '1');
      await tx.delete('users', '2');
    });
    expect(beforeCommitFn).toHaveBeenCalledTimes(3);
    const { inserts, updates, deletes } = beforeCommitFn.mock.calls[2][0].opSet;
    expect(inserts).toStrictEqual([]);
    expect(updates).toStrictEqual([]);
    expect(deletes).toMatchObject([
      ['users#1', { id: '1' }],
      ['users#2', { id: '2' }],
    ]);
    expect(beforeInsertFn).toHaveBeenCalledTimes(2);
    expect(beforeUpdateFn).toHaveBeenCalledTimes(2);
    expect(beforeDeleteFn).toHaveBeenCalledTimes(2);
    expect(beforeDeleteFn.mock.calls[0][0].entity).toMatchObject({
      id: '1',
    });
    expect(beforeDeleteFn.mock.calls[1][0].entity).toMatchObject({
      id: '2',
    });
  });
  it('after write hooks will run on transaction', async () => {
    const db = new DB({
      schema: {
        collections: {
          users: {
            schema: S.Schema({
              id: S.String(),
              name: S.String(),
            }),
          },
          tasks: {
            schema: S.Schema({
              id: S.String(),
              text: S.String(),
              due: S.Date(),
              completed: S.Boolean(),
            }),
          },
        },
      },
    });
    const afterCommitFn = vi.fn();
    db.addTrigger({ when: 'afterCommit' }, afterCommitFn);
    const afterInsertFn = vi.fn();
    db.addTrigger(
      { when: 'afterInsert', collectionName: 'users' },
      afterInsertFn
    );
    const afterUpdateFn = vi.fn();
    db.addTrigger(
      { when: 'afterUpdate', collectionName: 'users' },
      afterUpdateFn
    );
    const afterDeleteFn = vi.fn();
    db.addTrigger(
      { when: 'afterDelete', collectionName: 'users' },
      afterDeleteFn
    );

    await db.transact(async (tx) => {
      await tx.insert('users', { id: '1', name: 'alice' });
      await tx.insert('users', { id: '2', name: 'bob' });
    });
    expect(afterCommitFn).toHaveBeenCalledTimes(1);
    expect(afterCommitFn.mock.calls[0][0].opSet).toStrictEqual({
      inserts: [
        ['users#1', { _collection: 'users', id: '1', name: 'alice' }],
        ['users#2', { _collection: 'users', id: '2', name: 'bob' }],
      ],
      updates: [],
      deletes: [],
    });
    expect(afterInsertFn).toHaveBeenCalledTimes(2);
    expect(afterInsertFn.mock.calls[0][0].entity).toStrictEqual({
      _collection: 'users',
      id: '1',
      name: 'alice',
    });
    expect(afterInsertFn.mock.calls[1][0].entity).toStrictEqual({
      _collection: 'users',
      id: '2',
      name: 'bob',
    });
    expect(afterUpdateFn).toHaveBeenCalledTimes(0);
    expect(afterDeleteFn).toHaveBeenCalledTimes(0);
    await db.transact(async (tx) => {
      await tx.update('users', '1', (entity) => {
        entity.name = 'aaron';
      });
      await tx.update('users', '2', (entity) => {
        entity.name = 'blair';
      });
    });
    expect(afterCommitFn).toHaveBeenCalledTimes(2);
    expect(afterCommitFn.mock.calls[1][0].opSet).toStrictEqual({
      inserts: [],
      updates: [
        ['users#1', { _collection: 'users', id: '1', name: 'aaron' }],
        ['users#2', { _collection: 'users', id: '2', name: 'blair' }],
      ],
      deletes: [],
    });
    expect(afterInsertFn).toHaveBeenCalledTimes(2);
    expect(afterUpdateFn).toHaveBeenCalledTimes(2);
    expect(afterUpdateFn.mock.calls[0][0].entity).toStrictEqual({
      _collection: 'users',
      id: '1',
      name: 'aaron',
    });
    expect(afterUpdateFn.mock.calls[1][0].entity).toStrictEqual({
      _collection: 'users',
      id: '2',
      name: 'blair',
    });
    expect(afterDeleteFn).toHaveBeenCalledTimes(0);
    await db.transact(async (tx) => {
      await tx.delete('users', '1');
      await tx.delete('users', '2');
    });
    expect(afterCommitFn).toHaveBeenCalledTimes(3);
    const { inserts, updates, deletes } = afterCommitFn.mock.calls[2][0].opSet;
    expect(inserts).toStrictEqual([]);
    expect(updates).toStrictEqual([]);
    expect(deletes).toMatchObject([
      ['users#1', { id: '1' }],
      ['users#2', { id: '2' }],
    ]);
    expect(afterInsertFn).toHaveBeenCalledTimes(2);
    expect(afterUpdateFn).toHaveBeenCalledTimes(2);
    expect(afterDeleteFn).toHaveBeenCalledTimes(2);
    expect(afterDeleteFn.mock.calls[0][0].entity).toMatchObject({
      id: '1',
    });
    expect(afterDeleteFn.mock.calls[1][0].entity).toMatchObject({
      id: '2',
    });
  });
});

it('clearing a database resets the schema', async () => {
  const schema = {
    collections: {
      test: {
        schema: S.Schema({
          id: S.String(),
          name: S.String(),
        }),
      },
    },
    version: 0,
  };
  const db = new DB({ schema });
  await db.ensureMigrated;

  // Should load schema into cache
  const resultSchema = await db.getSchema();
  const cacheSchema = db.schema!;
  expect(schemaToJSON(resultSchema)).toEqual(schemaToJSON(schema));
  expect(schemaToJSON(cacheSchema)).toEqual(schemaToJSON(schema));

  await db.clear();

  // Should reset schema cache
  const schemaAfterClear = await db.getSchema();
  expect(schemaAfterClear).toEqual(undefined);
});

it('can upsert data with optional properties', async () => {
  const schema = {
    collections: {
      test: {
        schema: S.Schema({
          id: S.String(),
          name: S.Optional(S.String()),
          age: S.Optional(S.Number()),
        }),
      },
    },
  };
  const db = new DB({ schema });

  await db.insert('test', { id: '1', name: 'alice' });
  await db.insert('test', { id: '1', age: 30 });

  const result = await db.fetchById('test', '1');
  expect(result).toStrictEqual({ id: '1', name: 'alice', age: 30 });
});
