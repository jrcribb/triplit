import {
  CountOptions,
  KVStore,
  KVStoreTransaction,
  ScanOptions,
} from '../../types.js';
import { compareTuple, Tuple } from '../../codec.js';
import { MemoryTransaction } from '../transactions/memory-tx.js';
import { ScopedKVStore } from '../utils/scoped-store.js';

const version = 1;
const storeName = 'triplit';

type IndexedDbKVOptions = {
  batchSize?: number;
};

export class IndexedDbKVStore implements KVStore {
  private db: Promise<IDBDatabase>;
  readonly options: IndexedDbKVOptions;

  constructor(
    db: string | Promise<IDBDatabase>,
    options: IndexedDbKVOptions = {}
  ) {
    this.options = options;
    this.db =
      typeof db === 'string'
        ? new Promise((resolve, reject) => {
            const request = indexedDB.open(db, version);

            request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
              const database = (event.target as IDBOpenDBRequest).result;
              this.setupSchema(database);
            };

            request.onsuccess = (event: Event) => {
              const database = (event.target as IDBOpenDBRequest).result;
              resolve(database);
            };

            request.onerror = (event: Event) => {
              console.error(
                `Error opening database: ${(event.target as IDBOpenDBRequest).error}`
              );
              reject((event.target as IDBOpenDBRequest).error);
            };
          })
        : db;
  }

  private setupSchema(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(storeName)) {
      db.createObjectStore(storeName);
    }
  }

  async get(key: Tuple, scope?: Tuple) {
    const db = await this.db;
    const fullKey = (scope ? [...scope, ...key] : key) as string[];
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly', {
        durability: 'relaxed',
      });
      const store = transaction.objectStore(storeName);
      const request = store.get(fullKey);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async set(key: Tuple, value: any, scope?: Tuple) {
    const db = await this.db;
    const fullKey = (scope ? [...scope, ...key] : key) as string[];
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite', {
        durability: 'relaxed',
      });
      const store = transaction.objectStore(storeName);
      const request = store.put(value, fullKey);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async delete(key: Tuple, scope?: Tuple) {
    const db = await this.db;
    const fullKey = (scope ? [...scope, ...key] : key) as string[];
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite', {
        durability: 'relaxed',
      });
      const store = transaction.objectStore(storeName);
      const request = store.delete(fullKey);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async *scan(
    options: ScanOptions,
    scope?: Tuple
  ): AsyncIterable<[Tuple, any]> {
    const db = await this.db;
    const lower = scope ? [...scope, ...options.prefix] : options.prefix;
    const upper = [...lower, '\uffff'];
    const transaction = db.transaction(storeName, 'readonly', {
      durability: 'relaxed',
    });
    const store = transaction.objectStore(storeName);
    const batchSize = this.options.batchSize ?? 1000;
    let keys: string[][] = [];
    let values: any[] = [];
    let keyRange = IDBKeyRange.bound(lower, upper, false, true);
    while (true) {
      keys = await new Promise<string[][]>((resolve, reject) => {
        const request = store.getAllKeys(keyRange, batchSize);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result as string[][]);
      });
      if (!keys.length) break;
      values = await new Promise((resolve, reject) => {
        const request = store.getAll(keyRange, batchSize);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (!values.length) break;
      const lastKey = keys.at(-1)!;
      const lastPage = compareTuple(lastKey, upper) > 0;
      for (let i = 0; i < keys.length; i++) {
        if (lastPage) {
          if (compareTuple(keys[i], upper) > 0) break;
        }
        const prefixLength = (scope?.length ?? 0) + options.prefix.length;
        const keyWithoutPrefix =
          prefixLength > 0 ? keys[i].slice(prefixLength) : keys[i];
        if (keyWithoutPrefix.length === 0) break;
        yield [keyWithoutPrefix, values[i]];
      }
      // Could be more, set up to continue scanning
      if (values.length === batchSize) {
        keyRange = IDBKeyRange.lowerBound(keys.at(-1), true);
        keys = [];
        values = [];
      } else {
        break;
      }
    }
  }

  async *scanValues(options: ScanOptions, scope?: Tuple): AsyncIterable<any> {
    const db = await this.db;
    const lower = scope ? [...scope, ...options.prefix] : options.prefix;
    const upper = [...lower, '\uffff'];
    const transaction = db.transaction(storeName, 'readonly', {
      durability: 'relaxed',
    });
    const store = transaction.objectStore(storeName);
    const batchSize = this.options.batchSize ?? 1000;
    let keys: string[][] = [];
    let values: any[] = [];
    let keyRange = IDBKeyRange.bound(lower, upper, false, true);
    while (true) {
      keys = await new Promise<string[][]>((resolve, reject) => {
        const request = store.getAllKeys(keyRange, batchSize);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result as string[][]);
      });
      if (!keys.length) break;
      values = await new Promise((resolve, reject) => {
        const request = store.getAll(keyRange, batchSize);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (!values.length) break;
      const lastKey = keys.at(-1)!;
      const lastPage = compareTuple(lastKey, upper) > 0;
      for (let i = 0; i < keys.length; i++) {
        if (lastPage) {
          if (compareTuple(keys[i], upper) > 0) break;
        }
        yield values[i];
      }
      // Could be more, set up to continue scanning
      if (values.length === batchSize) {
        keyRange = IDBKeyRange.lowerBound(keys.at(-1), true);
        keys = [];
        values = [];
      } else {
        break;
      }
    }
  }

  async *scanCursor(
    options: ScanOptions,
    scope?: Tuple
  ): AsyncIterable<[Tuple, any]> {
    const db = await this.db;
    const lower = scope ? [...scope, ...options.prefix] : options.prefix;
    const upper = [...lower, '\uffff'];
    const transaction = db.transaction(storeName, 'readonly', {
      durability: 'relaxed',
    });
    const store = transaction.objectStore(storeName);
    const range = IDBKeyRange.bound(lower, upper, false, true);
    const request = store.openCursor(range);

    while (true) {
      const cursor = await new Promise<IDBCursorWithValue>(
        (resolve, reject) => {
          request.onerror = () => reject(request.error);
          request.onsuccess = () =>
            resolve((request as IDBRequest<IDBCursorWithValue>).result);
        }
      );
      if (!cursor) {
        break;
      }
      const prefixLength = (scope?.length ?? 0) + options.prefix.length;
      const keyWithoutPrefix = (
        prefixLength > 0
          ? (cursor.key as string[]).slice(prefixLength)
          : cursor.key
      ) as string[];
      if (keyWithoutPrefix.length === 0) break;
      yield [keyWithoutPrefix, cursor.value];
      cursor.continue();
    }
  }

  async clear(scope?: Tuple) {
    const db = await this.db;
    const transaction = db.transaction(storeName, 'readwrite', {
      durability: 'relaxed',
    });
    const store = transaction.objectStore(storeName);
    if (!scope?.length) {
      const request = store.clear();
      return new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          resolve();
        };

        request.onerror = () => reject(request.error);
      });
    } else {
      const lower = scope;
      const upper = [...lower, '\uffff'];
      const range = IDBKeyRange.bound(lower, upper, false, true);
      return new Promise<void>((resolve, reject) => {
        const request = store.delete(range);
        request.onsuccess = () => {
          resolve();
        };

        request.onerror = () => reject(request.error);
      });
    }
  }

  scope(scope: Tuple): ScopedKVStore<this> {
    return new ScopedKVStore(this, scope);
  }

  transact(): KVStoreTransaction {
    return new MemoryTransaction(this);
  }

  async count(options: CountOptions, scope?: Tuple): Promise<number> {
    const db = await this.db;
    const lower = scope ? [...scope, ...options.prefix] : options.prefix;
    const upper = [...lower, '\uffff'];
    const range = IDBKeyRange.bound(lower, upper, false, true);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly', {
        durability: 'relaxed',
      });
      const store = transaction.objectStore(storeName);
      const request = store.count(range);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async applyEdits(
    sets: AsyncIterable<[Tuple, any]> | Iterable<[Tuple, any]>,
    deletes: AsyncIterable<Tuple> | Iterable<Tuple>
  ): Promise<void> {
    const db = await this.db;
    await new Promise<void>(async (resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite', {
        durability: 'relaxed',
      });
      const store = tx.objectStore(storeName);
      let lastOp = null;
      for await (const key of deletes) {
        lastOp = store.delete(key as string[]);
      }
      for await (const [key, value] of sets) {
        lastOp = store.put(value, key as string[]);
      }

      if (lastOp) {
        lastOp.onsuccess = () => resolve();
        // TODO: figure out how to make on error for any error
        lastOp.onerror = () => reject(lastOp.error);
      } else {
        resolve();
      }
    });
  }
}
