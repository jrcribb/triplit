import {
  KeyValuePair,
  ScanArgs,
  Tuple,
  AsyncTupleDatabaseClient,
  AsyncTupleRootTransactionApi,
  Unsubscribe,
  transactionalReadWriteAsync,
  WriteOps,
} from '@triplit/tuple-database';
import { compareTuple } from '@triplit/tuple-database/helpers/compareTuple';
import {
  TuplePrefix,
  TupleToObject,
  RemoveTupleValuePairPrefix,
} from '@triplit/tuple-database/database/typeHelpers';
import {
  DBScanFailureError,
  InvalidTransactionStateError,
  NotImplementedError,
  TransactionAlreadyCanceledError,
  TransactionAlreadyCommittedError,
  TriplitError,
} from './errors.js';
import { MirroredArray } from './utils/mirrored-array.js';
import { genToArr } from './utils/generator.js';

export type StorageScope = {
  read?: string[];
  write?: string[];
};

export type TransactionScope<TupleSchema extends KeyValuePair> = {
  read: AsyncTupleRootTransactionApi<TupleSchema>[];
  write: AsyncTupleRootTransactionApi<TupleSchema>[];
};

type TransactionStatus =
  | 'open'
  | 'commit-called'
  | 'committing'
  | 'committed'
  | 'canceling'
  | 'canceled';

type MultiTupleStoreBeforeCommitHook<TupleSchema extends KeyValuePair> = (
  tx: MultiTupleTransaction<TupleSchema>
) => void | Promise<void>;

type MultiTupleStoreBeforeInsertHook<TupleSchema extends KeyValuePair> = (
  tuple: TupleSchema,
  tx: MultiTupleTransaction<TupleSchema>
) => void | Promise<void>;

type MultiTupleStoreBeforeScanHook<TupleSchema extends KeyValuePair> = (
  scanArgs: ScanArgs<any, any> | undefined,
  tx: MultiTupleTransaction<TupleSchema>
) => void | Promise<void>;

type MultiTupleStoreAfterCommitHook<TupleSchema extends KeyValuePair> = (
  tx: MultiTupleTransaction<TupleSchema>
) => void | Promise<void>;

type MultiTupleStoreHooks<TupleSchema extends KeyValuePair> = {
  // Runs before committing a transaction
  beforeCommit: MultiTupleStoreBeforeCommitHook<TupleSchema>[];
  // Runs before setting a tuple value in a transaction
  beforeInsert: MultiTupleStoreBeforeInsertHook<TupleSchema>[];
  // Runs before any scan operation
  beforeScan: MultiTupleStoreBeforeScanHook<TupleSchema>[];
  // Runs after committing a transaction (notably different from reactivity hooks, which are fire and forget in the event loop)
  afterCommit: MultiTupleStoreAfterCommitHook<TupleSchema>[];
};

export const DEFAULT_PAGE_SIZE = 100;

async function* lazyScan<
  TupleSchema extends KeyValuePair,
  T extends Tuple,
  P extends TuplePrefix<T>,
>(
  stores:
    | AsyncTupleDatabaseClient<TupleSchema>[]
    | AsyncTupleRootTransactionApi<TupleSchema>[],
  args?: ScanArgs<T, P> | undefined,
  batchSize: number = DEFAULT_PAGE_SIZE
): AsyncGenerator<
  Extract<TupleSchema, { key: TupleToObject<P> }>,
  void,
  undefined
> {
  const comparer = (a: TupleSchema, b: TupleSchema) =>
    (compareTuple(a.key, b.key) * (args?.reverse ? -1 : 1)) as 1 | -1 | 0;

  // let cursorKey: (TupleToObject<P> & Tuple) | undefined;
  let cursorKey: (TupleToObject<P> & Tuple) | undefined;
  let remainingLimit = args?.limit ?? Infinity;

  while (remainingLimit > 0) {
    const batchLimit = Math.min(batchSize, remainingLimit);
    const batchArgs = {
      limit: batchLimit || args?.limit,
    };
    if (!args?.reverse) {
      Object.assign(batchArgs, {
        gt: cursorKey ?? args?.gt,
        gte: cursorKey ? undefined : args?.gte,
      });
    } else {
      Object.assign(batchArgs, {
        lt: cursorKey ?? args?.lt,
        lte: cursorKey ? undefined : args?.lte,
      });
    }
    const results = mergeMultipleSortedArrays(
      await Promise.all(
        stores.map((store) => store.scan({ ...args, ...batchArgs }))
      ),
      comparer
    );
    if (results.length === 0) {
      break;
    }

    let i = 0;
    for (const result of results) {
      yield result;
      remainingLimit--;
      i++;
      // After we merge from multiple stores we may have # results > batchLimit and with an order gap, we still need to respect the batch limit to ensure the last key we pull out is the last key in the batch across all stores
      if (i === batchLimit) {
        cursorKey = result.key.slice(
          args?.prefix?.length ?? 0
        ) as TupleToObject<P> & Tuple;
        break;
      }
    }

    if (results.length < batchLimit) {
      break;
    }
  }
}

