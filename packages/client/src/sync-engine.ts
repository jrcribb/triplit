import {
  CollectionQuery,
  TripleRow,
  TriplitError,
  constructEntities,
  hashSchemaJSON,
  schemaToJSON,
  stripCollectionFromId,
  convertEntityToJS,
  Timestamp,
  TripleStoreApi,
  FetchResult,
  Models,
  Unalias,
  ToQuery,
} from '@triplit/db';
import { SyncOptions, TriplitClient } from './client/triplit-client.js';
import { Subject } from 'rxjs';
import {
  ConnectionStatus,
  SyncTransport,
  TransportConnectParams,
} from './transport/transport.js';
import { WebSocketTransport } from './transport/websocket-transport.js';
import {
  ClientSyncMessage,
  CloseReason,
  ServerSyncMessage,
} from '@triplit/types/sync';
import {
  MissingConnectionInformationError,
  RemoteFetchFailedError,
  RemoteSyncFailedError,
} from './errors.js';
import { Value } from '@sinclair/typebox/value';
import { ClientQuery, SchemaClientQueries } from './client/types';
import { Logger } from '@triplit/types/logger';
import { genToArr } from '@triplit/db';
import { hashQuery } from './utils/query.js';

type OnMessageReceivedCallback = (message: ServerSyncMessage) => void;
type OnMessageSentCallback = (message: ClientSyncMessage) => void;

const QUERY_STATE_KEY = 'query-state';

/**
 * The SyncEngine is responsible for managing the connection to the server and syncing data
 */
export class SyncEngine {
  private transport: SyncTransport;

  private client: TriplitClient<any>;
  private syncOptions: SyncOptions;

  private txCommits$ = new Subject<string>();
  private txFailures$ = new Subject<{ txId: string; error: unknown }>();

  private connectionChangeHandlers: Set<(status: ConnectionStatus) => void> =
    new Set();
  private messageReceivedSubscribers: Set<OnMessageReceivedCallback> =
    new Set();
  private messageSentSubscribers: Set<OnMessageSentCallback> = new Set();

  logger: Logger;

  // Connection state - these are used to track the state of the connection and should reset on dis/reconnect
  private awaitingAck: Set<string> = new Set();
  private reconnectTimeoutDelay = 250;
  private reconnectTimeout: any;

  // Session state - these are used to track the state of the session and should persist across reconnections, but reset on reset()
  private queries: Map<
    string,
    {
      params: CollectionQuery<any, any>;
      fulfilled: boolean;
      responseCallbacks: Set<(response: any) => void>;
      subCount: number;
    }
  > = new Map();

  /**
   *
   * @param options configuration options for the sync engine
   * @param db the client database to be synced
   */
  constructor(client: TriplitClient<any>, options: SyncOptions) {
    this.client = client;
    this.logger = options.logger;
    this.syncOptions = options;
    this.syncOptions.secure = options.secure ?? true;
    this.syncOptions.syncSchema = options.syncSchema ?? false;
    this.transport = options.transport ?? new WebSocketTransport();
    this.txCommits$.subscribe((txId) => {
      const callbacks = this.commitCallbacks.get(txId);
      if (callbacks) {
        for (const callback of callbacks) {
          callback();
        }
        this.commitCallbacks.delete(txId);
        this.failureCallbacks.delete(txId);
      }
    });
    this.txFailures$.subscribe(({ txId, error }) => {
      const callbacks = this.failureCallbacks.get(txId);
      if (callbacks) {
        for (const callback of callbacks) {
          callback(error);
        }
      }
    });

    // Signal the server when there are triples to send
    const throttledSignal = throttle(() => this.signalOutboxTriples(), 100);
    this.db.tripleStore.setStorageScope(['outbox']).onInsert((inserts) => {
      if (!inserts['outbox']?.length) return;
      throttledSignal();
    });
  }

  /**
   * The token used to authenticate with the server
   */
  get token() {
    return this.syncOptions.token;
  }

  get db() {
    return this.client.db;
  }

  private get httpUri() {
    return this.syncOptions.server
      ? `${this.syncOptions.secure ? 'https' : 'http'}://${
          this.syncOptions.server
        }`
      : undefined;
  }

