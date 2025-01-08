import { ValuePointer } from '@sinclair/typebox/value';
import {
  FetchExecutionContext,
  isQueryInclusionSubquery,
} from '../collection-query.js';
import { Entity } from '../entity.js';
import { QueryNotPreparedError } from '../errors.js';
import { Model, Models } from '../schema/types/index.js';
import { TripleRow } from '../triple-store-utils.js';
import {
  QueryComponentCacheEntry,
  entityIdFromComponentId,
} from './execution-cache.js';
import {
  CollectionQuery,
  FetchResultEntity,
  SchemaQueries,
} from './types/index.js';

export function getEntityConnections(
  executionContext: FetchExecutionContext,
  entityIds: string[]
): Map<string, QueryComponentCacheEntry> {
  const { executionCache } = executionContext;
  const results = new Map<string, QueryComponentCacheEntry>();
  for (const componentId of entityIds) {
    // Root entities should have a component
    const component = executionCache.getComponent(componentId);
    if (!component) continue;
    const entityId = entityIdFromComponentId(componentId);
    if (results.has(entityId)) continue;
    results.set(entityId, component);
  }
  return results;
}

export function getEntitiesFromContext(
  entityOrder: string[],
  executionContext: FetchExecutionContext
): Map<string, Entity> {
  const { executionCache } = executionContext;
  const results = new Map<string, Entity>();
  const components = getEntityConnections(executionContext, entityOrder);
  for (const [entityId, component] of components) {
    if (results.has(entityId)) continue;
    const cachedEntity = executionCache.getData(component.entityId);
    if (!cachedEntity) continue;
    results.set(entityId, cachedEntity.entity);
  }
  return results;
}

/**
 * Returns a map of entity ids to the triples that are associated with them
 * The data is not nested based on the results of the query
 */
export function getResultTriplesFromContext<
  M extends Models,
  Q extends SchemaQueries<M>,
>(
  query: Q,
  entityOrder: string[],
  executionContext: FetchExecutionContext
): Map<string, TripleRow[]> {
  const triples: Map<string, TripleRow[]> = new Map();
  const { include } = query;
  const { executionCache } = executionContext;
  const components = getEntityConnections(executionContext, entityOrder);
  for (const [entityId, component] of components) {
    const cachedEntity = executionCache.getData(component?.entityId ?? '');
    if (!cachedEntity) continue;

    // TODO: filter down triples by selection or just include all?
    // For now i think we dont
    const entityTriples = [...cachedEntity.entity.triples];

    // Load inclusions
    for (const [attributeName, inc] of Object.entries(include ?? {})) {
      if (!isQueryInclusionSubquery(inc)) {
        throw new QueryNotPreparedError('An inclusion is not prepared');
      }
      if (!component) continue;
      const { subquery, cardinality } = inc;
      let subqueryOrder = component.relationships[attributeName];
      if (typeof subqueryOrder === 'string') subqueryOrder = [subqueryOrder];
      const subqueryResult = getResultTriplesFromContext<M, typeof subquery>(
        subquery,
        subqueryOrder ?? [],
        executionContext
      );

      // Load subquery results into the parent query triple map
      // TO de-dupe, we are checking if the entity already has triples and assuming that all triples are included because select doesnt filter down triples
      for (const [entityId, entityTriples] of subqueryResult) {
        if (!triples.has(entityId)) {
          triples.set(entityId, entityTriples);
        }
      }
    }
    triples.set(entityId, entityTriples);
  }
  return triples;
}

export function getSyncTriplesFromContext<
  M extends Models,
  Q extends SchemaQueries<M>,
>(query: Q, entityOrder: string[], executionContext: FetchExecutionContext) {
  const triples = getResultTriplesFromContext<M, Q>(
    query,
    entityOrder,
    executionContext
  );
  for (const entityId of executionContext.fulfillmentEntities) {
    // If we've already loaded this entity skip to avoid dupes
    if (triples.has(entityId)) continue;
    const fullfillmentTriples =
      executionContext.executionCache.getData(entityId)?.tripleHistory ?? [];
    triples.set(entityId, fullfillmentTriples);
  }
  return triples;
}

