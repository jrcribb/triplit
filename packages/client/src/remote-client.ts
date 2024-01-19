import {
  UpdateTypeFromModel,
  Models,
  CollectionNameFromModels,
  ModelFromModels,
  InsertTypeFromModel,
  FetchByIdQueryParams,
  ChangeTracker,
  createUpdateProxy,
  Attribute,
  Value,
} from '@triplit/db';
import {
  ClientFetchResult,
  ClientFetchResultEntity,
  ClientQuery,
  ClientSchema,
  prepareFetchByIdQuery,
  prepareFetchOneQuery,
} from './utils/query.js';

// Interact with remote via http api, totally separate from your local database
export class RemoteClient<M extends ClientSchema | undefined> {
  constructor(
    public options: { server?: string; token?: string; schema?: M }
  ) {}

  updateOptions(options: { server?: string; token?: string; schema?: M }) {
    this.options = { ...this.options, ...options };
  }

  private async sendRequest(uri: string, method: string, body: any) {
    if (!this.options.server) throw new Error('No server url provided');
    if (!this.options.token) throw new Error('No token provided');
    const res = await fetch(this.options.server + uri, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.options.token,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { data: undefined, error: await res.text() };
    return { data: await res.json(), error: undefined };
  }

  async fetch<CQ extends ClientQuery<M, any>>(
    query: CQ
  ): Promise<ClientFetchResult<CQ>> {
    const { data, error } = await this.sendRequest('/fetch', 'POST', {
      query,
    });
    if (error) throw new Error(error);
    return deserializeHTTPFetchResult(query, data.result, this.options.schema);
  }

  async fetchOne<CQ extends ClientQuery<M, any>>(
    query: CQ
  ): Promise<ClientFetchResultEntity<CQ> | null> {
    query = prepareFetchOneQuery(query);
    const { data, error } = await this.sendRequest('/fetch', 'POST', {
      query,
    });
    if (error) throw new Error(error);
    const deserialized = deserializeHTTPFetchResult(
      query,
      data.result,
      this.options.schema
    );
    const entity = [...deserialized.values()][0];
    if (!entity) return null;
    return entity;
  }

  async fetchById<CN extends CollectionNameFromModels<M>>(
    collectionName: CN,
    id: string,
    queryParams?: FetchByIdQueryParams<M, CN>
  ) {
    const query = prepareFetchByIdQuery(collectionName, id, queryParams);
    const { data, error } = await this.sendRequest('/fetch', 'POST', {
      query,
    });
    if (error) throw new Error(error);
    const deserialized = deserializeHTTPFetchResult(
      query,
      data.result,
      this.options.schema
    );
    return deserialized.get(id);
  }

  async insert<CN extends CollectionNameFromModels<M>>(
    collectionName: CN,
    object: InsertTypeFromModel<ModelFromModels<M, CN>>
  ) {
    const { data, error } = await this.sendRequest('/insert', 'POST', {
      collectionName,
      entity: object,
    });
    if (error) throw new Error(error);
    return data;
  }

  async update<CN extends CollectionNameFromModels<M>>(
    collectionName: CN,
    entityId: string,
    updater: (
      entity: UpdateTypeFromModel<ModelFromModels<M, CN>>
    ) => void | Promise<void>
  ) {
    const collectionSchema = this.options.schema?.[collectionName]?.schema;
    const entity = {};
    const changes = new ChangeTracker(entity);
    const updateProxy: any = createUpdateProxy(
      changes,
      entity,
      collectionSchema
    );
    await updater(updateProxy);
    const changeTuples = changes.getTuples();
    const patches: (['delete', Attribute] | ['set', Attribute, Value])[] =
      changeTuples.map((tuple) => {
        if (tuple[1] === undefined)
          return ['delete', tuple[0]] as ['delete', Attribute];
        return ['set', tuple[0], tuple[1]] as ['set', Attribute, Value];
      });
    const { data, error } = await this.sendRequest('/update', 'POST', {
      collectionName,
      entityId,
      patches,
    });
    if (error) throw new Error(error);
    return data;
  }

  async delete<CN extends CollectionNameFromModels<M>>(
    collectionName: CN,
    entityId: string
  ) {
    const { data, error } = await this.sendRequest('/delete', 'POST', {
      collectionName,
      entityId,
    });
    if (error) throw new Error(error);
    return data;
  }
}

function deserializeHTTPFetchResult<CQ extends ClientQuery<any, any>>(
  query: CQ,
  result: [string, any][],
  schema?: any
): ClientFetchResult<CQ> {
  return new Map(
    result.map((entry) => [
      entry[0],
      deserializeHTTPEntity(query, entry[1], schema),
    ])
  );
}

function deserializeHTTPEntity<CQ extends ClientQuery<any, any>>(
  query: CQ,
  entity: any,
  schema?: any
): ClientFetchResultEntity<CQ> {
  const { include, collectionName } = query;
  const collectionSchema = schema?.[collectionName]?.schema;

  const deserializedEntity = collectionSchema
    ? (collectionSchema.convertDBValueToJS(
        entity
      ) as ClientFetchResultEntity<CQ>)
    : entity;
  if (!include) return deserializedEntity;
  const includeKeys = Object.keys(include);
  if (includeKeys.length === 0) return deserializedEntity;
  for (const key of includeKeys) {
    // Get query from schema or from include
    let cardinality: any;
    let query: any;
    if (include[key] === null) {
      const schemaItem = schema?.[collectionName]?.schema?.properties?.[key];
      query = schemaItem?.query;
      cardinality = schemaItem?.cardinality;
    } else {
      query = include[key];
    }
    if (!query) continue;
    const relationData =
      cardinality === 'one'
        ? deserializeHTTPEntity(query, deserializedEntity[key], schema)
        : deserializeHTTPFetchResult(
            query, // could be null (part of the schema)
            deserializedEntity[key],
            schema
          );
    deserializedEntity[key] = relationData;
  }
  return deserializedEntity;
}