  onSyncMessageReceived(callback: OnMessageReceivedCallback) {
    this.messageReceivedSubscribers.add(callback);
    return () => {
      this.messageReceivedSubscribers.delete(callback);
    };
  }

  onSyncMessageSent(callback: OnMessageSentCallback) {
    this.messageSentSubscribers.add(callback);
    return () => {
      this.messageSentSubscribers.delete(callback);
    };
  }

  private async getConnectionParams(): Promise<TransportConnectParams> {
    const clientId = await this.db.getClientId();
    const schemaHash = hashSchemaJSON(
      schemaToJSON(await this.db.getSchema())?.collections
    );
    return {
      clientId,
      schema: schemaHash,
      syncSchema: this.syncOptions.syncSchema,
      token: this.syncOptions.token,
      server: this.syncOptions.server,
      secure: this.syncOptions.secure,
    };
  }

  private async getQueryState(queryId: string) {
    const queryState = await this.db.tripleStore.readMetadataTuples(
      QUERY_STATE_KEY,
      [queryId]
    );
    if (queryState.length === 0) return undefined;
    const stateVector = JSON.parse(queryState[0][2] as string);
    return stateVector;
  }

  async isFirstTimeFetchingQuery(query: CollectionQuery<any, any>) {
    await this.db.ready;
    const hash = hashQuery(query);
    const state = await this.getQueryState(hash);
    return state === undefined;
  }

  private async setQueryState(queryId: string, stateVector: Timestamp[]) {
    await this.db.tripleStore.updateMetadataTuples([
      [QUERY_STATE_KEY, [queryId], JSON.stringify(stateVector)],
    ]);
  }

  /**
   * @hidden
   */
  subscribe(params: CollectionQuery<any, any>, onQueryFulfilled?: () => void) {
    const id = hashQuery(params);
    if (!this.queries.has(id)) {
      this.queries.set(id, {
        params,
        fulfilled: false,
        responseCallbacks: new Set(),
        subCount: 0,
      });
      this.getQueryState(id).then((queryState: Timestamp[]) => {
        this.sendMessage({
          type: 'CONNECT_QUERY',
          payload: {
            id: id,
            params,
            state: queryState,
          },
        });
      });
    }
    // Safely using query! here because we just set it
    const query = this.queries.get(id)!;
    query.subCount++;
    if (onQueryFulfilled) {
      query.fulfilled && onQueryFulfilled();
      query.responseCallbacks.add(onQueryFulfilled);
    }

    return () => {
      const query = this.queries.get(id);
      // If we cannot find the query, we may have already disconnected or reset our state
      // just in case send a disconnect signal to the server
      if (!query) {
        this.disconnectQuery(id);
        return;
      }

      // Clear data related to subscription
      query.subCount--;
      if (onQueryFulfilled) {
        query.responseCallbacks.delete(onQueryFulfilled);
      }

      // If there are no more subscriptions, disconnect the query
      if (query.subCount === 0) {
        this.disconnectQuery(id);
        return;
      }
    };
  }

  private triplesToStateVector(triples: TripleRow[]): Timestamp[] {
    const clientClocks = new Map<string, number>();
    triples.forEach((t) => {
      // only set the clock if it is greater than the current clock for each client
      const [tick, clientId] = t.timestamp;
      const currentClock = clientClocks.get(clientId);
      if (!currentClock || tick > currentClock) {
        clientClocks.set(clientId, tick);
      }
    });
    return [...clientClocks.entries()].map(([clientId, timestamp]) => [
      timestamp,
      clientId,
    ]);
  }

  hasQueryBeenFulfilled(queryId: string) {
    return this.queries.get(queryId)?.fulfilled ?? false;
  }

  /**
   * @hidden
   */
  disconnectQuery(id: string) {
    this.sendMessage({ type: 'DISCONNECT_QUERY', payload: { id } });
    this.queries.delete(id);
  }

  private commitCallbacks: Map<string, Set<() => void>> = new Map();
  private failureCallbacks: Map<string, Set<(e: unknown) => void>> = new Map();

