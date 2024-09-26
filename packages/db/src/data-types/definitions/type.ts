import { Models, AttributeDefinition } from '../../schema/types/index.js';
import { Operator } from '../../query/types/index.js';

/**
 * This represents a definition of a type that can be used in a collection
 * It can be used to completely define the shape, validation, and serialization of a typ
 */
export type TypeInterface<
  TypeId extends string = string, // possibly specify known value types
  JSType = any,
  DBType = any, // string, number, boolean, array, object
  Operators extends readonly Operator[] = readonly Operator[]
> = {
  readonly type: TypeId;
  readonly supportedOperations: Operators;
  // Context stores additional runtime information about the type
  readonly context: Record<string, any>;
  // How the this definition should be serialized
  // it needs to contain enough information to be able to reconstruct the type
  toJSON(): AttributeDefinition; // TOOD: handle proper typing with nulls too

  // How to convert the input (e.g. from db.insert(..)) to the internal value
  convertInputToDBValue(val: JSType): DBType;

  convertDBValueToJS(val: DBType, schema?: Models): JSType;

  convertJSONToJS(val: any, schema?: Models): JSType;

  convertJSToJSON(val: JSType, schema?: Models): any;

  // Should return a possible user input value
  defaultInput(): JSType | undefined;

  // User input validation
  validateInput(val: any): string | undefined;

  // Triple store validation
  validateTripleValue(val: any): boolean;
};
