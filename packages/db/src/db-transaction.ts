import { AttributeItem, EAV, TripleStoreTransaction } from './triple-store';
import {
  getSchemaFromPath,
  JSONTypeFromModel,
  Model,
  Models,
  timestampedObjectToPlainObject,
  objectToTimestampedObject,
  TypeFromModel,
} from './schema';
import * as Document from './document';
import { nanoid } from 'nanoid';
import {
  CollectionQuery,
  doesEntityObjMatchWhere,
  fetch,
} from './collection-query';
import { EntityNotFoundError, WriteRuleError } from './errors';
import { ValuePointer } from '@sinclair/typebox/value';
import {
  CollectionNameFromModels,
  CollectionFromModels,
  ModelFromModels,
  CreateCollectionOperation,
  CollectionRules,
  ruleToTuple,
  DropCollectionOperation,
  RenameAttributeOperation,
  AddAttributeOperation,
  DropAttributeOperation,
} from './db';
import {
  validateExternalId,
  appendCollectionToId,
  replaceVariablesInFilterStatements,
  transformTripleAttribute,
} from './db-helpers';

export class DBTransaction<M extends Models<any, any> | undefined> {
  constructor(
    readonly storeTx: TripleStoreTransaction,
    readonly variables?: Record<string, any>
  ) {}

  // get schema() {
  //   return this.storeTx.schema?.collections;
  // }
  async getCollectionSchema<CN extends CollectionNameFromModels<M>>(
    collectionName: CN
  ) {
    const { collections } = (await this.getSchema()) ?? {};
    if (!collections) return undefined;
    // TODO: i think we need some stuff in the triple store...
    const collectionSchema = collections[
      collectionName
    ] as CollectionFromModels<M, CN>;
    return {
      ...collectionSchema,
    };
  }

  private addReadRulesToQuery(
    query: CollectionQuery<ModelFromModels<M>>,
    collection: CollectionFromModels<M>
  ): CollectionQuery<ModelFromModels<M>> {
    if (collection?.rules?.read) {
      const updatedWhere = [
        ...query.where,
        ...collection.rules.read.flatMap((rule) => rule.filter),
      ];
      // @ts-ignore I think we need to pass the schema type to where we read from storage
      return { ...query, where: updatedWhere };
    }
    return query;
  }

  async getSchema() {
    return this.storeTx.readSchema();
  }

  async commit() {
    await this.storeTx.commit();
  }

  async cancel() {
    await this.storeTx.cancel();
  }

  async insert(
    collectionName: CollectionNameFromModels<M>,
    doc: any,
    id?: string
  ) {
    if (id) {
      const validationError = validateExternalId(id);
      if (validationError) throw validationError;
    }
    const collection = await this.getCollectionSchema(collectionName);

    if (collection?.rules?.write?.length) {
      const filters = collection.rules.write.flatMap((r) => r.filter);
      let query = { where: filters } as CollectionQuery<ModelFromModels<M>>;
      query = this.replaceVariablesInQuery(query);
      // TODO there is probably a better way to to this
      // rather than converting to timestamped object check to
      // validate the where filter
      const timestampDoc = objectToTimestampedObject(doc);
      const satisfiedRule = doesEntityObjMatchWhere(
        timestampDoc,
        query.where,
        collection.attributes
      );
      if (!satisfiedRule) {
        // TODO add better error that uses rule description
        throw new WriteRuleError(`Insert does not match write rules`);
      }
    }
    await Document.insert(
      this.storeTx,
      appendCollectionToId(collectionName, id ?? nanoid()),
      doc,
      collectionName
    );
  }

  async update<CN extends CollectionNameFromModels<M>>(
    collectionName: CN,
    entityId: string,
    updater: (
      entity: JSONTypeFromModel<ModelFromModels<M, CN>>
    ) => Promise<void>
  ) {
    const collection = (await this.getSchema())?.collections[
      collectionName
    ] as CollectionFromModels<M, CN>;

    const entity = await this.fetchById(collectionName, entityId);

    if (!entity) {
      throw new EntityNotFoundError(
        entityId,
        collectionName,
        "Cannot perform an update on an entity that doesn't exist"
      );
    }
    const changes = new Map<string, any>();
    const collectionSchema = collection?.attributes;
    const updateProxy = this.createUpdateProxy<typeof collectionSchema>(
      changes,
      entity,
      collectionSchema
    );
    await updater(updateProxy);
    const fullEntityId = appendCollectionToId(collectionName, entityId);
    for (let [path, value] of changes) {
      await this.storeTx.setValue(
        fullEntityId,
        [collectionName, ...path.slice(1).split('/')],
        value
      );
    }
    if (collection?.rules?.write?.length) {
      const updatedEntity = await this.fetchById(collectionName, entityId);
      const filters = collection.rules.write.flatMap((r) => r.filter);
      let query = { where: filters } as CollectionQuery<ModelFromModels<M>>;
      query = this.replaceVariablesInQuery(query);
      const satisfiedRule = doesEntityObjMatchWhere(
        objectToTimestampedObject(updatedEntity),
        query.where,
        collectionSchema
      );
      if (!satisfiedRule) {
        // TODO add better error that uses rule description
        throw new WriteRuleError(`Update does not match write rules`);
      }
    }
  }