  /**
   * When a transaction has been confirmed by the remote database, the callback will be called
   * @param txId
   * @param callback
   * @returns a function removing the listener callback
   */
  onTxCommit(txId: string, callback: () => void) {
    this.commitCallbacks.has(txId)
      ? this.commitCallbacks.get(txId)?.add(callback)
      : this.commitCallbacks.set(txId, new Set([callback]));
    return () => {
      this.commitCallbacks.get(txId)?.delete(callback);
    };
  }

  /**
   * If a transaction fails to commit on the remote database, the callback will be called
   * @param txId
   * @param callback
   * @returns a function removing the listener callback
   */
  onTxFailure(txId: string, callback: (e: unknown) => void) {
    this.failureCallbacks.has(txId)
      ? this.failureCallbacks.get(txId)?.add(callback)
      : this.failureCallbacks.set(txId, new Set([callback]));
    return () => {
      this.failureCallbacks.get(txId)?.delete(callback);
    };
  }

  private signalOutboxTriples() {
    this.sendMessage({ type: 'TRIPLES_PENDING', payload: {} });
  }

  /**
   * Initiate a sync connection with the server
   */
  async connect() {
    if (this.transport.connectionStatus !== 'CLOSED') {
      this.closeConnection({ type: 'CONNECTION_OVERRIDE', retry: false });
    }
    const params = await this.getConnectionParams();
    this.transport.connect(params);
    this.transport.onMessage(async (evt) => {
      const message: ServerSyncMessage = JSON.parse(evt.data);
      this.logger.debug('received', message);
      for (const handler of this.messageReceivedSubscribers) {
        handler(message);
      }
      if (message.type === 'ERROR') {
        await this.handleErrorMessage(message);
      }
      if (message.type === 'TRIPLES') {
        const { payload } = message;
        const triples = payload.triples;
        const queryIds = payload.forQueries;

        for (const qId of queryIds) {
          await this.updateQueryStateVector(qId, triples);
          const query = this.queries.get(qId);
          if (!query) continue;
          query.fulfilled = true;
          const callbackSet = query?.responseCallbacks;
          if (callbackSet) {
            for (const callback of callbackSet) callback(payload);
          }
          // this.queryFulfillmentCallbacks.delete(qId);
        }
        if (triples.length !== 0) {
          await this.db.transact(
            async (dbTx) => {
              await dbTx.storeTx
                .withScope({ read: ['cache'], write: ['cache'] })
                .insertTriples(triples);
            },
            { skipRules: true }
          );
        }
      }

      if (message.type === 'TRIPLES_ACK') {
        const { payload } = message;
        const { txIds, failedTxIds } = payload;
        try {
          const failuresSet = new Set(failedTxIds);
          // TODO: do we want hooks to run here?
          await this.db.tripleStore.transact(async (tx) => {
            const outboxOperator = tx.withScope({
              read: ['outbox'],
              write: ['outbox'],
            });
            const cacheOperator = tx.withScope({
              read: ['cache'],
              write: ['cache'],
            });
            // move all commited outbox triples to cache
            for (const clientTxId of txIds) {
              const timestamp = JSON.parse(clientTxId);
              const triplesToEvict = await genToArr(
                outboxOperator.findByClientTimestamp(
                  await this.db.getClientId(),
                  'eq',
                  timestamp
                )
              );
              if (triplesToEvict.length > 0) {
                await cacheOperator.insertTriples(triplesToEvict);
                await outboxOperator.deleteTriples(triplesToEvict);
              }
            }
          });
          for (const txId of txIds) {
            this.txCommits$.next(txId);
          }

          // Filter out failures, tell server there are unsent triples
          // Would be nice to not load all these into memory
          // However for most workloads its hopefully not that much data
          const triplesToSend = (
            await this.getTriplesToSend(
              this.db.tripleStore.setStorageScope(['outbox'])
            )
          ).filter((t) => !failuresSet.has(JSON.stringify(t.timestamp)));
          if (triplesToSend.length) this.signalOutboxTriples();
        } finally {
          // After processing, clean state (ACK received)
          for (const txId of txIds) {
            this.awaitingAck.delete(txId);
          }
          for (const txId of failedTxIds) {
            this.awaitingAck.delete(txId);
          }
        }
      }

      if (message.type === 'TRIPLES_REQUEST') {
        // we do this outbox scan like a million times (i think the server can still do a small throttle for backpressue of those mesasges bc theyre stateless)
        const triplesToSend = await this.getTriplesToSend(
          this.db.tripleStore.setStorageScope(['outbox'])
        );
        this.sendTriples(triplesToSend);
      }

      if (message.type === 'CLOSE') {
        const { payload } = message;
        this.logger.info(
          `Closing connection${payload?.message ? `: ${payload.message}` : '.'}`
        );
        const { type, retry } = payload;
        // Close payload must remain under 125 bytes
        this.closeConnection({ type, retry });
      }
    });
    this.transport.onOpen(async () => {
      this.logger.info('sync connection has opened');
      this.resetReconnectTimeout();
      // Cut down on message sending by only signaling if there are triples to send
      const outboxTriples = await this.getTriplesToSend(
        this.db.tripleStore.setStorageScope(['outbox'])
      );
      const hasOutboxTriples = !!outboxTriples.length;
      if (hasOutboxTriples) this.signalOutboxTriples();
      // Reconnect any queries
      for (const [id, queryInfo] of this.queries) {
        this.getQueryState(id).then((queryState) => {
          this.sendMessage({
            type: 'CONNECT_QUERY',
            payload: {
              id,
              params: queryInfo.params,
              state: queryState,
            },
          });
        });
      }
    });

    this.transport.onClose((evt) => {
      // Clear any sync state
      this.resetConnectionState();

      // If there is no reason, then default is to retry
      if (evt.reason) {
        let type: string;
        let retry: boolean;
        // We populate the reason field with some information about the close
        // Some WS implementations include a reason field that isn't a JSON string on connection failures, etc
        try {
          const { type: t, retry: r } = JSON.parse(evt.reason);
          type = t;
          retry = r;
        } catch (e) {
          type = 'UNKNOWN';
          retry = true;
        }

        if (type === 'SCHEMA_MISMATCH') {
          this.logger.error(
            'The server has closed the connection because the client schema does not match the server schema. Please update your client schema.'
          );
        }

        if (!retry) {
          // early return to prevent reconnect
          this.logger.warn(
            'The connection has closed. Based on the signal, the connection will not automatically retry. If you would like to reconnect, please call `connect()`.'
          );
          return;
        }
      }

      // Attempt to reconnect with backoff
      const connectionHandler = this.connect.bind(this);
      this.reconnectTimeout = setTimeout(
        connectionHandler,
        this.reconnectTimeoutDelay
      );
      this.reconnectTimeoutDelay = Math.min(
        30000,
        this.reconnectTimeoutDelay * 2
      );
    });
    this.transport.onError((evt) => {
      // console.log('error ws', evt);
      this.logger.error('transport error', evt);
      // on error, close the connection and attempt to reconnect
      this.transport.close();
    });

    // NOTE: this comes from proxy in websocket.ts
    this.transport.onConnectionChange((state: ConnectionStatus) => {
      for (const handler of this.connectionChangeHandlers) {
        handler(state);
      }
    });
  }

