import { decodeToken, tokenIsExpired } from '../token.js';
import {
  IndexedDbUnavailableError,
  NoActiveSessionError,
  SessionRolesMismatchError,
  TokenExpiredError,
  UnrecognizedFetchPolicyError,
} from '../errors.js';
import { SyncEngine } from '../sync-engine.js';
import {
  ErrorCallback,
  ClientFetchOptions,
  InfiniteSubscription,
  PaginatedSubscription,
  QuerySyncState,
  SubscribeBackgroundOptions,
  SubscriptionOptions,
  SyncStatus,
  SubscriptionSignalPayload,
  TokenRefreshOptions,
  OnSessionErrorCallback,
  SyncOptions,
} from './types';
import { HttpClient } from '../http-client/http-client.js';
import { Logger } from '../@triplit/types/logger.js';
import { DefaultLogger } from '../client-logger.js';
import {
  DB as EntityDB,
  KVStore,
  DBTransaction,
  EntityStoreWithOutbox,
  createDB,
  ValuePointer,
  normalizeSessionVars,
  getRolesFromSession,
  sessionRolesAreEquivalent,
  Models,
  DBSchema,
  WriteModel,
  CollectionNameFromModels,
  SchemaQuery,
  FetchResult,
  ClearOptions,
  SubscriptionResultsCallback,
  TriplitError,
  ValueCursor,
  UpdatePayload,
  queryBuilder,
} from '@triplit/db';
import { BTreeKVStore } from '@triplit/db/storage/memory-btree';
import { IndexedDbKVStore } from '@triplit/db/storage/indexed-db';
import { compareCursors } from '../pagination.js';
import {
  ClientOptions,
  ClientTransactOptions,
  ConnectionOptionsChange,
  ConnectionOptionsChangeHandler,
  SimpleStorageOrInstances,
} from './types/client.js';
import { WebSocketTransport } from '../transport/websocket-transport.js';

/**
 * Friendly alias for Models type.
 */
export type ClientSchema = Models;

// Could probably make this an option if you want client side validation
const SKIP_RULES = true;

const SESSION_ROLES_KEY = 'SESSION_ROLES';

function getClientStorage(storageOption: SimpleStorageOrInstances): KVStore {
  if (
    typeof storageOption === 'object' &&
    !('type' in storageOption && 'name' in storageOption)
  ) {
    return storageOption as KVStore;
  }

  const storageType =
    typeof storageOption === 'object' ? storageOption.type : storageOption;

  const storageName =
    typeof storageOption === 'object' ? storageOption.name : 'triplit';

  if (storageType === 'indexeddb') {
    if (typeof indexedDB === 'undefined') {
      throw new IndexedDbUnavailableError();
    }
    // TODO: create a default IndexedDbKVStore
    // @ts-expect-error
    return new IndexedDbKVStore(storageName);
  }
  return new BTreeKVStore();
}

const DEFAULT_STORAGE_OPTION = 'memory';

// default policy is local-and-remote and no timeout
const DEFAULT_FETCH_OPTIONS = {
  policy: 'local-first',
} as const;

export class TriplitClient<M extends Models<M> = Models> {
  awaitReady: Promise<void> | null = null;
  // @ts-expect-error
  db: EntityDB<M, EntityStoreWithOutbox>;
  /**
   * The sync engine is responsible for managing the connection to the server and syncing data
   */
  syncEngine: SyncEngine;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  private _token: string | undefined = undefined;
  private claimsPath: string | undefined = undefined;

  private _serverUrl: string | undefined = undefined;

  private readonly skipRules: boolean = SKIP_RULES;

  readonly syncSchema: boolean;

  http: HttpClient<M>;

  private defaultFetchOptions: {
    fetch: ClientFetchOptions;
  };
  logger: Logger;
  /**
   * Logs are only stored in `debug` mode
   */
  readonly logs: any[] = [];

  private connectOnInitialization: boolean;