export default class MultiTupleStore<TupleSchema extends KeyValuePair> {
  readonly storageScope?: StorageScope;
  storage: Record<string, AsyncTupleDatabaseClient<TupleSchema>>;
  readonly hooks: MultiTupleStoreHooks<TupleSchema>;
  private _inheritedHooks: MultiTupleStoreHooks<TupleSchema>;
  private _ownHooks: MultiTupleStoreHooks<TupleSchema>;
  reactivity: MultiTupleReactivity;
  // subspacePrefix: Tuple;

  constructor({
    storage,
    storageScope,
    hooks,
    reactivity,
  }: {
    storage: Record<string, AsyncTupleDatabaseClient<TupleSchema>>;
    storageScope?: { read?: string[]; write?: string[] };
    hooks?: MultiTupleStoreHooks<TupleSchema>;
    reactivity?: MultiTupleReactivity;
  }) {
    this.storage = storage;
    this.storageScope = storageScope;
    this._inheritedHooks = hooks ?? {
      beforeCommit: [],
      beforeInsert: [],
      beforeScan: [],
      afterCommit: [],
    };
    this._ownHooks = {
      beforeCommit: [],
      beforeInsert: [],
      beforeScan: [],
      afterCommit: [],
    };
    this.hooks = {
      beforeCommit: MirroredArray(
        this._inheritedHooks.beforeCommit,
        this._ownHooks.beforeCommit
      ),
      beforeInsert: MirroredArray(
        this._inheritedHooks.beforeInsert,
        this._ownHooks.beforeInsert
      ),
      beforeScan: MirroredArray(
        this._inheritedHooks.beforeScan,
        this._ownHooks.beforeScan
      ),
      afterCommit: MirroredArray(
        this._inheritedHooks.afterCommit,
        this._ownHooks.afterCommit
      ),
    };
    this.reactivity = reactivity ?? new MultiTupleReactivity();
  }

  withStorageScope(scope: StorageScope) {
    return new MultiTupleStore({
      storage: this.storage,
      storageScope: scope,
      hooks: this.hooks,
      reactivity: this.reactivity,
    });
  }

  getStorageClients(context?: 'read' | 'write') {
    if (context && this.storageScope && this.storageScope[context]) {
      return this.storageScope[context]!.map(
        (storageKey) => this.storage[storageKey]
      );
    }
    return Object.values(this.storage);
  }

  getStorageClientsEntries(context?: 'read' | 'write') {
    if (context && this.storageScope && this.storageScope[context]) {
      return this.storageScope[context]!.map(
        (storageKey) => [storageKey, this.storage[storageKey]] as const
      );
    }
    return Object.entries(this.storage);
  }

  beforeInsert(callback: MultiTupleStoreBeforeInsertHook<TupleSchema>) {
    this._ownHooks.beforeInsert.push(callback);
  }

  beforeCommit(callback: MultiTupleStoreBeforeCommitHook<TupleSchema>) {
    this._ownHooks.beforeCommit.push(callback);
  }

  afterCommit(callback: MultiTupleStoreAfterCommitHook<TupleSchema>) {
    this._ownHooks.afterCommit.push(callback);
  }

  beforeScan(callback: MultiTupleStoreBeforeScanHook<TupleSchema>) {
    this._ownHooks.beforeScan.push(callback);
  }

  async *scan<T extends Tuple, P extends TuplePrefix<T>>(
    args?: ScanArgs<T, P> | undefined,
    batchSize: number = DEFAULT_PAGE_SIZE
  ): AsyncGenerator<
    Extract<TupleSchema, { key: TupleToObject<P> }>,
    void,
    undefined
  > {
    const storages = this.getStorageClients('read');

    yield* lazyScan(storages, args, batchSize);
  }

