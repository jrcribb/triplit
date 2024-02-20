import { TObject } from '@sinclair/typebox';
import { InvalidSchemaPathError } from './errors.js';
import type { CollectionNameFromModels, CollectionRules } from './db.js';
import { Timestamp } from './timestamp.js';
import type { Attribute, EAV, TripleRow } from './triple-store-utils.js';
import { dbDocumentToTuples, objectToTuples } from './utils.js';
import { CollectionQuery, constructEntity } from './query.js';
import { appendCollectionToId, StoreSchema } from './db-helpers.js';
import {
  typeFromJSON,
  DataType,
  TimestampType,
  ValueType,
} from './data-types/base.js';
import {
  CollectionDefinition,
  CollectionsDefinition,
  SchemaDefinition,
} from './data-types/serialization.js';
import { StringType } from './data-types/string.js';
import { NumberType } from './data-types/number.js';
import { BooleanType } from './data-types/boolean.js';
import { DateType } from './data-types/date.js';
import { RecordType } from './data-types/record.js';
import { SetType } from './data-types/set.js';
import {
  ExtractJSType,
  ExtractDBType,
  ExtractTimestampedType,
} from './data-types/type.js';
import {
  QueryResultCardinality,
  QueryType,
  SubQuery,
} from './data-types/query.js';

// We infer TObject as a return type of some funcitons and this causes issues with consuming packages
// Using solution 3.1 described in this comment as a fix: https://github.com/microsoft/TypeScript/issues/47663#issuecomment-1519138189
export type { TObject };

// Could also use a namespace or module, but this worked best with our type generation
export class Schema {
  static Id = () =>
    StringType({ nullable: false, default: this.Default.uuid() });
  static String = StringType;
  static Number = NumberType;
  static Boolean = BooleanType;
  static Date = DateType;

  static Record = RecordType;

  static Set = SetType;

  static Query = QueryType;

  static RelationMany = <
    C extends CollectionNameFromModels<any>,
    Q extends Omit<SubQuery<any, C>, 'collectionName'>
  >(
    collectionName: C,
    query: Q
  ) => QueryType({ collectionName, ...query }, 'many');

  static RelationOne = <
    C extends CollectionNameFromModels<any>,
    Q extends Omit<SubQuery<any, C>, 'collectionName'>
  >(
    collectionName: C,
    query: Q
  ) => QueryType({ collectionName, ...query, limit: 1 }, 'one');

  static RelationById = <C extends CollectionNameFromModels<any>>(
    collectionName: C,
    entityId: string
  ) => QueryType({ collectionName, where: [['id', '=', entityId]] }, 'one');

  static Schema<T extends SchemaConfig>(config: T) {
    return this.Record(config);
  }

  static get Default() {
    return {
      uuid: (length?: string) => ({
        func: 'uuid',
        args: length ? [length] : null,
      }),
      now: () => ({ func: 'now', args: null }),
    };
  }
}

type SchemaConfig = { id: ReturnType<typeof Schema.Id> } & Record<
  string,
  DataType
>;

export type Model<T extends SchemaConfig> = RecordType<T>;

export type Collection<T extends SchemaConfig = SchemaConfig> = {
  schema: Model<T>;
  rules?: CollectionRules<Model<T>>;
};

export type Models<
  CollectionName extends string,
  T extends SchemaConfig
> = Record<CollectionName, Collection<T>>;

// This will generally be what we store in the DB for a path
// Maybe refactor this to throw InvalidSchemaPathError more efficiently
export function getSchemaFromPath(
  model: Model<any>,
  path: Attribute
): DataType {
  if (path.length === 0) throw new InvalidSchemaPathError([]);
  let scope = model.properties[path[0]];
  if (!scope) throw new InvalidSchemaPathError(path as string[]);
  for (let i = 1; i < path.length; i++) {
    if (!scope) throw new InvalidSchemaPathError(path as string[]);
    if (scope.type === 'query') {
      return scope;
    }
    if (scope.type === 'set') {
      // scope = scope.of; // TODO: MAYBE validate here, we're validating a key, returning boolean
      scope = BooleanType(); // TODO: this is wrong? or right?
    } else if (scope.type === 'record') {
      const part = path[i];
      scope = scope.properties[part];
    } else {
      throw new InvalidSchemaPathError(path as string[]);
    }
  }
  if (!scope) throw new InvalidSchemaPathError(path as string[]);
  return scope;
}