  /**
   *
   * @param options - The {@link ClientOptions | options} for the client
   */
  constructor(options: ClientOptions<M> = {}) {
    this.connectOnInitialization = options.autoConnect ?? true;
    const dbSchema = options.schema
      ? { collections: options.schema, roles: options.roles }
      : undefined;
    const storage = getClientStorage(
      options?.storage ?? DEFAULT_STORAGE_OPTION
    );
    this.syncSchema = options.syncSchema ?? false;
    this.awaitReady = createDB({
      schema: dbSchema,
      variables: options.variables,
      entityStore: new EntityStoreWithOutbox(storage),
      kv: storage,
      clientId: Math.random().toString(36).substring(7),
      ivmOptions: {
        shouldTrackChanges: false,
      },
    }).then((db) => {
      // If we have a session set up at this point, use that info
      const decoded = this.token
        ? decodeToken(this.token, this.claimsPath)
        : {};
      // @ts-expect-error
      this.db = db.withSessionVars(decoded);
      this.onConnectionOptionsChange((changes) => {
        if ('token' in changes) {
          const decoded = changes.token
            ? decodeToken(changes.token, this.claimsPath)
            : {};
          this.db = this.db.withSessionVars(decoded);
        }
      });
      this.db.onCommit(
        // @ts-expect-error
        throttle(
          async (tx) => {
            await this.db.updateQueryViews();
            this.db.broadcastToQuerySubscribers();
            if (this.syncEngine.connectionStatus !== 'OPEN') return;
            await this.syncEngine.syncWrites();
          },
          20,
          { leading: false, trailing: true }
        )
      );
      this.db.onSchemaChange((change) => {
        if (change.successful) {
          this.http.updateOptions({
            schema: change.newSchema.collections as M,
          });
        }
      });
      if (this.syncSchema) {
        this.subscribeBackground(
          this.db
            .query(
              // @ts-expect-error
              '_metadata'
            )
            .Id('_schema'),
          {
            onError: () => {
              console.warn('Schema sync disconnected');
            },
          }
        );
      }
      return Promise.resolve().then(() => {
        this.awaitReady = null;
      });
    });

    this.logger =
      options.logger ??
      new DefaultLogger({
        scope: 'client',
        level: options.logLevel,
        // Use debug mode as a proxy for dev mode
        onLog:
          options.logLevel === 'debug'
            ? (log) => this.logs.push(log)
            : () => {},
      });

    this.claimsPath = options.claimsPath;

    this.defaultFetchOptions = {
      fetch: DEFAULT_FETCH_OPTIONS,
      ...options.defaultQueryOptions,
    };

    validateServerUrl(options.serverUrl);
    this._serverUrl = options.serverUrl;

    this.http = new HttpClient<M>({
      serverUrl: this._serverUrl,
      token: this._token,
      schemaFactory: async () => (await this.getSchema())?.collections as M,
    });
    this.onConnectionOptionsChange((options) => {
      this.http.updateOptions(options);
    });

    this.syncEngine = new SyncEngine(this, {
      transport: options.transport,
      logger: this.logger.scope('sync'),
    });

    if (options.onSessionError) {
      this.onSessionError(options.onSessionError);
    }

    // If we provide a token in the constructor, start a session
    if (options.token) {
      // Asynchronously starts the session if a token is provided
      // We will NOT auto connect to allow any disconnect signals to flow through
      this.startSession(options.token, false, options.refreshOptions).then(
        async () => {
          if (this.connectOnInitialization) {
            const params = await this.syncEngine.getConnectionParams();
            this.syncEngine.createConnection(params);
          }
        }
      );
    }
  }

  /**
   * Gets the schema of the database
   *
   * @returns The schema of the database as a Javascript object
   */
  // TODO: eval if this should return full db schema or just collections
  async getSchema(): Promise<DBSchema<M> | undefined> {
    if (this.awaitReady) await this.awaitReady;
    return this.db.getSchema();
  }

  /**
   * Run a transaction with the client.
   *
   * @param callback - The callback to run within the transaction
   * @returns An object with the transaction ID and the output of the transaction
   */
  async transact<Output>(
    callback: (tx: DBTransaction<M>) => Promise<Output>,
    options: Partial<ClientTransactOptions> = {}
  ): Promise<Output> {
    if (this.awaitReady) await this.awaitReady;
    this.logger.debug('transact START');
    const resp = await this.db.transact(callback, {
      ...options,
      skipRules: this.skipRules,
    });
    this.logger.debug('transact END', resp);
    return resp;
  }

  /**
   * Initializes a query builder for a collection. Chain methods such as `where`, `order`, `limit`, etc. to build a query.
   *
   * @param collectionName - The name of the collection to query
   * @returns A query builder for the collection
   */
  query<CN extends CollectionNameFromModels<M>>(collectionName: CN) {
    return queryBuilder<M, CN>(collectionName);
  }

  /**
   * Fetches data from the database.
   *
   * @param query - The query to fetch
   * @param options - The fetch options
   * @param options.policy - The fetch policy to use. Determines if the operation will retrieve data from the cache and/or the server. Defaults to `local-first`.
   * @returns The fetched data as a map of entities
   */
  async fetch<Q extends SchemaQuery<M>>(
    query: Q,
    options?: Partial<ClientFetchOptions>
  ): Promise<FetchResult<M, Q, 'many'>> {
    if (this.awaitReady) await this.awaitReady;
    // ID is currently used to trace the lifecycle of a query/subscription across logs
    query = addTraceIdToQuery(query);

    const opts = { ...this.defaultFetchOptions.fetch, ...(options ?? {}) };
    if (opts.policy === 'local-only') {
      return this.fetchLocal(query, opts);
    }

    if (opts.policy === 'local-first') {
      const isFirstTimeFetchingQuery =
        await this.syncEngine.isFirstTimeFetchingQuery(query);
      // TODO: manage potential failure case where it looks like we're going to sync
      // but then we fail and then need to reject the promise
      if (!(isFirstTimeFetchingQuery && this.probablyIntendsToConnect))
        return await this.fetchLocal(query, opts);
      try {
        await this.syncEngine.syncQuery(query);
      } catch (e) {
        warnError(e);
      }
      return this.fetchLocal(query, opts);
    }

    if (opts.policy === 'remote-first') {
      if (this.probablyIntendsToConnect) {
        try {
          await this.syncEngine.syncQuery(query);
        } catch (e) {
          warnError(e);
        }
      }
      return this.fetchLocal(query, opts);
    }

    if (opts.policy === 'remote-only') {
      return this.http.fetch(query);
    }

    if (opts.policy === 'local-and-remote') {
      const timeout = opts.timeout ?? 0;
      await Promise.race([
        this.syncEngine.syncQuery(query),
        new Promise((res) => setTimeout(res, timeout)),
      ]).catch(warnError);
      return this.fetchLocal(query, opts);
    }

    throw new UnrecognizedFetchPolicyError((opts as ClientFetchOptions).policy);
  }