export function getQueryResultsFromContext<
  M extends Models,
  Q extends SchemaQueries<M>,
>(
  query: Q,
  entityOrder: string[],
  executionContext: FetchExecutionContext
): Map<string, FetchResultEntity<M, Q>> {
  const { select, include } = query;
  const { executionCache } = executionContext;
  const results = new Map<string, FetchResultEntity<M, Q>>();
  const components = getEntityConnections(executionContext, entityOrder);
  for (const [entityId, component] of components) {
    const cachedEntity = executionCache.getData(component.entityId);
    if (!cachedEntity) continue;
    const entity = cachedEntity.entity.data;
    const entityWithSelection = filterEntityToSelection(query, entity);

    // Load inclusions
    for (const [attributeName, inc] of Object.entries(include ?? {})) {
      if (!isQueryInclusionSubquery(inc)) {
        throw new QueryNotPreparedError('An inclusion is not prepared');
      }
      if (!component) continue;
      const { subquery, cardinality } = inc;
      let subqueryOrder = component.relationships[attributeName];
      if (typeof subqueryOrder === 'string') subqueryOrder = [subqueryOrder];
      const subqueryResult = Array.from(
        getQueryResultsFromContext<M, typeof subquery>(
          subquery,
          subqueryOrder ?? [],
          executionContext
        ).values()
      );

      entityWithSelection[attributeName] =
        cardinality === 'one' ? (subqueryResult[0] ?? null) : subqueryResult;
    }

    results.set(entityId, entityWithSelection);
  }
  return results;
}

export function getQueriedEntityIdsFromContext<
  M extends Models,
  Q extends SchemaQueries<M>,
>(
  query: Q,
  entityOrder: string[],
  executionContext: FetchExecutionContext
): Set<string> {
  const { include } = query;
  const { executionCache } = executionContext;
  const results = new Set<string>();
  const components = getEntityConnections(executionContext, entityOrder);
  for (const [entityId, component] of components) {
    if (results.has(entityId)) continue;
    const cachedEntity = executionCache.getData(component.entityId);
    if (!cachedEntity) continue;
    results.add(entityId);
    // Load inclusions
    for (const [attributeName, inc] of Object.entries(include ?? {})) {
      if (!isQueryInclusionSubquery(inc)) {
        throw new QueryNotPreparedError('An inclusion is not prepared');
      }
      if (!component) continue;
      const { subquery, cardinality } = inc;
      let subqueryOrder = component.relationships[attributeName];
      if (typeof subqueryOrder === 'string') subqueryOrder = [subqueryOrder];
      const subqueryResult = getQueriedEntityIdsFromContext<M, typeof subquery>(
        subquery,
        subqueryOrder ?? [],
        executionContext
      );
      for (const entityId of subqueryResult) {
        results.add(entityId);
      }
    }
  }
  return results;
}

export function getSyncEntityIdsFromContext<
  M extends Models,
  Q extends SchemaQueries<M>,
>(
  query: Q,
  entityOrder: string[],
  executionContext: FetchExecutionContext
): Set<string> {
  const entityIds = getQueriedEntityIdsFromContext<M, Q>(
    query,
    entityOrder,
    executionContext
  );
  for (const entityId of executionContext.fulfillmentEntities) {
    entityIds.add(entityId);
  }
  return entityIds;
}

export function filterEntityToSelection(
  query: CollectionQuery<any, any>,
  entity: Record<string, any>
) {
  const entityWithSelection: any = {};

  // Determine selection
  const selection = query.select ?? Object.keys(entity);

  // Take selected keys
  for (const key of selection) {
    // Use ValuePointer to handle nested keys
    const pointerKey = '/' + key.split('.').join('/');
    const val = ValuePointer.Get(entity, pointerKey);
    ValuePointer.Set(entityWithSelection, pointerKey, val);
  }
  return entityWithSelection;
}