export type UpdateTypeFromModel<M extends Model<any> | undefined> =
  M extends Model<any>
    ? {
        [k in keyof SelectModelFromModel<M>['properties'] as Exclude<
          k,
          'id'
        >]: ExtractJSType<M['properties'][k]>;
      } & { readonly id: string }
    : any;

// Used for entity reducer
export type TimestampedTypeFromModel<M extends Model<any>> =
  ExtractTimestampedType<M>;

// Check if a type is unknown or undefined
type IsUnknownOrUndefined<T> = unknown extends T
  ? true
  : undefined extends T
  ? true
  : false;

type BooleanNot<T extends boolean> = T extends true ? false : true;

type DataTypeHasNoDefault<T extends DataType> = T extends DataType
  ? T extends ValueType<infer TypeOptions>
    ? IsUnknownOrUndefined<TypeOptions['default']>
    : false // sets and records always have defaults (might want to refactor based on return type of default())
  : never;

type DataTypeHasDefault<T extends DataType> = BooleanNot<
  DataTypeHasNoDefault<T>
>;

export type InsertTypeFromModel<M extends Model<any> | undefined> =
  M extends Model<any>
    ? {
        // If the type has no default, it must be provided
        [k in keyof SelectModelFromModel<M>['properties'] as DataTypeHasNoDefault<
          M['properties'][k]
        > extends true
          ? k
          : never]: ExtractJSType<M['properties'][k]>;
      } & {
        // If the type has a default, it can be omitted
        [k in keyof SelectModelFromModel<M>['properties'] as DataTypeHasDefault<
          M['properties'][k]
        > extends true
          ? k
          : never]?: ExtractJSType<M['properties'][k]>;
      }
    : any;

// A subset of the model is available in select
export type SelectModelFromModel<M extends Model<any> | undefined> =
  M extends Model<infer Config>
    ? Config extends SchemaConfig
      ? Model<//@ts-expect-error
        {
          [k in keyof Config as Config[k] extends QueryType<any, any>
            ? never
            : k]: Config[k];
        }>
      : never
    : any;

type JSTypeFromModel<M extends Model<any> | undefined> = M extends Model<any>
  ? {
      [k in keyof M['properties']]: M['properties'][k] extends DataType
        ? ExtractJSType<M['properties'][k]>
        : never;
    }
  : any;

export type DBTypeFromModel<M extends Model<any> | undefined> =
  M extends Model<any>
    ? {
        [k in keyof M['properties']]: ExtractDBType<M['properties'][k]>;
      }
    : any;

export type TimestampedObject = Timestamped<object>;

export type Timestamped<T> = T extends { [key: string]: any }
  ? { [K in keyof T]: Timestamped<T[K]> }
  : [T, Timestamp];

export type UnTimestampedObject<T extends TimestampedObject> = {
  [k in keyof T]: T[k] extends TimestampedObject
    ? UnTimestampedObject<T[k]>
    : T[k] extends [value: infer V, timestamp: TimestampType]
    ? V
    : never;
};

export function convertEntityToJS<M extends Model<any>>(
  entity: TimestampedTypeFromModel<M>,
  schema?: M
) {
  // remove timestamps
  const untimestampedEntity = timestampedObjectToPlainObject(entity);

  // Clean internal fields from entities
  delete untimestampedEntity._collection;

  // convert values based on schema
  return schema
    ? schema.convertDBValueToJS(untimestampedEntity)
    : untimestampedEntity;
}

// USE THIS METHOD TO CONVERT USER INPUT DOC TO DB DATA
// One small thing we overlooked here is that we dont account for defaults when serializing a client record for db insert
// and we expect records to be fully hydrated at serialization time
// TODO: determine how we might be able to leverage defaults inside of records
// S.Record({ a: S.String({ default: 'a' }) })
export function clientInputToDbModel<M extends Model<any> | undefined>(
  input: JSTypeFromModel<M>,
  model: M
) {
  if (!model) return input as DBTypeFromModel<M>;
  return model.convertInputToDBValue(input) as DBTypeFromModel<M>;
}