  private async fetchLocal<Q extends SchemaQuery<M>>(
    query: Q,
    options?: Partial<ClientFetchOptions>
  ): Promise<FetchResult<M, Q, 'many'>> {
    this.logger.debug('fetchLocal START', query);
    const res = await this.db.fetch(query, {
      skipRules: this.skipRules,
      ...(options ?? {}),
    });
    this.logger.debug('fetchLocal END', res);
    return res;
  }

  /**
   * Fetches a single entity by its id from the database.
   *
   * @param collectionName - The name of the collection to fetch from
   * @param id - The id of the entity to fetch
   * @param options - The fetch options
   * @returns The fetched entity or null if it does not exist
   */
  async fetchById<CN extends CollectionNameFromModels<M>>(
    collectionName: CN,
    id: string,
    options?: Partial<ClientFetchOptions>
  ): Promise<FetchResult<M, { collectionName: CN }, 'one'>> {
    this.logger.debug('fetchById START', collectionName, id, options);
    const query = this.query(collectionName).Id(id);
    const result = await this.fetchOne<{ collectionName: CN }>(query, options);
    this.logger.debug('fetchById END', collectionName, id, options);
    return result;
  }

  /**
   * Clears the local database of the client. Does not affect the server.
   *
   * @param options - The clear options
   * - `full`: If true, clears the entire database. If false, only clears your application data. Defaults to `false`.
   * @returns a promise that resolves when the database has been cleared
   */
  async clear(options: ClearOptions = {}) {
    if (this.awaitReady) await this.awaitReady;
    return this.db.clear(options);
  }

  async reset(options: ClearOptions = {}) {
    this.syncEngine.resetQueryState();
    await this.clear(options);
  }

  /**
   * Fetches the first entity in the database that matches the query.
   *
   * @param query - The query to fetch
   * @param options - The fetch options
   * @returns The fetched entity or null if it does not exist
   */
  async fetchOne<Q extends SchemaQuery<M>>(
    query: Q,
    options?: Partial<ClientFetchOptions>
  ): Promise<FetchResult<M, Q, 'one'>> {
    // ID is currently used to trace the lifecycle of a query/subscription across logs
    query = addTraceIdToQuery(query);
    query = { ...query, limit: 1 };
    const result = await this.fetch(query, options);
    const entity = [...result.values()][0];
    if (!entity) return null;
    return entity;
  }

  /**
   * Inserts an entity into the database.
   *
   * @param collectionName - The name of the collection to insert into
   * @param object - The entity to insert
   * @returns The transaction ID and the inserted entity, if successful
   */
  async insert<CN extends CollectionNameFromModels<M>>(
    collectionName: CN,
    object: WriteModel<M, CN>
  ) {
    if (this.awaitReady) await this.awaitReady;
    this.logger.debug('insert START', collectionName, object);
    const resp = await this.db.insert(collectionName, object, {
      skipRules: this.skipRules,
    });
    this.logger.debug('insert END', resp);
    return resp;
  }

  /**
   * Updates an entity in the database.
   *
   * @param collectionName - The name of the collection to update
   * @param entityId - The id of the entity to update
   * @param updater - A function that provides the current entity and allows you to modify it
   * @returns The transaction ID
   */
  async update<CN extends CollectionNameFromModels<M>>(
    collectionName: CN,
    entityId: string,
    data: UpdatePayload<M, CN>
  ) {
    if (this.awaitReady) await this.awaitReady;
    this.logger.debug('update START', collectionName, entityId);
    const resp = await this.db.update(collectionName, entityId, data, {
      skipRules: this.skipRules,
    });
    this.logger.debug('update END', resp);
    return resp;
  }

  /**
   * Deletes an entity from the database.
   *
   * @param collectionName - The name of the collection to delete from
   * @param entityId - The id of the entity to delete
   * @returns The transaction ID
   */
  async delete<CN extends CollectionNameFromModels<M>>(
    collectionName: CN,
    entityId: string
  ) {
    if (this.awaitReady) await this.awaitReady;
    this.logger.debug('delete START', collectionName, entityId);
    const resp = await this.db.delete(collectionName, entityId, {
      skipRules: this.skipRules,
    });
    this.logger.debug('delete END', resp);
    return resp;
  }

  async entityIsInCache(
    collection: string,
    entityId: string
  ): Promise<boolean> {
    return !!this.db.entityStore.doubleBuffer.getChangesForEntity(
      this.db.kv,
      collection,
      entityId
    );
  }