  subscribe<T extends Tuple, P extends TuplePrefix<T>>(
    args: ScanArgs<T, P>,
    callback: MultiTupleReactivityCallback<TupleSchema>
  ): Unsubscribe {
    const subscriptionId = this.reactivity.subscribe(callback);
    const unsubFuncs = this.getStorageClientsEntries('read').map(
      ([storeId, store]) => {
        return store.subscribe(args, (writeOps, txId) => {
          const parentTxId = this.reactivity.getParentTxId(storeId, txId);
          if (!parentTxId) {
            // Shouldnt happen, but problematic if it does (we're not tracking updates properly)
            console.warn('Not tracking reactivity for', storeId, txId);
            return;
          }
          this.reactivity.assignStorePayloadToSubscriptionArgs(
            parentTxId,
            subscriptionId,
            storeId,
            writeOps
          );
        });
      }
    );
    return () => {
      this.reactivity.unsubscribe(subscriptionId);
      Promise.all(unsubFuncs).then((unsubs) =>
        unsubs.forEach((unsub) => unsub())
      );
    };
  }

  // get<T extends Tuple>(
  //   tuple: T,
  //   txId?: string | undefined
  // ):
  //   | (Extract<TupleSchema, { key: TupleToObject<T> }> extends unknown
  //       ? Extract<TupleSchema, { key: TupleToObject<T> }>['value']
  //       : never)
  //   | undefined {
  //   throw new Error('Method not implemented.');
  // }

  async exists<T extends Tuple>(
    tuple: T,
    txId?: string | undefined
  ): Promise<boolean> {
    return (
      await Promise.all(
        this.getStorageClients('read').map((store) => store.exists(tuple, txId))
      )
    ).some((exists) => exists);
  }
  subspace<P extends TuplePrefix<TupleSchema['key']>>(
    prefix: P
  ): MultiTupleStore<RemoveTupleValuePairPrefix<TupleSchema, P>> {
    const prefixedStorages = Object.fromEntries(
      Object.entries(this.storage).map(([storageKey, store]) => [
        storageKey,
        store.subspace(prefix),
      ])
    );
    return new MultiTupleStore({
      storage: prefixedStorages,
      storageScope: this.storageScope,
      // @ts-expect-error
      hooks: this.hooks,
      reactivity: this.reactivity,
    }) as MultiTupleStore<RemoveTupleValuePairPrefix<TupleSchema, P>>;
  }

  transact(scope?: StorageScope): MultiTupleTransaction<TupleSchema> {
    return new MultiTupleTransaction({
      scope: scope ?? this.storageScope,
      store: this,
      hooks: this.hooks,
    });
  }

  async autoTransact<T>(
    callback: (tx: MultiTupleTransaction<TupleSchema>) => Promise<T>,
    scope: StorageScope | undefined
  ) {
    try {
      return await transactionalReadWriteAsync(5, {
        exponentialBackoff: true,
        jitter: true,
      })(
        // @ts-expect-error
        callback
      )(
        // @ts-expect-error
        scope
          ? new MultiTupleStore({
              storage: this.storage,
              storageScope: scope,
              hooks: this.hooks,
              reactivity: this.reactivity,
            })
          : this
      );
    } catch (e) {
      throw mapTupleDatabaseErrorToTriplitError(e);
    }
  }

  async clear() {
    const writeStores = this.getStorageClients('write');
    await Promise.all(
      writeStores.map((store) =>
        // @ts-expect-error
        store.db.storage.clear()
      )
    );
  }

  close(): void {
    throw new NotImplementedError('MultiTupleStore.close() method');
  }
}

export class ScopedMultiTupleOperator<TupleSchema extends KeyValuePair> {
  readonly txScope: TransactionScope<TupleSchema>;
  protected _inheritedHooks: MultiTupleStoreHooks<TupleSchema>;
  protected _ownHooks: MultiTupleStoreHooks<TupleSchema>;
  hooks: MultiTupleStoreHooks<TupleSchema>;
  readonly state: { status: TransactionStatus };
  constructor({
    state,
    txScope,
    hooks,
  }: {
    state: { status: TransactionStatus };
    txScope: TransactionScope<TupleSchema>;
    hooks: MultiTupleStoreHooks<TupleSchema>;
  }) {
    this.state = state;
    this.txScope = txScope;
    this._inheritedHooks = hooks ?? {
      beforeCommit: [],
      beforeInsert: [],
      beforeScan: [],
      afterCommit: [],
    };
    this._ownHooks = {
      beforeCommit: [],
      beforeInsert: [],
      beforeScan: [],
      afterCommit: [],
    };
    this.hooks = {
      beforeCommit: MirroredArray(
        this._inheritedHooks.beforeCommit,
        this._ownHooks.beforeCommit
      ),
      beforeInsert: MirroredArray(
        this._inheritedHooks.beforeInsert,
        this._ownHooks.beforeInsert
      ),
      beforeScan: MirroredArray(
        this._inheritedHooks.beforeScan,
        this._ownHooks.beforeScan
      ),
      afterCommit: MirroredArray(
        this._inheritedHooks.afterCommit,
        this._ownHooks.afterCommit
      ),
    };
  }

