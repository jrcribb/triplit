import { describe, expect, it } from 'vitest';
import DB from '../src/db.ts';
import { getCandidateEntityIds } from '../src/collection-query.ts';
import { Schema as S } from '../src/schema/builder.ts';
import { genToArr } from '../src/utils/generator.js';
const testData = [
  { name: 'Alice', score: 100, age: 25 },
  { name: 'Bob', score: 90, age: 25 },
  { name: 'Charlie', score: 95, age: 25 },
  { name: 'David', score: 85, age: 24 },
  { name: 'Eve', score: 90, age: 24 },
  { name: 'Frank', score: 80, age: 24 },
  { name: 'Grace', score: 85, age: 23 },
  { name: 'Hank', score: 75, age: 23 },
  { name: 'Ivy', score: 80, age: 23 },
  { name: 'Jack', score: 70, age: 22 },
  { name: 'Kate', score: 75, age: 22 },
  { name: 'Liam', score: 65, age: 22 },
  { name: 'Mia', score: 70, age: 21 },
  { name: 'Nate', score: 60, age: 21 },
  { name: 'Olive', score: 65, age: 21 },
];

function expectUnorderedArrayEquality(a: any[], b: any[]) {
  expect(a).toHaveLength(b.length);
  for (const item of a) {
    expect(b).toContainEqual(item);
  }
}

const seeds = [
  {
    key: 'noDupes',
    seed: async (db: DB) =>
      await Promise.all(
        testData.map((data, i) => db.insert('tests', { id: `${i}`, ...data }))
      ),
  },
  {
    key: 'dupes',
    seed: async (db: DB) =>
      await Promise.all(
        testData.flatMap((data, i) => [
          db.insert('tests', { id: `${i}`, ...data }),
          db.insert('tests', { id: `${i}`, ...data }),
        ])
      ),
  },
];