  // TODO: refactor so some logic is shared across policies (ex starting a local and remote sub is verbose and repetitive)
  /**
   * Subscribes to a client query and receives the results asynchronously.
   *
   * @param query - The client query to subscribe to.
   * @param onResults - The callback function to handle the results of the subscription.
   * @param onError - The callback function to handle any errors that occur during the subscription.
   * @param options - The options for the subscription.
   * @param options.localOnly - If true, the subscription will only use the local cache. Defaults to false.
   * @param options.onRemoteFulfilled - An optional callback that is called when the remote query has been fulfilled.
   * @returns - A function that can be called to unsubscribe from the subscription.
   */
  subscribe<Q extends SchemaQuery<M>>(
    query: Q,
    onResults: SubscriptionResultsCallback<M, Q>,
    onError?: ErrorCallback,
    options?: Partial<SubscriptionOptions>
  ) {
    // Flag to short circuit sub fires after async unsubscribe process
    // MUST be set synchronously on unsubscribe
    let unsubscribed = false;
    const unsubPromise = (async () => {
      if (this.awaitReady) await this.awaitReady;
      const opts: SubscriptionOptions = {
        localOnly: false,
        ...(options ?? {}),
      };
      // ID is currently used to trace the lifecycle of a query/subscription across logs
      query = addTraceIdToQuery(query);
      this.logger.debug('subscribe start', query);
      const userResultsCallback = onResults;
      const userErrorCallback = onError;
      onResults = async (results) => {
        let filteredResults = results;
        // Ensure we dont re-fire the callback if we've already unsubscribed
        if (unsubscribed) return;
        if (options?.syncStatus && options.syncStatus !== 'all') {
          // TODO: is it an issue that we have an async function here?
          filteredResults = await this.filterResultsWithSyncStatus(
            results,
            query.collectionName,
            options.syncStatus
          );
        }
        userResultsCallback(filteredResults);
      };
      onError = userErrorCallback
        ? (error) => {
            // Ensure we dont re-fire the callback if we've already unsubscribed
            if (unsubscribed) return;
            userErrorCallback(error);
          }
        : undefined;

      const unsubscribeLocal = this.db.subscribe(query, onResults, onError, {
        skipRules: this.skipRules,
        ...opts,
      });

      // trigger initial local results
      await this.db.updateQueryViews();
      this.db.broadcastToQuerySubscribers();

      let unsubscribeRemote = Promise.resolve(() => {});
      if (!opts.localOnly) {
        unsubscribeRemote = this.syncEngine.subscribe(query, {
          onQueryFulfilled: opts.onRemoteFulfilled,
          onQueryError: onError,
          onQuerySyncStateChange: opts.onQuerySyncStateChange,
        });
      }

      return () => {
        unsubscribed = true;
        unsubscribeLocal();
        unsubscribeRemote.then((unsub) => unsub());
      };
    })();
    return () => {
      unsubPromise.then((unsub) => unsub());
    };
  }

  private get probablyIntendsToConnect() {
    return (
      this.connectionStatus === 'OPEN' ||
      (!!this.connectOnInitialization &&
        !!this.token &&
        !!this.serverUrl &&
        this.connectionStatus !== 'CLOSED' &&
        this.connectionStatus !== 'CLOSING')
    );
  }

  subscribeWithStatus<Q extends SchemaQuery<M>>(
    query: Q,
    callback: (state: SubscriptionSignalPayload<M, Q>) => void,
    options?: Partial<SubscriptionOptions>
  ): () => void {
    let results: FetchResult<M, Q, 'many'> | undefined = undefined;
    let waitingOnRemoteSync =
      this.probablyIntendsToConnect && !options?.localOnly;
    let fetchingLocal = true;
    let fetchingRemote = false;
    let error: any = undefined;
    // This gets updated async by isFirstTimeFetchingQuery
    // it will lead to extra "loading" time if that takes a while
    let isInitialFetch = true;
    const fetching = () =>
      fetchingLocal || (isInitialFetch && waitingOnRemoteSync);

    function fireSignal() {
      callback({
        results,
        error,
        fetching: fetching(),
        fetchingLocal,
        fetchingRemote,
      });
    }
    fireSignal();
    const unsubConnectionStatus = this.onConnectionStatusChange((status) => {
      if (status === 'CLOSING' || status === 'CLOSED') {
        let shouldFire = false;
        if (fetchingRemote) {
          fetchingRemote = false;
          shouldFire = true;
        }
        if (waitingOnRemoteSync) {
          waitingOnRemoteSync = false;
          shouldFire = true;
        }
        if (shouldFire) {
          fireSignal();
        }
        return;
      }
    }, true);
    // This _should_ return faster than the local results
    this.isFirstTimeFetchingQuery(query).then((isFirstTime) => {
      if (isInitialFetch !== isFirstTime) {
        const lastLoadingStatus = fetching();
        isInitialFetch = isFirstTime;
        // little insider knowledge here that it's only
        // going to affect `fetching` if we are waiting on the remote
        if (fetching() !== lastLoadingStatus) {
          fireSignal();
        }
      }
    });
    const unsub = this.subscribe(
      query,
      (newResults) => {
        // TODO: fast way to tell if these results are new? or perhaps that is a concern
        // of client.subscribe (base method)
        results = newResults;
        fetchingLocal = false;
        error = undefined;
        if (fetchingRemote) {
          fetchingRemote = !this.syncEngine.hasServerRespondedForQuery(query);
          waitingOnRemoteSync = fetchingRemote;
        }
        fireSignal();
      },
      (err) => {
        error = err;
        // TODO: this will fire on remote and local errors... can we isolate them?
        fetchingLocal = false;
        fireSignal();
      },
      {
        ...(options ?? {}),
        onQuerySyncStateChange: (status: QuerySyncState) => {
          // TODO: connected to TODO above, likely dupe to the onError callbackProvided above
          if (status === 'FULFILLED' || status === 'ERROR') {
            if (!fetchingRemote) return;
            fetchingRemote = false;
            waitingOnRemoteSync = false;
            fireSignal();
          }
          if (status === 'IN_FLIGHT' && !fetchingRemote) {
            fetchingRemote = true;
            fireSignal();
          }
          // TODO: add ERROR or FULFILLED handlers here?
        },
      }
    );
    return () => {
      unsub();
      unsubConnectionStatus();
    };
  }