// TODO: perform a pass on this to see how we can improve its types
export function timestampedObjectToPlainObject<O extends TimestampedObject>(
  obj: O,
  maintainKeys?: boolean
): UnTimestampedObject<O> {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }
  if (isTimestampedVal(obj)) {
    // @ts-expect-error
    return timestampedObjectToPlainObject(obj[0]);
  }
  if (obj instanceof Array) {
    // @ts-expect-error
    return obj
      .map((v) => timestampedObjectToPlainObject(v))
      .filter((v) => !!maintainKeys || v !== undefined);
  }
  if (obj instanceof Map) {
    // @ts-expect-error
    return new Map(
      Array.from(obj.entries()).map(([key, val]) => {
        return [key, timestampedObjectToPlainObject(val)];
      })
    );
  }
  const entries = Object.entries(obj)
    .map(([key, val]) => {
      return [key, timestampedObjectToPlainObject(val)];
    })
    .filter(([_key, val]) => !!maintainKeys || val !== undefined);
  //TODO: result statically typed as any
  const result = Object.fromEntries(entries);
  return result;
}

function isTimestampedVal(val: any) {
  return (
    val instanceof Array &&
    val.length === 2 &&
    val[1] instanceof Array &&
    val[1].length === 2
  );
}

export function collectionsDefinitionToSchema(
  collections: CollectionsDefinition
): Models<any, any> {
  return Object.fromEntries(
    Object.entries(collections).map(([collectionName, collectionDef]) => {
      return [
        collectionName,
        {
          ...collectionDef,
          schema: typeFromJSON(collectionDef.schema) as Model<any>,
        },
      ];
    })
  );
}

export function schemaToTriples(schema: StoreSchema<Models<any, any>>): EAV[] {
  const schemaData = schemaToJSON(schema);
  const tuples = dbDocumentToTuples(schemaData);
  return tuples.map((tuple) => {
    return [
      appendCollectionToId('_metadata', '_schema'),
      ['_metadata', ...tuple[0]],
      tuple[1],
    ] as EAV;
  });
}

export function triplesToSchema(triples: TripleRow[]) {
  const schemaEntity = constructEntity(
    triples,
    appendCollectionToId('_metadata', '_schema')
  );
  if (!schemaEntity) return undefined;
  return timestampedSchemaToSchema(schemaEntity.data);
}

export function timestampedSchemaToSchema(
  schema: Record<string, any>
): StoreSchema<Models<any, any>> | undefined {
  const schemaData = timestampedObjectToPlainObject(schema);
  const version = (schemaData.version as number) || 0;
  const collections = (schemaData.collections as CollectionsDefinition) || {};
  return JSONToSchema({
    version,
    collections,
  });
}

export function JSONToSchema(
  schemaJSON: SchemaDefinition | undefined
): StoreSchema<Models<any, any>> | undefined {
  if (!schemaJSON) return undefined;
  const collections = collectionsDefinitionToSchema(schemaJSON.collections);
  return { version: schemaJSON.version, collections };
}

export function schemaToJSON(
  schema: StoreSchema<Models<any, any>>
): SchemaDefinition;
export function schemaToJSON(schema: undefined): undefined;
export function schemaToJSON(
  schema: StoreSchema<Models<any, any> | undefined>
): SchemaDefinition | undefined;
export function schemaToJSON(
  schema: StoreSchema<Models<any, any> | undefined>
): SchemaDefinition | undefined {
  if (!schema) return undefined;
  const collections: CollectionsDefinition = {};
  for (const [collectionName, model] of Object.entries(schema.collections)) {
    const collection = collectionSchemaToJSON(model);
    collections[collectionName] = collection;
  }
  return { version: schema.version, collections };
}

function collectionSchemaToJSON(
  collection: Collection<any>
): CollectionDefinition {
  const rulesObj = collection.rules ? { rules: collection.rules } : {};
  return {
    schema: collection.schema.toJSON() as Model<any>,
    ...rulesObj,
  };
}

export function getDefaultValuesForCollection(
  collection: Collection<SchemaConfig>
) {
  return collection.schema.defaultInput();
}

// Poor man's hash function for schema
// Using this in place of a version check on schemas for syncing
// Schema versions are harder to manage with console updates
// Using this hash as a way to check if schemas mismatch since its easy to send as a url param
export function hashSchemaJSON(collections: CollectionsDefinition | undefined) {
  if (!collections) return undefined;
  // TODO: dont use this method if avoidable...trying to deprecate
  const tuples = objectToTuples(collections);
  const sortedTriplesStr = tuples
    .map((t) => JSON.stringify(t))
    .sort()
    .join('');
  return stringHash(sortedTriplesStr);
}

function stringHash(str: string, base = 31, mod = 1e9 + 9) {
  let hashValue = 0;
  for (let i = 0; i < str.length; i++) {
    hashValue = (hashValue * base + str.charCodeAt(i)) % mod;
  }
  return hashValue;
}
