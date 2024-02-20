import { addRxPlugin, createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import Bench from 'tinybench';
import { DB } from '../src/index.js';
import { Schema as S } from '../src/schema.js';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
import {
  MemoryBTreeStorage as MemoryBTree,
  MemoryBTreeStorage,
} from '../src/storage/memory-btree.js';
import { TupleDatabase, TupleDatabaseClient } from '@triplit/tuple-database';
import BTree from 'sorted-btree';
addRxPlugin(RxDBQueryBuilderPlugin);
const BTreeClass = (BTree.default ? BTree.default : BTree) as typeof BTree;

const rxdb = await createRxDatabase({
  name: 'exampledb',
  storage: getRxStorageMemory(),
});

await rxdb.addCollections({
  classes: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 100 },
        level: { type: 'number' },
        name: { type: 'string' },
      },
    },
  },
});

const CLASSES = new Array(100).fill(0).map((_, i) => ({
  id: i.toString(),
  level: Math.floor(Math.random() * 1000),
  name: `Class ${i}`,
}));

const triplit = new DB({
  source: new MemoryBTree(),
  // schema: {
  //   version: 0,
  //   collections: {
  //     classes: {
  //       schema: S.Schema({
  //         id: S.String(),
  //         level: S.Number(),
  //         name: S.String(),
  //       }),
  //     },
  //   },
  // },
});

const expectedClassCount = CLASSES.filter((c) => c.level < 200).length;

const controller = new AbortController();

const bench = new Bench({ signal: controller.signal });

function logAndThrowError(msg: string) {
  console.error(msg);
  throw new Error(msg);
}

// Time first inserts for each bench
{
  const now = performance.now();
  for (const cls of CLASSES) {
    await rxdb.collections.classes.upsert(cls);
  }
  console.log(
    `rxdb first insert ${CLASSES.length} classes: ${performance.now() - now}ms`
  );
}
{
  const now = performance.now();
  for (const cls of CLASSES) {
    await triplit.insert('classes', cls);
  }
  console.log(
    `triplit first insert ${CLASSES.length} classes: ${
      performance.now() - now
    }ms`
  );
}

bench
  .add('vanilla js map', async () => {
    const db = new Map(CLASSES.map((cls) => [cls.id, cls]));
  })
  .add('TupleDB', async () => {
    const tupleDb = new TupleDatabaseClient(
      new TupleDatabase(new MemoryBTreeStorage())
    );
    const tx = tupleDb.transact();
    for (const cls of CLASSES) {
      tx.set(['classes', cls.id], cls);
    }
    tx.commit();
  })
  .add('Btree', async () => {
    const btree = new BTreeClass();
    for (const cls of CLASSES) {
      btree.set(cls.id, cls);
    }
  })
  .add('rxdb bulk', async () => {
    await rxdb.collections.classes.bulkInsert(CLASSES);
  })
  .add('rxdb', async () => {
    try {
      for (const cls of CLASSES) {
        await rxdb.collections.classes.upsert(cls);
      }
    } catch (e) {
      logAndThrowError(e.message);
    }
  })
  .add('triplit', async () => {
    for (const cls of CLASSES) {
      await triplit.insert('classes', cls);
    }
  })
  .add('triplit bulk', async () => {
    await triplit.transact(async (tx) => {
      for (const cls of CLASSES) {
        await tx.insert('classes', cls);
      }
    });
  });

bench.addEventListener('error', (e) => {
  console.error(e);
  controller.abort();
});

await bench.run();
console.table(bench.table());