  private async filterResultsWithSyncStatus(
    results: any[],
    collectionName: string,
    syncStatus: SyncStatus
  ) {
    const bufferContents =
      await this.db.entityStore.doubleBuffer.getChangesForCollection(
        this.db.kv,
        collectionName
      );

    if (bufferContents) {
      return syncStatus === 'pending'
        ? results.filter((e) => bufferContents.sets.has(e.id))
        : results.filter((e) => !bufferContents.sets.has(e.id));
    } else if (syncStatus === 'pending') {
      return [];
    }
    return results;
  }

  /**
   * Syncs a query to your local database in the background. This is useful to pre-fetch a larger portion of data and used in combination with local-only subscriptions.
   */
  subscribeBackground<Q extends SchemaQuery<M>>(
    query: Q,
    options: SubscribeBackgroundOptions = {}
  ) {
    // TODO: properly implement synchronous unsub
    const unsubPromise = (async () => {
      if (this.awaitReady) await this.awaitReady;
      return this.syncEngine.subscribe(query, {
        onQueryFulfilled: options.onFulfilled,
        onQueryError: options.onError,
      });
    })();
    return () => {
      unsubPromise.then((unsub) => unsub());
    };
  }

  /**
   * Subscribe to a query with helpers for pagination
   * This query will "oversubscribe" by 1 on either side of the current page to determine if there are "next" or "previous" pages
   * The window generally looks like [buffer, ...page..., buffer]
   * Depending on the current paging direction, the query may have its original order reversed
   *
   * The pagination will also do its best to always return full pages
   * @param query - The query, which should have a `limit`, to subscribe to.
   * @param onResults - The callback function to handle the results of the subscription.
   * @param onError - The callback function to handle any errors that occur during the subscription.
   * @param options - The options for the subscription.
   * @returns An object containing functions that can be called to unsubscribe from the subscription and query the previous and next pages.
   */
  subscribeWithPagination<Q extends SchemaQuery<M>>(
    query: Q,
    onResults: (
      results: FetchResult<M, Q, 'many'>,
      info: {
        hasNextPage: boolean;
        hasPreviousPage: boolean;
      }
    ) => void | Promise<void>,
    onError?: (error: any) => void | Promise<void>,
    options?: Partial<SubscriptionOptions>
  ): PaginatedSubscription {
    // Add stable order to query
    if (
      query.order &&
      query.order.length > 0 &&
      query.order.at(-1)![0] !== 'id'
    ) {
      // @ts-expect-error
      query.order = [...query.order, ['id', 'ASC']];
    }

    const returnValue: Partial<PaginatedSubscription> = {};
    const requestedLimit = query.limit;
    let subscriptionResultHandler = (results: any) => {
      onResults(results, {
        hasNextPage: false,
        hasPreviousPage: false,
      });
    };
    returnValue.nextPage = () => {
      console.warn(
        'There is no limit set on the query, so nextPage() is a no-op'
      );
    };
    returnValue.prevPage = () => {
      console.warn(
        'There is no limit set on the query, so prevPage() is a no-op'
      );
    };

    // Range of the current page
    let rangeStart: ValueCursor | undefined = undefined;
    let rangeEnd: ValueCursor | undefined = undefined;

    // The current paging direction of the query
    // If we are paging backwards, we need to reverse the order of the query (flip order of query, reverse results to maintain original query order)
    let pagingDirection: 'forward' | 'reversed' = 'forward';

    // If we have a limit, handle pagination
    if (query.limit) {
      query = { ...query };
      // If we have an after, the limit will increase by 1
      query.limit = requestedLimit! + 1 + (query.after ? 1 : 0);
      subscriptionResultHandler = (results: any) => {
        const cursorAttr = query.order?.[0]?.[0];

        // TODO: maybe use onError?
        if (!cursorAttr)
          throw new TriplitError('No cursor attribute found in query order');

        const firstResult = results.at(0);

        // Calculate if can move the window forward or backward
        // This is forward/backward from the perspective of the current paging direction (not the original query)
        // If there is an after param (ie not at the start of the data), and the first entry (prev page buffer) is lte the after cursor
        const canMoveWindowBackward =
          !!query.after &&
          !!firstResult &&
          compareCursors(
            query.after[0],
            query.order!.map((o) =>
              ValuePointer.Get(firstResult, o[0].split('.'))
            ) as ValueCursor
          ) > -1;

        // If we have overflowing data, we can move the window forward
        const canMoveWindowForward = results.length >= query.limit!; // Pretty sure this cant be gt, but still

        // If we can page forward or backward (from the perspective of the original query)
        const hasPreviousPage =
          pagingDirection === 'reversed'
            ? canMoveWindowForward
            : canMoveWindowBackward;
        const hasNextPage =
          pagingDirection === 'forward'
            ? canMoveWindowForward
            : canMoveWindowBackward;

        // Remove buffered data
        results = results.slice(
          canMoveWindowBackward ? 1 : 0,
          canMoveWindowForward ? -1 : undefined
        );

        const firstDataResult = results.at(0);
        const lastDataResult = results.at(requestedLimit! - 1);

        // Track range of the current page for pagination functions
        rangeStart = firstDataResult
          ? (query.order!.map((o) =>
              ValuePointer.Get(firstDataResult, o[0].split('.'))
            ) as ValueCursor)
          : undefined;
        rangeEnd = lastDataResult
          ? (query.order!.map((o) =>
              ValuePointer.Get(lastDataResult, o[0].split('.'))
            ) as ValueCursor)
          : undefined;

        // To keep order consistent with the orignial query, reverse the entries if we are paging backwards
        if (pagingDirection === 'reversed') results = results.reverse();

        // If we have paged back to the start, drop the after cursor to "reset" the query
        // This helps us ensure we always have a full page of data
        if (!hasPreviousPage && !!query.after) {
          returnValue.unsubscribe?.();
          query = { ...query };
          query.after = undefined;
          query.limit = requestedLimit! + 1;
          if (pagingDirection === 'reversed')
            query.order = flipOrder(query.order);
          pagingDirection = 'forward';
          returnValue.unsubscribe = this.subscribe(
            query,
            subscriptionResultHandler,
            onError,
            options
          );
        } else {
          onResults(results, {
            hasNextPage: hasNextPage,
            hasPreviousPage: hasPreviousPage,
          });
        }
      };

      returnValue.nextPage = () => {
        // Unsubscribe from the current subscription
        returnValue.unsubscribe?.();
        query = { ...query };
        // Handle direction change
        if (pagingDirection === 'reversed') {
          query.order = flipOrder(query.order);
          query.after = rangeStart ? [rangeStart, true] : undefined;
        } else {
          // If moving off of first page (ie no after), update limit
          if (!query.after) query.limit = query.limit! + 1;
          query.after = rangeEnd ? [rangeEnd, true] : undefined;
        }
        pagingDirection = 'forward';

        // resubscribe with the new query
        returnValue.unsubscribe = this.subscribe(
          query,
          subscriptionResultHandler,
          onError,
          options
        );
      };
      returnValue.prevPage = () => {
        // Unsubscribe from the current subscription
        returnValue.unsubscribe?.();
        query = { ...query };
        // Handle direction change
        if (pagingDirection === 'forward') {
          query.order = flipOrder(query.order);
          query.after = rangeStart ? [rangeStart, true] : undefined;
        } else {
          query.after = rangeEnd ? [rangeEnd, true] : undefined;
        }
        pagingDirection = 'reversed';

        // resubscribe with the new query
        returnValue.unsubscribe = this.subscribe(
          query,
          subscriptionResultHandler,
          onError,
          options
        );
      };
    }

    returnValue.unsubscribe = this.subscribe(
      query,
      subscriptionResultHandler,
      onError,
      options
    );

    return returnValue as PaginatedSubscription;
  }