  async *scan<T extends Tuple, P extends TuplePrefix<T>>(
    args?: ScanArgs<T, P> | undefined,
    batchSize: number = DEFAULT_PAGE_SIZE
  ): AsyncGenerator<
    Extract<TupleSchema, { key: TupleToObject<P> }>,
    void,
    undefined
  > {
    yield* lazyScan<TupleSchema, T, P>(this.txScope.read, args, batchSize);
  }

  async exists<T extends Tuple>(tuple: T): Promise<boolean> {
    return (
      await Promise.all(this.txScope.read.map((store) => store.exists(tuple)))
    ).some((exists) => exists);
  }

  // get: <T extends Tuple>(tuple: T) => (Extract<TupleSchema, { key: TupleToObject<T>; }> extends unknown ? Extract<TupleSchema, { key: TupleToObject<T>; }>['value'] : never) | undefined;
  // exists: <T extends Tuple>(tuple: T) => boolean;
  remove(tuple: TupleSchema['key']) {
    if (
      this.state.status === 'committing' ||
      this.state.status === 'committed'
    ) {
      console.warn(
        'You are attempting to perform an operation on an already committed transaction - changes may not be committed. Please ensure you are awaiting async operations within a transaction.'
      );
    }
    if (this.state.status === 'canceling' || this.state.status === 'canceled') {
      console.warn(
        'You are attempting to perform an operation on an already canceled transaction - changes may not be committed. Please ensure you are awaiting async operations within a transaction.'
      );
    }
    this.txScope.write.forEach((tx) => tx.remove(tuple));
  }

  // write: (writes: WriteOps<TupleSchema>) => TupleRootTransactionApi<TupleSchema>;

  async set<Key extends Tuple>(
    tuple: Key,
    value: Extract<TupleSchema, { key: TupleToObject<Key> }> extends unknown
      ? Extract<TupleSchema, { key: TupleToObject<Key> }>['value']
      : never
  ) {
    // To prevent beforeCommit hooks from triggering warning, dont include 'commit-called' status
    // But that would help catch users not awaiting async operations
    if (
      this.state.status === 'committing' ||
      this.state.status === 'committed'
    ) {
      console.warn(
        'You are attempting to perform an operation on an already committed transaction - changes may not be committed. Please ensure you are awaiting async operations within a transaction.'
      );
    }
    if (this.state.status === 'canceling' || this.state.status === 'canceled') {
      console.warn(
        'You are attempting to perform an operation on an already canceled transaction - changes may not be committed. Please ensure you are awaiting async operations within a transaction.'
      );
    }
    for (const beforeHook of this.hooks.beforeInsert) {
      await beforeHook(
        // @ts-expect-error
        { key: tuple, value },
        this
      );
    }
    this.txScope.write.forEach((tx) => tx.set(tuple, value));
  }

  beforeScan(callback: MultiTupleStoreBeforeScanHook<TupleSchema>) {
    this._ownHooks.beforeScan.push(callback);
  }

  beforeCommit(callback: MultiTupleStoreBeforeCommitHook<TupleSchema>) {
    this._ownHooks.beforeCommit.push(callback);
  }

  afterCommit(callback: MultiTupleStoreAfterCommitHook<TupleSchema>) {
    this._ownHooks.afterCommit.push(callback);
  }
}

