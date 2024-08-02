import {
  TriplitClient,
  Models,
  CollectionNameFromModels,
  SubscriptionOptions,
  Unalias,
  ClientFetchResultEntity,
  ClientQueryDefault,
} from '@triplit/client';
import type { WorkerClient } from '@triplit/client/worker-client';
import { useQueryOne } from './use-query-one.js';

/**
 * A React hook that subscribes to an entity
 *
 * @param client - The client instance to query with
 * @param collectionName - The name of the collection to query
 * @param id - The id of the entity to query
 * @param options - Additional options for the subscription
 * @returns - An object containing the fetching state, the result of the query, and any error that occurred
 */
export function useEntity<
  M extends Models<any, any> | undefined,
  CN extends CollectionNameFromModels<M>
>(
  client: TriplitClient<M> | WorkerClient<M>,
  collectionName: CN,
  id: string,
  options?: Partial<SubscriptionOptions>
): {
  fetching: boolean;
  fetchingLocal: boolean;
  fetchingRemote: boolean;
  result: Unalias<ClientFetchResultEntity<ClientQueryDefault<M, CN>>> | null;
  results: Unalias<ClientFetchResultEntity<ClientQueryDefault<M, CN>>> | null;
  error: any;
} {
  let builder = client.query(collectionName).id(id);
  const queryData = useQueryOne(client, builder, options);
  return {
    ...queryData,
    /**
     * @deprecated use `result` instead
     */
    results: queryData.result,
  };
}