  /**
   * The current connection status of the sync engine
   */
  get connectionStatus() {
    return this.transport.connectionStatus;
  }

  private async updateQueryStateVector(queryId: string, triples: any) {
    const queryState: Timestamp[] = await this.getQueryState(queryId);
    if (triples.length > 0) {
      const stateVector = this.triplesToStateVector(triples);
      const nextQueryState = new Map(
        (queryState ?? []).map(([t, c]) => [c, t])
      );
      stateVector.forEach(([t, c]) => {
        const current = nextQueryState.get(c);
        if (!current || t > current) {
          nextQueryState.set(c, t);
        }
      });
      this.setQueryState(
        queryId,
        [...nextQueryState.entries()].map(([c, t]) => [t, c])
      );
    }
  }

  /**
   * @hidden
   * Updates the sync engine's configuration options. If the connection is currently open, it will be closed and you will need to call `connect()` again.
   * @param options
   */
  updateConnection(options: Partial<SyncOptions>) {
    if (this.connectionStatus === 'OPEN') {
      console.warn(
        'You are updating the connection options while the connection is open. To avoid unexpected behavior the connection will be closed and you should call `connect()` again after the update. To hide this warning, call `disconnect()` before updating the connection options.'
      );
      this.disconnect();
    }
    this.syncOptions = { ...this.syncOptions, ...options };
  }