function mergeMultipleSortedArrays<T>(
  arrays: T[][],
  comparer: (a: T, b: T) => -1 | 0 | 1
): T[] {
  const pointers = arrays.map(() => 0);
  const resultSize = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Array(resultSize);
  let itemCount = 0;
  while (itemCount < resultSize) {
    let candidateList = null;
    for (let i = 0; i < arrays.length; i++) {
      const item = arrays[i][pointers[i]];
      if (!item) continue;
      if (candidateList == null) {
        candidateList = i;
        continue;
      }
      if (comparer(item, arrays[candidateList][pointers[candidateList]]) < 0) {
        candidateList = i;
      }
    }
    if (candidateList == null) {
      throw new DBScanFailureError(
        'While merging scan results, could not select a result set to take from. This should never happen.'
      );
    }
    result[itemCount++] = arrays[candidateList][pointers[candidateList]++];
  }
  return result;
}

type TransactionState = { status: TransactionStatus };

export class MultiTupleTransaction<
  TupleSchema extends KeyValuePair,
> extends ScopedMultiTupleOperator<TupleSchema> {
  readonly txs: Record<string, AsyncTupleRootTransactionApi<TupleSchema>>;
  readonly store: MultiTupleStore<TupleSchema>;

  id: string = Math.random().toString(36).slice(2);

  constructor({
    store,
    scope,
    hooks,
  }: {
    store: MultiTupleStore<TupleSchema>;
    scope?: StorageScope;
    hooks: MultiTupleStoreHooks<TupleSchema>;
  }) {
    const txEntries = Object.entries(store.storage).map(
      ([storageKey, store]) => [storageKey, store.transact()] as const
    );
    const txs = Object.fromEntries(txEntries);
    const readKeys = scope?.read ?? Object.keys(store.storage);
    const writeKeys = scope?.write ?? Object.keys(store.storage);
    // Storing state in an object so it can be passed by reference to scope objects (but dont love this pattern)
    const state: TransactionState = { status: 'open' };
    super({
      state,
      txScope: {
        read: readKeys.map((storageKey) => txs[storageKey]),
        write: writeKeys.map((storageKey) => txs[storageKey]),
      },
      hooks,
    });
    for (const [storageKey, tx] of txEntries) {
      store.reactivity.trackTupleStoreTx(storageKey, tx.id, this.id);
    }
    this.txs = txs;
    this.store = store;
  }

  private get status() {
    return this.state.status;
  }

  get isOpen() {
    return this.status === 'open';
  }

  get isCommitting() {
    return this.status === 'committing';
  }

  get isCommitted() {
    return this.status === 'committed';
  }

  get isCancelling() {
    return this.status === 'canceling';
  }

  get isCanceled() {
    return this.status === 'canceled';
  }

  get writes() {
    return Object.fromEntries(
      Object.entries(this.txs).map(([id, tx]) => [id, tx.writes])
    );
  }

  async *scan<T extends Tuple, P extends TuplePrefix<T>>(
    args?: ScanArgs<T, P> | undefined,
    batchSize: number = DEFAULT_PAGE_SIZE
  ): AsyncGenerator<
    Extract<TupleSchema, { key: TupleToObject<P> }>,
    void,
    undefined
  > {
    for (const beforeHook of this.hooks.beforeScan) {
      await beforeHook(args, this);
    }

    yield* lazyScan(this.txScope.read, args, batchSize);
  }

  withScope(scope: StorageScope) {
    const readKeys = scope.read ?? Object.keys(this.store.storage);
    const writeKeys = scope.write ?? Object.keys(this.store.storage);
    return new ScopedMultiTupleOperator({
      state: this.state,
      txScope: {
        read: readKeys.map((storageKey) => this.txs[storageKey]),
        write: writeKeys.map((storageKey) => this.txs[storageKey]),
      },
      hooks: this.hooks,
    });
  }

  /**
   * States: open, committing, committed, canceling, canceled
   *
   * // state: [valid transitions]
   * - open: [commit-called, canceling]
   * - commit-called: [committing, canceling]
   * - committing: [committed]
   * - committed: []
   * - canceling: [canceled]
   * - canceled: []
   *
   */
  private setStatus(status: TransactionStatus) {
    switch (this.status) {
      case 'open':
        if (status !== 'commit-called' && status !== 'canceling')
          throw new InvalidTransactionStateError(
            `Attempting to transition status from 'open' to '${status}'`
          );
        break;
      case 'commit-called':
        if (status !== 'committing' && status !== 'canceling')
          throw new InvalidTransactionStateError(
            `Attempting to transition status from 'commit-called' to '${status}'`
          );
        break;
      case 'committing':
        if (status !== 'committed')
          throw new InvalidTransactionStateError(
            `Attempting to transition status from 'committing' to '${status}'`
          );
        break;
      case 'committed':
        throw new InvalidTransactionStateError(
          `Attempting to transition status from 'committed' to '${status}'`
        );
      case 'canceling':
        if (status !== 'canceled')
          throw new InvalidTransactionStateError(
            `Attempting to transition status from 'canceling' to '${status}'`
          );
        break;
      case 'canceled':
        throw new InvalidTransactionStateError(
          `Attempting to transition status from 'canceled' to '${status}'`
        );
      default:
        throw new InvalidTransactionStateError('Invalid transaction status');
    }
    this.state.status = status;
  }

  private async _commit() {
    this.setStatus('commit-called');
    // Run before hooks
    for (const beforeHook of this.hooks.beforeCommit) {
      await beforeHook(this);
    }

    // Check if transaction was canceled during before hooks
    if (this.status === 'canceled') {
      return;
    }

    // perform commit
    this.setStatus('committing');
    await Promise.all(Object.values(this.txs).map((tx) => tx.commit()));
    this.setStatus('committed');

    // schedule reactivity callbacks
    this.store.reactivity.emit(this.id);
    for (const [storeId, tx] of Object.entries(this.txs)) {
      this.store.reactivity.untrackTupleStoreTx(storeId, tx.id);
    }

    // run after hooks
    for (const afterHook of this.hooks.afterCommit) {
      await afterHook(this);
    }
  }

  async commit() {
    switch (this.status) {
      case 'commit-called':
      case 'committing':
        return console.warn(
          'Cannot commit a transaction that is currently being committed.'
        );
      case 'committed':
        return console.warn(
          'Cannot commit a transaction that is already committed.'
        );
      case 'canceling':
        return console.warn(
          'Cannot commit a transaction that is currently being canceled.'
        );
      case 'canceled':
        return console.warn(
          'Cannot commit a transaction that is already canceled.'
        );
      case 'open':
        return this._commit();
      default:
        throw new InvalidTransactionStateError('Invalid transaction status');
    }
  }

  private async _cancel() {
    this.setStatus('canceling');
    await Promise.all(Object.values(this.txs).map((tx) => tx.cancel()));
    this.setStatus('canceled');
    for (const [storeId, tx] of Object.entries(this.txs)) {
      this.store.reactivity.untrackTupleStoreTx(storeId, tx.id);
    }
  }

  async cancel() {
    switch (this.status) {
      case 'committing':
        return console.warn(
          'Cannot cancel a transaction that is currently being committed.'
        );
      case 'committed':
        return console.warn(
          'Cannot cancel a transaction that is already committed.'
        );

      case 'canceling':
        return console.warn(
          'Cannot cancel a transaction that is currently being canceled.'
        );

      case 'canceled':
        return console.warn(
          'Cannot cancel a transaction that is already canceled.'
        );

      // If we have triggered a commit, we can still cancel it and abort the commit
      case 'commit-called':
      case 'open':
        return this._cancel();
      default:
        throw new InvalidTransactionStateError('Invalid transaction status');
    }
  }
}