  /**
   * Subscribes to a client query with the ability to expand size of the results.
   *
   * @param query - The query, which should have a `limit` set, to subscribe to.
   * @param onResults - The callback function to handle the query results.
   * @param onError - The callback function to handle any errors that occur during the subscription.
   * @param options - The options for the subscription.
   * @returns An object containing functions to load more data and to unsubscribe from the subscription.
   */
  subscribeWithExpand<Q extends SchemaQuery<M>>(
    query: Q,
    onResults: (
      results: FetchResult<M, Q, 'many'>,
      info: {
        hasMore: boolean;
      }
    ) => void | Promise<void>,
    onError?: (error: any) => void | Promise<void>,
    options?: Partial<SubscriptionOptions>
  ): InfiniteSubscription {
    const returnValue: Partial<InfiniteSubscription> = {};
    let subscriptionResultHandler = (results: any) => {
      onResults(results, {
        hasMore: false,
      });
    };
    returnValue.loadMore = () => {
      console.warn(
        'There is no limit set on the query, so loadMore is a no-op'
      );
    };
    if (query.limit) {
      // Add stable order to query
      if (!query.order || query.order.at(-1)?.[0] !== 'id') {
        // @ts-expect-error
        query.order = [...(query.order ?? []), ['id', 'ASC']];
      }
      const originalPageSize = query.limit;
      query = { ...query };
      query.limit = query.limit! + 1;
      subscriptionResultHandler = (results: any) => {
        const hasMore = results.length >= query.limit!;
        results = Array.from(results);
        if (hasMore) results = results.slice(0, -1);
        onResults(results, {
          hasMore,
        });
      };

      returnValue.loadMore = (pageSize?: number) => {
        returnValue.unsubscribe?.();
        query = { ...query };
        query.limit = (query.limit ?? 1) + (pageSize ?? originalPageSize);
        returnValue.unsubscribe = this.subscribe(
          query,
          subscriptionResultHandler,
          onError,
          options
        );
      };
    }
    returnValue.unsubscribe = this.subscribe(
      query,
      subscriptionResultHandler,
      onError,
      options
    );

    return returnValue as InfiniteSubscription;
  }
  /**
   * Updates the `token` or `serverUrl` of the client and will inform subscribers. Only will fire to subscribers if the value(s) have changed.
   *
   * @param options - The options to update the client with
   */
  private updateConnectionOptions(change: ConnectionOptionsChange) {
    const { token, serverUrl, tokenRefresh } = change;
    const hasTokenChange =
      change.hasOwnProperty('token') && token !== this.token;
    const hasServerUrlChange =
      change.hasOwnProperty('serverUrl') && serverUrl !== this.serverUrl;
    let updatedSyncOptions: Partial<ConnectionOptionsChange> = {};

    // handle updating the token and variables for auth purposes
    if (hasTokenChange) {
      // TODO: validate is jwt
      updatedSyncOptions = { ...updatedSyncOptions, token, tokenRefresh };
    }

    // handle updating the server url for sync purposes
    if (hasServerUrlChange) {
      validateServerUrl(serverUrl);
      updatedSyncOptions = { ...updatedSyncOptions, serverUrl };
    }

    if (hasTokenChange || hasServerUrlChange) {
      if (hasTokenChange) this._token = token;
      if (hasServerUrlChange) this._serverUrl = serverUrl;
      for (const handler of this.connectionOptionsChangeHandlers) {
        handler(updatedSyncOptions);
      }
    }
  }