describe('candidate selection', () => {
  describe.each(seeds)('with seed $key', ({ key, seed }) => {
    describe('filter index', () => {
      it('selects a candidate based on equality filter', async () => {
        const db = new DB();
        await seed(db);

        // Select Alice
        {
          const query = db.query('tests').where('name', '=', 'Alice').build();
          await db.transact(async (tx) => {
            const { candidates } = await getCandidateEntityIds(
              tx.storeTx,
              query,
              {
                session: {
                  roles: db.sessionRoles,
                  systemVars: db.systemVars,
                },
              }
            );
            expectUnorderedArrayEquality(await genToArr(candidates), [
              'tests#0',
            ]);
          });
        }

        // Select age 24
        {
          const query = db.query('tests').where('age', '=', 24).build();
          await db.transact(async (tx) => {
            const { candidates } = await getCandidateEntityIds(
              tx.storeTx,
              query,
              {
                session: {
                  roles: db.sessionRoles,
                  systemVars: db.systemVars,
                },
              }
            );
            expectUnorderedArrayEquality(await genToArr(candidates), [
              'tests#3',
              'tests#4',
              'tests#5',
            ]);
          });
        }
      });
      it('selects a candidate based on id filter if available', async () => {
        const db = new DB();
        await seed(db);

        // Uses id filter, even though there is another potential match
        {
          const query = db
            .query('tests')
            .where([
              ['age', '=', 25],
              ['id', '=', '0'],
            ])
            .build();
          await db.transact(async (tx) => {
            const { candidates } = await getCandidateEntityIds(
              tx.storeTx,
              query,
              {
                session: {
                  roles: db.sessionRoles,
                  systemVars: db.systemVars,
                },
              }
            );
            expectUnorderedArrayEquality(await genToArr(candidates), [
              'tests#0',
            ]);
          });
        }
      });

      it('selects a candidate based on range filter', async () => {
        const db = new DB();
        await seed(db);

        // lt
        {
          const query = db.query('tests').where('score', '<', 70).build();
          await db.transact(async (tx) => {
            const { candidates } = await getCandidateEntityIds(
              tx.storeTx,
              query,
              {
                session: {
                  roles: db.sessionRoles,
                  systemVars: db.systemVars,
                },
              }
            );
            expectUnorderedArrayEquality(await genToArr(candidates), [
              'tests#11',
              'tests#13',
              'tests#14',
            ]);
          });
        }
        // lte
        {
          const query = db.query('tests').where('score', '<=', 70).build();
          await db.transact(async (tx) => {
            const { candidates } = await getCandidateEntityIds(
              tx.storeTx,
              query,
              {
                session: {
                  roles: db.sessionRoles,
                  systemVars: db.systemVars,
                },
              }
            );
            expectUnorderedArrayEquality(await genToArr(candidates), [
              'tests#9',
              'tests#11',
              'tests#12',
              'tests#13',
              'tests#14',
            ]);
          });
        }
        // gt
        {
          const query = db.query('tests').where('score', '>', 90).build();
          await db.transact(async (tx) => {
            const { candidates } = await getCandidateEntityIds(
              tx.storeTx,
              query,
              {
                session: {
                  roles: db.sessionRoles,
                  systemVars: db.systemVars,
                },
              }
            );
            expectUnorderedArrayEquality(await genToArr(candidates), [
              'tests#0',
              'tests#2',
            ]);
          });
        }
        // gte
        {
          const query = db.query('tests').where('score', '>=', 90).build();
          await db.transact(async (tx) => {
            const { candidates } = await getCandidateEntityIds(
              tx.storeTx,
              query,
              {
                session: {
                  roles: db.sessionRoles,
                  systemVars: db.systemVars,
                },
              }
            );
            expectUnorderedArrayEquality(await genToArr(candidates), [
              'tests#0',
              'tests#1',
              'tests#2',
              'tests#4',
            ]);
          });
        }
      });

      it('uses multiple range filters if operators and attributes match', async () => {
        const db = new DB();
        await seed(db);

        // match
        {
          const query = db
            .query('tests')
            .where([
              ['score', '>', 80],
              ['score', '<=', 90],
            ])
            .build();
          await db.transact(async (tx) => {
            const { candidates } = await getCandidateEntityIds(
              tx.storeTx,
              query,
              {
                session: {
                  roles: db.sessionRoles,
                  systemVars: db.systemVars,
                },
              }
            );
            expectUnorderedArrayEquality(await genToArr(candidates), [
              'tests#1',
              'tests#3',
              'tests#4',
              'tests#6',
            ]);
          });
        }

        // non matching operators
        {
          const query = db
            .query('tests')
            .where([
              ['score', '>', 80],
              ['score', '>=', 90],
            ])
            .build();
          await db.transact(async (tx) => {
            const { candidates } = await getCandidateEntityIds(
              tx.storeTx,
              query,
              {
                session: {
                  roles: db.sessionRoles,
                  systemVars: db.systemVars,
                },
              }
            );
            expectUnorderedArrayEquality(await genToArr(candidates), [
              'tests#0',
              'tests#1',
              'tests#2',
              'tests#3',
              'tests#4',
              'tests#6',
            ]);
          });
        }

        // non matching paths
        {
          const query = db
            .query('tests')
            .where([
              ['score', '>', 80],
              ['age', '<=', 25],
            ])
            .build();
          await db.transact(async (tx) => {
            const { candidates } = await getCandidateEntityIds(
              tx.storeTx,
              query,
              {
                session: {
                  roles: db.sessionRoles,
                  systemVars: db.systemVars,
                },
              }
            );
            expectUnorderedArrayEquality(await genToArr(candidates), [
              'tests#0',
              'tests#1',
              'tests#2',
              'tests#3',
              'tests#4',
              'tests#6',
            ]);
          });
        }
      });
    });

    describe('order index', () => {
      it('selects candidates in order if order clause is provided', async () => {
        const db = new DB();
        await seed(db);

        // Ordered only on first attribute for candidate selection
        const query = db
          .query('tests')
          .order('score', 'ASC')
          .order('name', 'ASC')
          .build();
        await db.transact(async (tx) => {
          const { candidates } = await getCandidateEntityIds(
            tx.storeTx,
            query,
            {
              session: {
                roles: db.sessionRoles,
                systemVars: db.systemVars,
              },
            }
          );
          expect(await genToArr(candidates)).toEqual([
            'tests#13',
            'tests#11',
            'tests#14',
            'tests#12',
            'tests#9',
            'tests#10',
            'tests#7',
            'tests#5',
            'tests#8',
            'tests#3',
            'tests#6',
            'tests#1',
            'tests#4',
            'tests#2',
            'tests#0',
          ]);
        });
      });
    });

    it('will use filter index before order index', async () => {
      const db = new DB();
      await seed(db);

      const query = db
        .query('tests')
        .where('age', '>=', 24)
        .order('score', 'ASC')
        .build();
      await db.transact(async (tx) => {
        const { candidates } = await getCandidateEntityIds(tx.storeTx, query, {
          session: {
            roles: db.sessionRoles,
            systemVars: db.systemVars,
          },
        });
        expectUnorderedArrayEquality(await genToArr(candidates), [
          'tests#0',
          'tests#1',
          'tests#2',
          'tests#3',
          'tests#4',
          'tests#5',
        ]);
      });
    });

    it('if no matching clauses are found, it uses a collection scan', async () => {
      const db = new DB();
      await seed(db);

      // No info to use
      {
        const query = db.query('tests').build();
        await db.transact(async (tx) => {
          const { candidates } = await getCandidateEntityIds(
            tx.storeTx,
            query,
            {
              session: {
                roles: db.sessionRoles,
                systemVars: db.systemVars,
              },
            }
          );
          expectUnorderedArrayEquality(
            await genToArr(candidates),
            testData.map((_, i) => `tests#${i}`)
          );
        });
      }

      // No matching filter operation
      {
        const query = db.query('tests').where('name', '!=', 'Alice').build();
        await db.transact(async (tx) => {
          const { candidates } = await getCandidateEntityIds(
            tx.storeTx,
            query,
            {
              session: {
                roles: db.sessionRoles,
                systemVars: db.systemVars,
              },
            }
          );
          expectUnorderedArrayEquality(
            await genToArr(candidates),
            testData.map((_, i) => `tests#${i}`)
          );
        });
      }
    });
  });
});

it('range filter handles dates', async () => {
  const db = new DB({
    schema: {
      collections: {
        tests: {
          schema: S.Schema({
            id: S.Id(),
            date: S.Date(),
          }),
        },
      },
    },
  });
  await db.insert('tests', { id: '0', date: new Date('2021-01-01') });
  await db.insert('tests', { id: '1', date: new Date('2021-01-02') });
  await db.insert('tests', { id: '2', date: new Date('2021-01-03') });
  await db.insert('tests', { id: '3', date: new Date('2021-01-04') });
  await db.insert('tests', { id: '4', date: new Date('2021-01-05') });
  const query = db
    .query('tests')
    .where([
      ['date', '>', new Date('2021-01-01')],
      ['date', '<', new Date('2021-01-05')],
    ])
    .build();
  await db.transact(async (tx) => {
    const { candidates } = await getCandidateEntityIds(tx.storeTx, query, {
      session: {
        roles: db.sessionRoles,
        systemVars: db.systemVars,
      },
    });
    expectUnorderedArrayEquality(await genToArr(candidates), [
      'tests#1',
      'tests#2',
      'tests#3',
    ]);
  });
});
