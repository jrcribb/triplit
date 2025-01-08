// TODO: add these types back
// import type { CollectionQuery, Timestamp, TripleRow } from '@triplit/db';

import { ITriplitError } from './errors.js';

type CollectionQuery<T, U> = any;
type Timestamp = [sequence: number, client: string];
type TripleRow = any;

type SyncMessage<Type extends string, Payload extends any> = {
  type: Type;
  payload: Payload;
};

export type ServerCloseReason = {
  type: ServerCloseReasonType;
  retry: boolean;
  message?: string;
};

/**
 * Reasons for a client side connection close
 * - CONNECTION_OVERRIDE: The client has opened a new connection and this one is no longer needed
 * - MANUAL_DISCONNECT: The client has manually closed the connection
 * - NETWORK_OFFLINE: The client has lost network connectivity
 */
export type ClientCloseReasonType =
  | 'CONNECTION_OVERRIDE'
  | 'MANUAL_DISCONNECT'
  | 'NETWORK_OFFLINE';
export type ServerCloseReasonType =
  | 'SCHEMA_MISMATCH'
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'ROLES_MISMATCH'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN';
export type CloseReasonType = ClientCloseReasonType | ServerCloseReasonType;
export type CloseReason = {
  type: CloseReasonType;
  retry: boolean;
};

export type ServerTriplesAckMessage = SyncMessage<
  'TRIPLES_ACK',
  { txIds: string[]; failedTxIds: string[] }
>;
export type ServerTriplesMessage = SyncMessage<
  'TRIPLES',
  { triples: TripleRow[]; forQueries: string[] }
>;
export type ServrTriplesRequestMessage = SyncMessage<'TRIPLES_REQUEST', {}>;
export type ServerErrorMessage = SyncMessage<
  'ERROR',
  {
    messageType: ClientSyncMessage['type'];
    error: ITriplitError;
    metadata?: {
      // Sync errors
      queryKey?: string;
      innerError?: ITriplitError;
      // Write errors
      failures: { txId: string; error: ITriplitError }[];
    };
  }
>;
export type ServerCloseMessage = SyncMessage<'CLOSE', ServerCloseReason>;

export type ServerSyncMessage =
  | ServerTriplesAckMessage
  | ServerTriplesMessage
  | ServrTriplesRequestMessage
  | ServerErrorMessage
  | ServerCloseMessage;

export type ClientConnectQueryMessage = SyncMessage<
  'CONNECT_QUERY',
  {
    id: string;
    params: CollectionQuery<any, any>;
    state?: Timestamp[];
  }
>;
export type ClientDisconnectQueryMessage = SyncMessage<
  'DISCONNECT_QUERY',
  { id: string }
>;
export type ClientTriplesPendingMessage = SyncMessage<'TRIPLES_PENDING', {}>;
export type ClientTriplesMessage = SyncMessage<
  'TRIPLES',
  { triples: TripleRow[] }
>;
export type ClientChunkMessage = SyncMessage<
  'CHUNK',
  { data: string; total: number; index: number; id: string }
>;

export type ClientUpdateTokenMessage = SyncMessage<
  'UPDATE_TOKEN',
  { token: string }
>;

export type ClientSyncMessage =
  | ClientConnectQueryMessage
  | ClientDisconnectQueryMessage
  | ClientTriplesPendingMessage
  | ClientTriplesMessage
  | ClientChunkMessage
  | ClientUpdateTokenMessage;

type SuccessResult<T> = { data: T; error?: undefined };
type ErrorResult<E> = { data?: undefined; error: E };
export type ParseResult<T, E = Error> = SuccessResult<T> | ErrorResult<E>;