  /**
   * Starts a new sync session with the provided token
   *
   * @param token - The token to start the session with
   * @param connect - If true, the client will automatically connect to the server after starting the session. Defaults to true.
   * @param refreshOptions - Options for refreshing the token
   * @param refreshOptions.interval - The interval in milliseconds to refresh the token. If not provided, the token will be refreshed 500ms before it expires.
   * @param refreshOptions.handler - The function to call to refresh the token. It returns a promise that resolves with the new token.
   */
  async startSession(
    token: string,
    connect = true,
    refreshOptions?: TokenRefreshOptions
  ) {
    // 1. determine the new token
    if (token) {
      if (tokenIsExpired(decodeToken(token, this.claimsPath))) {
        if (!refreshOptions?.refreshHandler) {
          // should we centralize this in
          throw new TokenExpiredError();
        }
        const maybeToken = await refreshOptions.refreshHandler();
        if (!maybeToken) {
          console.warn(
            'An expired token was passed to startSession, and the refreshHandler was unable to provide a new token. Session will not be started'
          );
          // TODO: should this end the current session?
          return;
        }
        token = maybeToken;
      }
    }

    // 2. If the new token is already the current token, do nothing
    if (token === this.token) return;

    // 3. End previous session
    if (this.token) this.endSession();

    // 4. Update the client token
    this.updateToken(token);

    // 5. If we should connect, do that
    if (connect) await this.connect();

    // 6. Set up a token refresh handler if provided
    // Setup token refresh handler
    if (!refreshOptions) return;
    const { interval, refreshHandler } = refreshOptions;
    const setRefreshTimeoutForToken = (refreshToken: string) => {
      const decoded = decodeToken(refreshToken);
      if (!decoded.exp && !interval) return;
      let delay = interval ?? decoded.exp * 1000 - Date.now() - 1000;
      if (delay < 1000) {
        this.logger.warn(
          `The minimum allowed refresh interval is 1000ms, the ${interval ? 'provided interval' : 'interval determined from the provided token'} was ${Math.round(delay)}ms.`
        );
        delay = 1000;
      }
      this.tokenRefreshTimer = setTimeout(async () => {
        const maybeFreshToken = await refreshHandler();
        if (!maybeFreshToken) {
          this.logger.warn(
            'The token refresh handler did not return a new token, ending the session.'
          );
          this.endSession();
          return;
        }
        await this.updateSessionToken(maybeFreshToken);
        setRefreshTimeoutForToken(maybeFreshToken);
      }, delay);
    };
    setRefreshTimeoutForToken(token);
    return () => {
      this.resetTokenRefreshHandler();
    };
  }

  /**
   * Disconnects the client from the server and ends the current sync session.
   */
  endSession() {
    this.resetTokenRefreshHandler();
    this.disconnect();
    this.updateToken(undefined);
    this.syncEngine.resetQueryState();
  }

  /**
   * Attempts to update the token of the current session, which re-use the current connection. If the new token does not have the same roles as the current session, an error will be thrown.
   */
  async updateSessionToken(token: string) {
    if (this.awaitReady) await this.awaitReady;
    if (!this.token) {
      throw new NoActiveSessionError();
    }
    const decodedToken = decodeToken(token);
    if (tokenIsExpired(decodedToken)) {
      throw new TokenExpiredError();
    }
    // probably could just get this from the client constructor options?
    // if we guarantee that the client is always using that schema
    const sessionRoles = getRolesFromSession(
      this.db.schema,
      normalizeSessionVars(decodedToken)
    );
    if (!sessionRolesAreEquivalent(this.db.session?.roles, sessionRoles)) {
      throw new SessionRolesMismatchError();
    }
    this.updateToken(token, true);
    const didSend = this.syncEngine.updateTokenForSession(token);
    if (!didSend) {
      // There is a chance the message to update the token wont send, for safety just try again once more
      const sentAfterDelay = await new Promise<boolean>((res, rej) =>
        setTimeout(
          () => res(this.syncEngine.updateTokenForSession(token)),
          1000
        )
      );
      if (!sentAfterDelay)
        // TODO: end session?
        // If this throws, we should evaluate how to handle different states of our websocket transport and if/when we should queue messages
        throw new TriplitError(
          'Failed to update the session token for the current session.'
        );
    }
  }

  resetTokenRefreshHandler() {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }

  onSessionError(callback: OnSessionErrorCallback) {
    return this.syncEngine.onSessionError(callback);
  }

  async updateGlobalVariables(vars: Record<string, any>): Promise<void> {
    if (this.awaitReady) await this.awaitReady;
    this.db.updateGlobalVariables(vars);
  }

  /**
   * Updates the `token` of the client. This will cause the client to close its current connection to the server and attempt reopen a new one with the provided token.
   *
   * @param token
   */
  private updateToken(token: string | undefined, refresh?: boolean) {
    this.updateConnectionOptions({ token, tokenRefresh: refresh });
  }