  /**
   * Disconnect from the server
   */
  disconnect() {
    this.closeConnection({ type: 'MANUAL_DISCONNECT', retry: false });
  }

  /**
   * Clear all state related to syncing. If the connection is currently open, it will be closed and you will need to call `connect()` again.
   */
  async reset() {
    if (this.connectionStatus === 'OPEN') {
      console.warn(
        'You are resetting the sync engine while the connection is open. To avoid unexpected behavior the connection will be closed and you should call `connect()` again after resetting. To hide this warning, call `disconnect()` before resetting.'
      );
      this.disconnect();
    }
    this.resetConnectionState();
    await this.resetConnectionSessionState();
  }

  /**
   * Resets any state related to a single connection
   */
  private resetConnectionState() {
    this.awaitingAck = new Set();
  }

  /**
   * Resets any state related to a single connection session (should persist across disconnect/reconnects)
   */
  private async resetConnectionSessionState() {
    // Disconnect all connected queries
    // This should clear the queries map
    for (const id of this.queries.keys()) {
      this.disconnectQuery(id);
    }
    await this.db.tripleStore.transact(async (tx) => {
      await tx.deleteMetadataTuples([[QUERY_STATE_KEY]]);
    });
  }

  private async handleErrorMessage(message: any) {
    const { error, metadata } = message.payload;
    this.logger.error(error.name, metadata);
    switch (error.name) {
      case 'MalformedMessagePayloadError':
      case 'UnrecognizedMessageTypeError':
        this.logger.warn(
          'You sent a malformed message to the server. This might occur if your client is not up to date with the server. Please ensure your client is updated.'
        );
        // TODO: If the message that fails is a triple insert, we should handle that specifically depending on the case
        break;
      case 'TriplesInsertError':
        const failures = metadata?.failures ?? [];
        // Could maybe do this on ACK too
        for (const failure of failures) {
          const { txId, error } = failure;
          this.txFailures$.next({ txId, error });
        }
      // On a remote read error, default to disconnecting the query
      // You will still send triples, but you wont receive updates
      case 'QuerySyncError':
        const queryKey = metadata?.queryKey;
        if (queryKey) this.disconnectQuery(queryKey);
    }
  }

  private sendTriples(triples: TripleRow[]) {
    const triplesToSend = this.syncOptions.syncSchema
      ? triples
      : triples.filter(({ id }) => !id.includes('_metadata#_schema'));
    if (triplesToSend.length === 0) return;
    triplesToSend.forEach((t) =>
      this.awaitingAck.add(JSON.stringify(t.timestamp))
    );
    this.sendMessage({ type: 'TRIPLES', payload: { triples: triplesToSend } });
  }

  private sendMessage(message: ClientSyncMessage) {
    this.transport.sendMessage(message);
    this.logger.debug('sent', message);
    for (const handler of this.messageSentSubscribers) {
      handler(message);
    }
  }

  /**
   * Retry sending a transaciton to the remote database. This is commonly used when a transaction fails to commit on the remote database in the `onTxFailure` callback.
   * @param txId
   */
  async retry(txId: string) {
    const timestamp: Timestamp = JSON.parse(txId);
    const triplesToSend = await genToArr(
      this.db.tripleStore
        .setStorageScope(['outbox'])
        .findByClientTimestamp(await this.db.getClientId(), 'eq', timestamp)
    );
    if (triplesToSend.length > 0) this.sendTriples(triplesToSend);
  }

  /**
   * Rollback a transaction from the client database. It will no longer be sent to the remote database as a part of the syncing process. This is commonly used when a transaction fails to commit on the remote database in the `onTxFailure` callback.
   * @param txIds
   */
  async rollback(txIds: string | string[]) {
    const txIdList = Array.isArray(txIds) ? txIds : [txIds];
    await this.db.transact(
      async (tx) => {
        const scopedTx = tx.storeTx.withScope({
          read: ['outbox'],
          write: ['outbox'],
        });
        for (const txId of txIdList) {
          const timestamp = JSON.parse(txId);
          const triples = await genToArr(
            scopedTx.findByClientTimestamp(
              await this.db.getClientId(),
              'eq',
              timestamp
            )
          );
          await scopedTx.deleteTriples(triples);
        }
      },
      { skipRules: true }
    );
  }