type MultiTupleReactivityCallback<TupleSchema extends KeyValuePair> = (
  storeWrites: Record<
    string,
    WriteOps<Extract<TupleSchema, { key: TupleToObject<any> }>>
  >
) => void | Promise<void>;
type MultiTupleReactivityCallbackArgs = Record<string, WriteOps<any>>;

/**
 * MultiTupleReactivity is a class that manages reactivity for a MultiTupleStore.
 *
 * We allow for multiple stores to be combined into a single MultiTupleStore, and we want a way to fire a single when a transaction is committed across many stores.
 *
 * When we subscribe to a MultiTupleStore, we add a subscription to each store that on fire passes its args , so on write we we queue up the data.
 *
 * Later, when a multi store transaction is committed, we call emit() on the MultiTupleReactivity, which will call the single callback with the combined write operations.
 */
export class MultiTupleReactivity {
  // Open subscription callbacks that should be fired on `emit`
  private subscriptions: Map<string, MultiTupleReactivityCallback<any>> =
    new Map();

  // Maps multi store txid to subscription information
  private transactionSubscriptionArgs: Map<
    // MultiTupleTransaction id
    string,
    Map<
      // subscription id
      string,
      // args
      MultiTupleReactivityCallbackArgs
    >
  > = new Map();
  // Maps tuple store composite key to multi store txid
  private tupleStoreTxReactivityIds: Map<string, string> = new Map();
  private taskQueue = new TaskQueue();

