import { Value } from '@sinclair/typebox/value';
import { CollectionQuery } from '@triplit/db';

// Should update this as we add more query properties
const COLLECTION_QUERY_PROPS: (keyof CollectionQuery)[] = [
  'after',
  'collectionName',
  'entityId',
  'include',
  'limit',
  'order',
  'vars',
  'where',
];

/**
 * Hashes a query object to a unique string, ignoring non-query properties. Thus the hash is of the query the server will see.
 */
export function hashQuery<Q extends CollectionQuery>(params: Q) {
  const queryParams = Object.fromEntries(
    Object.entries(params).filter(([key]) =>
      (COLLECTION_QUERY_PROPS as string[]).includes(key)
    )
  );
  const hash = Value.Hash(queryParams).toString();
  return hash;
}