  private createUpdateProxy<M extends Model<any> | undefined>(
    changeTracker: Map<string, any>,
    entityObj: JSONTypeFromModel<M>,
    schema?: M,
    prefix: string = ''
  ): JSONTypeFromModel<M> {
    return new Proxy(entityObj, {
      set: (_target, prop, value) => {
        const propPointer = [prefix, prop].join('/');
        if (!schema) {
          changeTracker.set(propPointer, value);
          return true;
        }
        const propSchema = getSchemaFromPath(
          schema,
          propPointer.slice(1).split('/')
        );
        if (!propSchema) {
          // TODO use correct Triplit Error
          throw new Error(
            `Cannot set unrecognized property ${propPointer} to ${value}`
          );
        }
        changeTracker.set(propPointer, value);
        return true;
      },
      get: (_target, prop) => {
        const propPointer = [prefix, prop].join('/');
        const propValue = ValuePointer.Get(entityObj, propPointer);
        if (propValue === undefined) return changeTracker.get(propPointer);
        const propSchema =
          schema && getSchemaFromPath(schema, propPointer.slice(1).split('/'));
        if (
          typeof propValue === 'object' &&
          (!propSchema || propSchema['x-crdt-type'] !== 'Set') &&
          propValue !== null
        ) {
          return this.createUpdateProxy(
            changeTracker,
            propValue,
            schema,
            propPointer
          );
        }
        if (propSchema) {
          if (propSchema['x-crdt-type'] === 'Set') {
            return {
              add: (value: any) => {
                changeTracker.set([propPointer, value].join('/'), true);
              },
              remove: (value: any) => {
                changeTracker.set([propPointer, value].join('/'), false);
              },
              has: (value: any) => {
                const valuePointer = [propPointer, value].join('/');
                return changeTracker.has(valuePointer)
                  ? changeTracker.get(valuePointer)
                  : propValue[value];
              },
            };
          }
        }
        return changeTracker.has(propPointer)
          ? changeTracker.get(propPointer)
          : propValue;
      },
    });
  }

  private replaceVariablesInQuery(
    query: CollectionQuery<ModelFromModels<M>>
  ): CollectionQuery<ModelFromModels<M>> {
    const variables = { ...(this.variables ?? {}), ...(query.vars ?? {}) };
    const where = replaceVariablesInFilterStatements(query.where, variables);
    return { ...query, where };
  }

  async fetch(query: CollectionQuery<ModelFromModels<M>>) {
    let fetchQuery = query;
    const collection = await this.getCollectionSchema(
      fetchQuery.collectionName as CollectionNameFromModels<M>
    );
    if (collection) {
      fetchQuery = this.addReadRulesToQuery(fetchQuery, collection);
    }
    fetchQuery = this.replaceVariablesInQuery(fetchQuery);
    return fetch(this.storeTx, fetchQuery, {
      schema: collection?.attributes,
      includeTriples: false,
    });
  }

  async fetchById(collectionName: CollectionNameFromModels<M>, id: string) {
    const collection = await this.getCollectionSchema(collectionName);
    const readRules = collection?.rules?.read;
    const entity = await this.storeTx.getEntity(
      appendCollectionToId(collectionName, id)
    );
    if (!entity) return null;
    if (entity && readRules) {
      const whereFilter = readRules.flatMap((rule) => rule.filter);
      let query = { where: whereFilter };
      /**
       * TODO we should just make this operate directly on where filters
       * e.g.
       * query.where = this.replaceVariablesInWhere(query.where)
       */
      // @ts-ignore
      query = this.replaceVariablesInQuery(query);
      const collectionSchema = collection.attributes;
      if (doesEntityObjMatchWhere(entity, query.where, collectionSchema)) {
        return entity;
      }
      return null;
    }
    return timestampedObjectToPlainObject(entity) as TypeFromModel<
      M[typeof collectionName]
    >;
  }