  /**
   * Tracks a subscription to the MultiTupleStore
   */
  subscribe(callback: MultiTupleReactivityCallback<any>) {
    const subscriptionId = Math.random().toString(36).slice(2);
    this.subscriptions.set(subscriptionId, callback);
    return subscriptionId;
  }

  /**
   * Untracks a subscription to the MultiTupleStore
   */
  unsubscribe(subscriptionId: string) {
    this.subscriptions.delete(subscriptionId);
  }

  /**
   * Maps a tuple store transaction id to a multi store transaction id
   */
  trackTupleStoreTx(storeId: string, txId: string, multiStoreTxId: string) {
    const tupleStoreTxId = MultiTupleReactivity.TupleStoreCompositeKey(
      storeId,
      txId
    );
    this.tupleStoreTxReactivityIds.set(tupleStoreTxId, multiStoreTxId);
  }

  /**
   * Unmaps a tuple store transaction id to a multi store transaction id
   *
   * Call this when a multi tuple transaction is committed or cancelled
   */
  untrackTupleStoreTx(storeId: string, txId: string) {
    const tupleStoreTxId = MultiTupleReactivity.TupleStoreCompositeKey(
      storeId,
      txId
    );
    this.tupleStoreTxReactivityIds.delete(tupleStoreTxId);
  }

  /**
   * Returns the MultiTupleTransaction id related to a tuple store transaction id
   */
  getParentTxId(storeId: string, txId: string) {
    const tupleStoreTxId = MultiTupleReactivity.TupleStoreCompositeKey(
      storeId,
      txId
    );
    return this.tupleStoreTxReactivityIds.get(tupleStoreTxId);
  }

  /**
   * When a store subscription fires, track the write operations for later when `emit` is called
   */
  assignStorePayloadToSubscriptionArgs(
    // Multi store transaction id
    parentTxId: string,
    // Multi store subscription id
    subscriptionId: string,
    // Store id
    storeId: string,
    // Store operations
    writeOps: WriteOps<any>
  ) {
    if (!this.transactionSubscriptionArgs.has(parentTxId)) {
      this.transactionSubscriptionArgs.set(parentTxId, new Map());
    }

    const txSubArgs = this.transactionSubscriptionArgs.get(parentTxId)!;

    if (!txSubArgs.has(subscriptionId)) {
      txSubArgs.set(subscriptionId, {});
    }
    const currentSubscriptionArgs = txSubArgs.get(subscriptionId)!;
    currentSubscriptionArgs[storeId] = writeOps;
  }

  /**
   * When a multi store transaction is committed, schedule the callbacks to be called
   */
  emit(parentTxId: string) {
    const subscriptionArgs = this.transactionSubscriptionArgs.get(parentTxId);
    if (subscriptionArgs) {
      const unitsOfWork: [any, any][] = [];
      for (const [subscriptionId, args] of subscriptionArgs.entries()) {
        const subscription = this.subscriptions.get(subscriptionId);
        if (subscription) {
          unitsOfWork.push([subscription, args]);
        }
      }
      this.taskQueue.schedule(unitsOfWork);
      // TODO: possible memory leak if we never get to emit
      this.transactionSubscriptionArgs.delete(parentTxId);
    }
  }

  static TupleStoreCompositeKey(storeId: string, txId: string) {
    return `${storeId}_${txId}`;
  }
}

class TaskQueue {
  queue: [any, any][] = [];
  isRunning = false;

  schedule(unitsOfWork: [callback: any, args: any][]) {
    if (this.isRunning) {
      setTimeout(() => {
        this.queue.push(...unitsOfWork);
        this.run();
      });
      return;
    }
    this.queue.push(...unitsOfWork);
    this.run();
  }

  async run() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    while (this.queue.length) {
      const stuff = this.queue.shift();
      if (!stuff) break;
      const [cb, a] = stuff;
      await cb(a);
    }
    this.isRunning = false;
  }
}

function mapTupleDatabaseErrorToTriplitError(
  error: unknown
): unknown | Error | TriplitError {
  if (error instanceof Error) {
    switch (error.message) {
      case 'Transaction already committed':
        return new TransactionAlreadyCommittedError();
      case 'Transaction already canceled':
        return new TransactionAlreadyCanceledError();
      default:
        return error;
    }
  }
  return error;
}
