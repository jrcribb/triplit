import { Models, Path, RelationAttributes, SchemaPaths } from '../schema/types';
import {
  CollectionQuery,
  FilterStatement,
  Query,
  QueryOrder,
  QuerySelectionValue,
  QueryValue,
  QueryWhere,
  ValueCursor,
  WhereFilter,
  RelationSubquery,
} from '../query.js';
import { CollectionNameFromModels, ModelFromModels } from '../db.js';
import { ReturnTypeFromQuery } from '../collection-query.js';
import {
  AfterClauseWithNoOrderError,
  QueryClauseFormattingError,
} from '../errors.js';
import {
  ExtractCollectionQueryCollectionName,
  ExtractCollectionQueryInclusion,
  ExtractCollectionQueryModels,
  ExtractCollectionQuerySelection,
} from './types';

/**
 * Basic interface for a functional builder
 */
export type BuilderBase<
  T,
  Ignore extends string = never,
  Extend extends string = never
> = {
  [K in keyof Omit<T, Ignore> | Extend]-?: (...args: any) => any;
} & { build: () => T };

export class QueryBuilder<
  Q extends CollectionQuery<any, any, any, any>,
  M extends Models<any, any> | undefined = ExtractCollectionQueryModels<Q>,
  // @ts-expect-error
  CN extends CollectionNameFromModels<M> = ExtractCollectionQueryCollectionName<Q>
> implements BuilderBase<CollectionQuery<any, any>, 'collectionName'>
{
  protected query: Q;
  constructor(query: Q) {
    this.query = query;
  }

  build() {
    return this.query;
  }

  select<Selection extends QuerySelectionValue<M, CN>>(
    selection: Selection[] | undefined
  ) {
    this.query = { ...this.query, select: selection };

    // TODO: I think this is going to break higher level builders, ensure it doenst (@triplit/react probably has error)
    return this as QueryBuilder<
      CollectionQuery<M, CN, Selection, ExtractCollectionQueryInclusion<Q>>
    >;
  }

  where(...args: FilterInput<M, CN, any>) {
    this.query = {
      ...this.query,
      where: QUERY_INPUT_TRANSFORMERS<M, CN>().where(
        // @ts-expect-error
        this.query,
        ...args
      ),
    };
    return this;
  }

  order(...args: OrderInput<M, CN>) {
    this.query = {
      ...this.query,
      order: QUERY_INPUT_TRANSFORMERS<M, CN>().order(
        // @ts-expect-error

        this.query,
        ...args
      ),
    };
    return this;
  }

  after(after: AfterInput<M, CN>, inclusive?: boolean) {
    this.query = {
      ...this.query,
      after: QUERY_INPUT_TRANSFORMERS<M, CN>().after(
        // @ts-expect-error

        this.query,
        after,
        inclusive
      ),
    };
    return this;
  }
  // TODO: these get typed as 'any' in result types
  include<RName extends string, SQ extends RelationSubquery<M, any>>(
    relationName: RName,
    query: RelationSubquery<M, any>
  ): QueryBuilder<
    CollectionQuery<
      M,
      CN,
      // @ts-expect-error TODO: not sure why this has error (maybe defaults)
      ExtractCollectionQuerySelection<Q>,
      ExtractCollectionQueryInclusion<Q> & {
        [K in RName]: SQ;
      }
    >
  >;
  include<RName extends RelationAttributes<ModelFromModels<M, CN>>>(
    relationName: RName,
    query?: PartialQuery<
      M,
      // @ts-expect-error Doesn't know that Model['RName'] is a query type
      ModelFromModels<M, CN>['properties'][RName]['query']['collectionName']
    >
  ): QueryBuilder<
    CollectionQuery<
      M,
      CN,
      // @ts-expect-error TODO: not sure why this has error (maybe defaults)
      ExtractCollectionQuerySelection<Q>,
      ExtractCollectionQueryInclusion<Q> & {
        [K in RName]: InclusionFromArgs<M, CN, RName, null>;
      }
    >
  >;
  include(relationName: any, query?: any) {
    this.query = {
      ...this.query,
      include: QUERY_INPUT_TRANSFORMERS<M, CN>().include(
        // @ts-expect-error
        this.query,
        relationName,
        query
      ),
    };
    return this;
  }

  limit(limit: number) {
    this.query = { ...this.query, limit };
    return this;
  }

  vars(vars: Record<string, any>) {
    this.query = { ...this.query, vars };
    return this;
  }

  entityId(entityId: string) {
    this.query = { ...this.query, entityId };
    return this;
  }
}

type PartialQuery<
  M extends Models<any, any> | undefined,
  CN extends CollectionNameFromModels<M>
> = Pick<
  CollectionQuery<M, CN>,
  'select' | 'order' | 'where' | 'limit' | 'include'
>;

type InclusionFromArgs<
  M extends Models<any, any> | undefined,
  CN extends CollectionNameFromModels<M>,
  RName extends string,
  Inclusion extends RelationSubquery<M, any> | null
