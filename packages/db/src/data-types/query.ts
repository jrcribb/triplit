import { CollectionNameFromModels } from '../db.js';
import {
  CollectionNotFoundError,
  InvalidQueryCardinalityError,
  TriplitError,
} from '../errors.js';
import { Models } from '../schema/types';
import { TypeInterface } from './type.js';
import {
  CollectionQuery,
  FetchResult,
  QueryResultCardinality,
} from '../query/types';

export type SubQuery<
  M extends Models<any, any>,
  CN extends CollectionNameFromModels<M>
> = Pick<
  CollectionQuery<M, CN, any, any>,
  'collectionName' | 'where' | 'limit' | 'order'
>;

export type QueryType<
  Q extends SubQuery<any, any>,
  C extends QueryResultCardinality
> = TypeInterface<
  'query',
  FetchResult<Q>,
  any, //TODO: is this even applicable? ... might need to break it out into its own concepts we slowly add to
  readonly []
> & {
  query: Q;
  cardinality: C;
};

export function QueryType<
  Q extends SubQuery<any, any>,
  C extends QueryResultCardinality
>(query: Q, cardinality: C = 'many' as C): QueryType<Q, C> {
  return {
    type: 'query' as const,
    supportedOperations: [] as const, // 'hasKey', etc
    context: {},
    cardinality,
    query,
    toJSON() {
      // TODO verify this works with non-memory storage providers
      return { type: this.type, query, cardinality };
    },
    convertInputToDBValue(val: any) {
      // TODO: this is a placeholder, this could be a place where we could support insertions with relationships
      throw new TriplitError(
        'Invalid Operation - Inserting relational data is not supported'
      );
    },
    // There isnt exactly a "DB value" for queries, but this makes sense to use with the fetch method
    convertDBValueToJS(val, schema) {
      if (!schema)
        throw new TriplitError(
          'A schema is required to convert DB value to JS'
        );
      const relationSchema = schema?.[query.collectionName]?.schema;
      if (!relationSchema)
        throw new CollectionNotFoundError(query.collectionName, schema);

      // TODO: determine when we would see this
      if (!val) return val;

      if (cardinality === 'one') {
        return relationSchema.convertDBValueToJS(val, schema);
      } else if (cardinality === 'many') {
        // TODO: confirm map
        // if (val === undefined) return undefined;
        // const entries = JSON.parse(val);
        return new Map(
          Array.from(val.entries()).map(([k, v]: any) => [
            k,
            relationSchema.convertDBValueToJS(v, schema),
          ])
        );
      } else {
        throw new InvalidQueryCardinalityError(cardinality);
      }
    },
    convertJSONToJS(val, schema) {
      if (!schema)
        throw new TriplitError(
          'A schema is required to convert JSON value to JS'
        );
      const relationSchema = schema?.[query.collectionName]?.schema;
      if (!relationSchema)
        throw new CollectionNotFoundError(query.collectionName, schema);

      if (!val) return val;
      if (cardinality === 'one') {
        return relationSchema.convertJSONToJS(val, schema);
      } else if (cardinality === 'many') {
        return new Map(
          val.map(([k, v]: any) => [
            k,
            relationSchema.convertJSONToJS(v, schema),
          ])
        );
      } else {
        throw new InvalidQueryCardinalityError(cardinality);
      }
    },
    convertJSToJSON(val, schema) {
      if (!schema)
        throw new TriplitError(
          'A schema is required to convert JSON value to JS'
        );
      const relationSchema = schema?.[query.collectionName]?.schema;
      if (!relationSchema)
        throw new CollectionNotFoundError(query.collectionName, schema);

      if (!val) return val;

      if (cardinality === 'one') {
        // @ts-expect-error Need to fixup type to understand that this is a single value
        return relationSchema.convertJSToJSON(val, schema);
      } else if (cardinality === 'many') {
        return Array.from(val.entries()).map(([k, v]: any) => [
          k,
          relationSchema.convertJSToJSON(v, schema),
        ]);
      } else {
        throw new InvalidQueryCardinalityError(cardinality);
      }
    },
    defaultInput() {
      return undefined;
    },
    validateInput(_val: any) {
      return undefined; // TODO
    },
    validateTripleValue(_val: any) {
      return false;
    },
  };
}