  /**
   * Sets up a listener for connection status changes
   * @param callback A callback that will be called when the connection status changes
   * @param runImmediately Run the callback immediately with the current connection status
   * @returns A function that removes the callback from the connection status change listeners
   */
  onConnectionStatusChange(
    callback: (status: ConnectionStatus) => void,
    runImmediately: boolean = false
  ) {
    this.connectionChangeHandlers.add(callback);
    if (runImmediately) callback(this.transport.connectionStatus);
    return () => {
      this.connectionChangeHandlers.delete(callback);
    };
  }

  private closeConnection(reason?: CloseReason) {
    if (this.transport) this.transport.close(reason);
  }

  private resetReconnectTimeout() {
    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeoutDelay = 250;
  }

  /**
   * @hidden
   */
  async syncQuery(query: ClientQuery<any, any>) {
    try {
      const triples = await this.getRemoteTriples(query);
      await this.db.transact(
        async (dbTx) => {
          await dbTx.storeTx
            .withScope({ read: ['cache'], write: ['cache'] })
            .insertTriples(triples);
        },
        { skipRules: true }
      );
    } catch (e) {
      if (e instanceof TriplitError) throw e;
      if (e instanceof Error) throw new RemoteSyncFailedError(query, e.message);
      throw new RemoteSyncFailedError(query, 'An unknown error occurred.');
    }
  }

  /**
   * @hidden
   */
  async fetchQuery<M extends Models, CQ extends SchemaClientQueries<M>>(
    query: CQ
  ) {
    try {
      // Simpler to serialize triples and reconstruct entities on the client
      const triples = await this.getRemoteTriples(query);
      const entities = constructEntities(triples);
      const schema = (await this.db.getSchema())?.collections;
      return [...entities].map(([, entity]) =>
        convertEntityToJS(entity.data as any, schema)
      ) as Unalias<FetchResult<M, ToQuery<M, CQ>>>;
    } catch (e) {
      if (e instanceof TriplitError) throw e;
      if (e instanceof Error)
        throw new RemoteFetchFailedError(query, e.message);
      throw new RemoteFetchFailedError(query, 'An unknown error occurred.');
    }
  }

  private async getRemoteTriples(query: ClientQuery<any, any>) {
    const res = await this.fetchFromServer(`/queryTriples`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      let errorBody;
      try {
        errorBody = await res.json();
      } catch (e) {
        throw new RemoteFetchFailedError(
          query,
          `The server responded with an error: ${await res.text()}`
        );
      }
      const message = errorBody.message ?? JSON.stringify(errorBody);
      throw new RemoteFetchFailedError(query, message);
    }
    return await res.json();
  }

  private fetchFromServer(
    path: string,
    init?: RequestInit | undefined
  ): Promise<Response> {
    if (!this.httpUri || !this.token) {
      const messages = [];
      if (!this.httpUri) messages.push('No server specified.');
      if (!this.token) messages.push('No token specified.');
      throw new MissingConnectionInformationError(messages.join(' '));
    }
    return fetch(`${this.httpUri}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...init?.headers },
    });
  }

  private async getTriplesToSend(store: TripleStoreApi) {
    return (await genToArr(store.findByEntity())).filter((t) =>
      this.shouldSendTriple(t)
    );
  }

  private shouldSendTriple(t: TripleRow) {
    const hasBeenSent = this.awaitingAck.has(JSON.stringify(t.timestamp));
    return (
      !hasBeenSent &&
      // Filter out schema triples if syncSchema is false
      (this.syncOptions.syncSchema || !t.id.includes('_metadata#_schema'))
    );
  }
}

function throttle(callback: () => void, delay: number) {
  let wait = false;
  let refire = false;
  function refireOrReset() {
    if (refire) {
      callback();
      refire = false;
      setTimeout(refireOrReset, delay);
    } else {
      wait = false;
    }
  }
  return function () {
    if (!wait) {
      callback();
      wait = true;
      setTimeout(refireOrReset, delay);
    } else {
      refire = true;
    }
  };
}