> = M extends Models<any, any>
  ? Inclusion extends null
    ? // Look up in Models
      RName extends RelationAttributes<ModelFromModels<M, CN>>
      ? {
          // Colleciton query with params based on the relation
          subquery: CollectionQuery<
            M,
            ModelFromModels<
              M,
              CN
            >['properties'][RName]['query']['collectionName']
          >;
          cardinality: ModelFromModels<
            M,
            CN
          >['properties'][RName]['cardinality'];
        }
      : never
    : Inclusion
  : Inclusion;

type FilterInput<
  M extends Models<any, any> | undefined,
  CN extends CollectionNameFromModels<M>,
  P extends M extends Models<any, any> ? SchemaPaths<M, CN> : Path
> =
  | [typeof undefined]
  | FilterStatement<M, CN, P>
  | [FilterStatement<M, CN, P>]
  | WhereFilter<M, CN>[]
  | [QueryWhere<M, CN>];

type OrderInput<
  M extends Models<any, any> | undefined,
  CN extends CollectionNameFromModels<M>
> = QueryOrder<M, CN> | QueryOrder<M, CN>[] | [QueryOrder<M, CN>[]];

type AfterInput<
  M extends Models<any, any> | undefined,
  CN extends CollectionNameFromModels<M>
> =
  | ValueCursor
  | (M extends Models<any, any>
      ? ReturnTypeFromQuery<CollectionQuery<M, CN>>
      : undefined)
  | undefined;

export type QUERY_INPUT_TRANSFORMERS<
  M extends Models<any, any> | undefined,
  CN extends CollectionNameFromModels<M>
> = ReturnType<typeof QUERY_INPUT_TRANSFORMERS<M, CN>>;

// TODO: add functional type guards for conditionals
export const QUERY_INPUT_TRANSFORMERS = <
  M extends Models<any, any> | undefined,
  CN extends CollectionNameFromModels<M>
>() => ({
  where: <A extends FilterInput<M, CN, any>>(
    q: Query<M, CN>,
    ...args: A
  ): QueryWhere<M, CN> => {
    let newWhere: QueryWhere<M, CN> = [];
    if (args[0] == undefined) return q.where ?? [];
    if (typeof args[0] === 'string') {
      /**
       * E.g. where("id", "=", "123")
       */
      newWhere = [args as FilterStatement<M, CN>];
    } else if (
      args.length === 1 &&
      args[0] instanceof Array &&
      args[0].every((filter) => typeof filter === 'object')
    ) {
      /**
       *  E.g. where([["id", "=", "123"], ["name", "=", "foo"]])
       */
      newWhere = args[0] as FilterStatement<M, CN>[];
    } else if (args.every((arg) => typeof arg === 'object')) {
      /**
       * E.g. where(["id", "=", "123"], ["name", "=", "foo"]);
       */
      newWhere = args as QueryWhere<M, CN>;
    } else {
      throw new QueryClauseFormattingError('where', args);
    }
    return [...(q.where ?? []), ...newWhere];
  },
  order: (
    q: Query<M, CN>,
    ...args: OrderInput<M, CN>
  ): QueryOrder<M, CN>[] | undefined => {
    if (!args[0]) return undefined;
    let newOrder: QueryOrder<M, CN>[] = [];
    /**
     * E.g. order("id", "ASC")
     */
    if (
      args.length === 2 &&
      (args as any[]).every((arg) => typeof arg === 'string')
    ) {
      newOrder = [[...args] as QueryOrder<M, CN>];
    } else if (
      /**
       * E.g. order([["id", "ASC"], ["name", "DESC"]])
       */
      args.length === 1 &&
      args[0] instanceof Array &&
      args[0].every((arg) => arg instanceof Array)
    ) {
      newOrder = args[0] as NonNullable<Query<M, CN>['order']>;
    } else if (args.every((arg) => arg instanceof Array)) {
      /**
       * E.g. order(["id", "ASC"], ["name", "DESC"])
       */
      newOrder = args as NonNullable<Query<M, CN>['order']>;
    } else {
      throw new QueryClauseFormattingError('order', args);
    }
    return [...(q.order ?? []), ...newOrder];
  },
  include<
    RName extends M extends Models<any, any>
      ? RelationAttributes<ModelFromModels<M, CN>>
      : never
  >(
    q: Query<M, CN>,
    relationName: RName,
    query?: Query<M, RName>
  ): Record<string, any> {
    // TODO: include should be typed as a set of subqueries
    return {
      ...q.include,
      // Set to null so the inclusion of the key can be serialized
      [relationName]: query ?? null,
    };
  },
  after(
    q: Query<M, CN>,
    after: AfterInput<M, CN>,
    inclusive?: boolean
  ): [ValueCursor, boolean] | undefined {
    if (!after) return undefined;
    if (!q.order) throw new AfterClauseWithNoOrderError(after);
    const attributeToOrderBy = q.order[0][0];
    if (after instanceof Array && after.length === 2)
      return [after, inclusive ?? false];
    if (
      typeof after === 'object' &&
      !(after instanceof Array) &&
      Object.hasOwn(after, 'id') &&
      Object.hasOwn(after, attributeToOrderBy)
    ) {
      return [
        // @ts-expect-error
        [after[attributeToOrderBy] as QueryValue, after.id as string],
        inclusive ?? false,
      ];
    }
    throw new QueryClauseFormattingError('after', after);
  },
});
