import { Models } from '../../types/index.js';
import { JSONSchema7 } from 'json-schema';
import { schemaToJSON } from '../json/export.js';
import {
  transformDate,
  transformRecord,
  transformSet,
  transformOptions,
  deleteRelationFields,
  transformPropertiesOptionalToRequired,
} from './transform-funcs.js';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { transformObjectDeeply } from './transform-object-deeply.js';

// =============

const ajv = new Ajv({
  // options
  strict: true,
});

// @ts-expect-error (weird typing here)
addFormats(ajv);

/**
 * Export a triplit collection schema to valid JSON schema.
 * Permits using Triplit as the Main Source of Truth.
 * (JSON schema can be used by most popular data validation libs)
 **/
export function exportCollectionAsJSONSchema(
  schema: Models,
  collectionName: string
): JSONSchema7 {
  const triplitCollectionJsonData = schemaToJSON({
    collections: schema,
    version: 0,
  });

  return transformTriplitJsonDataInJsonSchema(
    triplitCollectionJsonData,
    collectionName
  );
}

/**
 * Utility Function to iterate and export all collections.
 * Use `exportCollectionAsJSONSchema` for single collections
 **/
export function exportSchemaAsJSONSchema(
  schema: Models
): JSONSchema7 | undefined {
  //
  if (!schema) return undefined;

  const collectionsListJsonSchema: Record<string, JSONSchema7> = {};

  const triplitSchemaJsonData = schemaToJSON({
    collections: schema,
    version: 0,
  });

  // copy and work on duplicate to keep original object unchanged
  const duplicateOfTriplitSchemaJsonData = structuredClone(
    triplitSchemaJsonData
  );

  for (const collectionKey in duplicateOfTriplitSchemaJsonData?.collections) {
    //
    const collectionJsonSchema: JSONSchema7 =
      transformTriplitJsonDataInJsonSchema(
        duplicateOfTriplitSchemaJsonData,
        collectionKey
      );

    collectionsListJsonSchema[collectionKey] = collectionJsonSchema;
  }

  return {
    title: 'JSON Schema of Triplit Schema',
    description: `version ${0}`,
    type: 'object',
    properties: {
      ...collectionsListJsonSchema,
    },
  };
}

export const transformFunctions = [
  // PRE: needs to run first as it might delete keys
  deleteRelationFields,
  // Mid:
  transformDate,
  transformRecord,
  transformSet,
  transformOptions,
  // POST: must run last since other functions might delete keys
  transformPropertiesOptionalToRequired,
];

function transformTriplitJsonDataInJsonSchema(
  triplitCollectionJsonData: Record<string, any>,
  collection: string
) {
  // get collection
  const collectionToTransform =
    triplitCollectionJsonData?.collections?.[collection].schema;

  const cloneToTransform = structuredClone(collectionToTransform);
  transformFunctions.map((transformFunc) => {
    transformObjectDeeply(cloneToTransform, transformFunc);
  });

  // evaluate to ensure it compiles
  // e.g. if triplit changes their format
  const schemaEvaluation = ajv.compile(cloneToTransform);

  if (schemaEvaluation.errors != null)
    throw new Error('Transform Error: Not a valid JSON schema.');

  return cloneToTransform;
}