  /**
   * Updates the `serverUrl` of the client. This will cause the client to close its current connection to the server and attempt reopen a new one with the provided server URL.
   *
   * @param serverUrl
   */
  updateServerUrl(serverUrl: string | undefined) {
    this.updateConnectionOptions({ serverUrl });
  }

  /**
   * Sets up a listener for connection status changes
   * @param callback A callback that will be called when the connection status changes
   * @param runImmediately Run the callback immediately with the current connection status
   * @returns A function that removes the callback from the connection status change listeners
   */
  onConnectionStatusChange(
    ...args: Parameters<typeof this.syncEngine.onConnectionStatusChange>
  ) {
    return this.syncEngine.onConnectionStatusChange(...args);
  }

  /**
   * Attempts to connect the client to the server. This will start the client syncing data with the server.
   */
  connect() {
    return this.syncEngine.connect();
  }

  /**
   * Disconnects the client from the server. This will stop the client from syncing data with the server.
   */
  disconnect() {
    return this.syncEngine.disconnect();
  }

  /**
   * The token used to authenticate with the server
   */
  get token() {
    return this._token;
  }

  get serverUrl() {
    return this._serverUrl;
  }

  onSyncMessageReceived(
    ...args: Parameters<typeof this.syncEngine.onSyncMessageReceived>
  ) {
    return this.syncEngine.onSyncMessageReceived(...args);
  }
  onSyncMessageSent(
    ...args: Parameters<typeof this.syncEngine.onSyncMessageSent>
  ) {
    return this.syncEngine.onSyncMessageSent(...args);
  }
  onEntitySyncSuccess(
    ...args: Parameters<typeof this.syncEngine.onEntitySyncSuccess>
  ) {
    return this.syncEngine.onEntitySyncSuccess(...args);
  }
  onEntitySyncError(
    ...args: Parameters<typeof this.syncEngine.onEntitySyncError>
  ) {
    return this.syncEngine.onEntitySyncError(...args);
  }

  onFailureToSyncWrites(
    ...args: Parameters<typeof this.syncEngine.onFailureToSyncWrites>
  ) {
    return this.syncEngine.onFailureToSyncWrites(...args);
  }

  /**
   * Manually send any pending writes to the remote database. This may be a no-op if:
   * - there is already a push in progress
   * - the connection is not open
   *
   * If the push is successful, it will return `success: true`. If the push fails, it will return `success: false` and a `failureReason`.
   */
  syncWrites(...args: Parameters<typeof this.syncEngine.syncWrites>) {
    return this.syncEngine.syncWrites(...args);
  }

  /**
   * The connection status of the client with the server
   */
  get connectionStatus() {
    return this.syncEngine.connectionStatus;
  }

  isFirstTimeFetchingQuery(
    ...args: Parameters<typeof this.syncEngine.isFirstTimeFetchingQuery>
  ) {
    return this.syncEngine.isFirstTimeFetchingQuery(...args);
  }

  async clearPendingChangesForEntity(
    ...args: Parameters<typeof this.syncEngine.clearPendingChangesForEntity>
  ) {
    return this.syncEngine.clearPendingChangesForEntity(...args);
  }

  async clearPendingChangesAll(
    ...args: Parameters<typeof this.syncEngine.clearPendingChangesAll>
  ) {
    return this.syncEngine.clearPendingChangesAll(...args);
  }

  private connectionOptionsChangeHandlers: Array<ConnectionOptionsChangeHandler> =
    [];
  onConnectionOptionsChange(
    callback: ConnectionOptionsChangeHandler
  ): () => void {
    this.connectionOptionsChangeHandlers.push(callback);
    return () => {
      this.connectionOptionsChangeHandlers =
        this.connectionOptionsChangeHandlers.filter((cb) => cb !== callback);
    };
  }
}

function addTraceIdToQuery<Q>(query: Q): Q & { traceId: string } {
  return { traceId: Math.random().toString().slice(2), ...query };
}

function mapServerUrlToSyncOptions(serverUrl: string) {
  const url = new URL(serverUrl);
  const secure = url.protocol === 'https:';
  const server = url.host;
  return { server, secure };
}

function warnError(e: any) {
  if (e instanceof TriplitError) {
    console.warn(e.toJSON());
  } else {
    console.warn(e);
  }
}

function flipOrder(order: any) {
  if (!order) return undefined;
  return order.map((o: any) => [o[0], o[1] === 'ASC' ? 'DESC' : 'ASC']);
}

function throttle<T>(
  func: (arg: T) => void,
  limit: number,
  options?: { leading?: boolean; trailing?: boolean }
): (arg: T) => void {
  let inThrottle: boolean;
  let lastArgs: T | null = null;
  return function () {
    const args = arguments as unknown as T;
    if (!inThrottle) {
      if (options?.leading !== false) {
        func(args);
      } else {
        lastArgs = args;
      }
      inThrottle = true;
      setTimeout(() => {
        if (options?.trailing && lastArgs) {
          func(lastArgs);
          lastArgs = null;
        }
        inThrottle = false;
      }, limit);
    } else {
      lastArgs = args;
    }
  };
}

function validateServerUrl(serverUrl: string | undefined): void {
  if (
    serverUrl &&
    !serverUrl.startsWith('http://') &&
    !serverUrl.startsWith('https://')
  ) {
    throw new TriplitError('Invalid serverUrl provided');
  }
}