  async createCollection(params: CreateCollectionOperation[1]) {
    const { name: collectionName, attributes, rules } = params;
    const attributeTuples = Object.entries(attributes).map<EAV>(
      ([path, attribute]) => [
        '_schema',
        ['collections', collectionName, 'attributes', path, 'type'],
        attribute.type,
      ]
    );
    const ruleTuples = !rules
      ? []
      : (['read', 'write', 'update'] as (keyof CollectionRules<any>)[]).flatMap(
          (ruleType) =>
            rules[ruleType] != undefined
              ? rules[ruleType]!.flatMap((rule, i) =>
                  ruleToTuple(collectionName, ruleType, i, rule)
                )
              : []
        );
    await this.storeTx.updateMetadataTuples([
      ...attributeTuples,
      ...ruleTuples,
    ]);
  }

  async dropCollection(params: DropCollectionOperation[1]) {
    const { name: collectionName } = params;
    // DELETE SCHEMA INFO
    const existingAttributeInfo = await this.storeTx.readMetadataTuples(
      '_schema',
      ['collections', collectionName]
    );
    const deletes = existingAttributeInfo.map<[string, AttributeItem[]]>(
      (eav) => [eav[0], eav[1]]
    );
    await this.storeTx.deleteMetadataTuples(deletes);

    // DELETE DATA
    // TODO: check _collection marker too?
    // const attribute = [collectionName];
    // const currentTriples = this.storeTx.findByAttribute(attribute);
    // this.storeTx.deleteTriples(currentTriples);
  }

  async renameAttribute(params: RenameAttributeOperation[1]) {
    const { collection: collectionName, path, newPath } = params;
    // Update schema if there is schema
    if (await this.getSchema()) {
      const existingAttributeInfo = await this.storeTx.readMetadataTuples(
        '_schema',
        ['collections', collectionName, 'attributes', path]
      );
      // Delete old attribute tuples
      const deletes = existingAttributeInfo.map<[string, AttributeItem[]]>(
        (eav) => [eav[0], eav[1]]
      );
      // Upsert new attribute tuples
      const updates = existingAttributeInfo.map<EAV>((eav) => {
        const attr = [...eav[1]];
        // ['collections', collectionName, 'attributes'] is prefix
        attr.splice(3, 1, newPath); // Logic may change if path and new path arent strings
        return [eav[0], attr, eav[2]];
      });
      await this.storeTx.deleteMetadataTuples(deletes);
      await this.storeTx.updateMetadataTuples(updates);
    }
    // Update data in place
    // For each storage scope, find all triples with the attribute and update them
    for (const storageKey of Object.keys(this.storeTx.tupleTx.store.storage)) {
      const attribute = [collectionName, path];
      const newAttribute = [collectionName, newPath];
      const scopedTx = this.storeTx.withScope({
        read: [storageKey],
        write: [storageKey],
      });
      const currentTriples = await scopedTx.findByAttribute(attribute);
      const newTriples = transformTripleAttribute(
        currentTriples,
        attribute,
        newAttribute
      );
      await scopedTx.deleteTriples(currentTriples);
      await scopedTx.insertTriples(newTriples);
    }
  }

  async addAttribute(params: AddAttributeOperation[1]) {
    const { collection: collectionName, path, attribute } = params;
    // Update schema if there is schema
    if (await this.getSchema()) {
      const updates: EAV[] = Object.entries(attribute).map(([key, value]) => {
        return [
          '_schema',
          ['collections', collectionName, 'attributes', path, key],
          value,
        ];
      });
      await this.storeTx.updateMetadataTuples(updates);
    }
  }

  async dropAttribute(params: DropAttributeOperation[1]) {
    const { collection: collectionName, path } = params;
    // Update schema if there is schema
    if (await this.getSchema()) {
      const existingAttributeInfo = await this.storeTx.readMetadataTuples(
        '_schema',
        ['collections', collectionName, 'attributes', path]
      );
      // Delete old attribute tuples
      const deletes = existingAttributeInfo.map<[string, AttributeItem[]]>(
        (eav) => [eav[0], eav[1]]
      );
      await this.storeTx.deleteMetadataTuples(deletes);
    }

    // TODO: check _collection marker too?
    // const attribute = [collectionName, path];
    // const currentTriples = this.storeTx.findByAttribute(attribute);
    // this.storeTx.deleteTriples(currentTriples);
  }
}
