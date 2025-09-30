// This file is ported from v1 - not sure we strictly need it or if its well organised

import { type Schema, Validator } from "@cfworker/json-schema";
import type z from "zod/v4";
import { toJSONSchema, type ZodType } from "zod/v4";
import type { JSONSchema } from "zod/v4/core";
import { logger as console } from "../tag-logger.ts";

// Backward compatibility - alias BaseJSONSchema to JSONSchema.JSONSchema
export type BaseJSONSchema = JSONSchema.JSONSchema;

export type SchemaBranded<T extends JSONSchema.JSONSchema, K extends ZodType<any>> = T & {
  __type: z.infer<K>;
};
export type InputOutputSchemaBranded = {
  inputSchema: SchemaBranded<JSONSchema.JSONSchema, ZodType>;
  outputSchema: SchemaBranded<JSONSchema.JSONSchema, ZodType>;
};
export type InferInputSchema<T extends InputOutputSchemaBranded> = T["inputSchema"]["__type"];
export type InferOutputSchema<T extends InputOutputSchemaBranded> = T["outputSchema"]["__type"];

export function toBrandedSchema<T extends ZodType>(schema: T) {
  const result = toJSONSchema(schema);
  return result as unknown as SchemaBranded<typeof result, T>;
}

// Use `Schema['type']` for single types, and `Schema['type'][]` for arrays.
// The function can return either a single type, an array of types, or undefined.
export function mapZodSchemaTypeToCFWorkerSchemaType(
  type: string | string[] | undefined,
): Schema["type"] | Schema["type"][] | undefined {
  if (type === undefined) {
    return undefined;
  }

  const mapSingleType = (t: string): Schema["type"] => {
    // Allowlist known valid types for @cfworker/json-schema
    if (t === "array") {
      return "array";
    }
    if (t === "boolean") {
      return "boolean";
    }
    if (t === "integer") {
      return "integer";
    }
    if (t === "string") {
      return "string";
    }
    if (t === "null") {
      return "null";
    }
    if (t === "number") {
      return "number";
    }
    if (t === "object") {
      return "object";
    }
    // Handle Zod-specific types or other JSON schema types not supported by @cfworker/json-schema
    // Throw an error as they cannot be reliably mapped.
    throw new Error(`Unsupported Zod type "${t}" for CFWorker Schema mapping.`);
  };

  if (Array.isArray(type)) {
    // Ensure all types in the array are supported before mapping
    return type.map(mapSingleType);
  }
  return mapSingleType(type);
}

// Recursive helper function to traverse and map the schema
function mapRecursive(data: any): any {
  // Base case: return primitives, null, etc., as is.
  if (typeof data !== "object" || data === null) {
    return data;
  }

  // If it's an array, recurse on each element
  if (Array.isArray(data)) {
    return data.map(mapRecursive);
  }

  // It's an object, process its key-value pairs
  const mappedObject: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "type") {
      // Apply the specific type mapping logic only for the 'type' key
      mappedObject.type = mapZodSchemaTypeToCFWorkerSchemaType(
        value as string | string[] | undefined,
      );
    } else {
      // For all other keys, recurse on their values
      mappedObject[key] = mapRecursive(value);
    }
  }
  return mappedObject;
}

function mapZodJsonToCFWorkerSchema(
  schema: JSONSchema.JSONSchema | undefined | boolean,
): Schema | undefined | boolean {
  // Use the recursive helper to perform the transformation
  const mappedSchema = mapRecursive(schema);

  // The helper returns 'any'. We perform a final check/cast.
  // Return booleans and undefined directly.
  if (typeof mappedSchema === "boolean" || mappedSchema === undefined) {
    return mappedSchema;
  }

  // If the result is an object, assume it's the transformed Schema.
  // A runtime validation could be added here for robustness if needed.
  if (typeof mappedSchema === "object" && mappedSchema !== null) {
    return mappedSchema as Schema;
  }

  // Log a warning or throw an error for unexpected result types.
  console.warn(
    "mapZodJsonToCFWorkerSchema encountered an unexpected result type after recursion:",
    typeof mappedSchema,
  );
  // Return undefined indicating a potential issue with the input schema or transformation.
  return undefined;
}

export function parseBrandedSchema<T extends SchemaBranded<JSONSchema.JSONSchema, any>>(
  schema: T,
  input: unknown,
): T["__type"] {
  const cfWorkerSchema = mapZodJsonToCFWorkerSchema(schema);
  // The Validator expects a Schema object or a boolean, handle the undefined case.
  if (cfWorkerSchema === undefined) {
    // Handle error: schema transformation failed or resulted in undefined.
    // Depending on requirements, could throw, or perhaps default to a schema that allows/denies everything.
    // Throwing is likely safest to indicate an unexpected state.
    throw new Error(
      "Failed to transform Zod schema to a valid CFWorker schema (resulted in undefined).",
    );
  }

  // Now cfWorkerSchema is narrowed to `Schema | boolean`
  const validator = new Validator(cfWorkerSchema);
  const result = validator.validate(input);
  if (result.valid) {
    return input as T["__type"];
  }
  throw new Error(`Invalid input: ${JSON.stringify(result.errors)}`);
}

// Helper to determine if a value is a plain object (and not null/array)
function _isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively subtracts the properties present in `provided` from the given JSON schema.
 *
 * This function now supports nested objects. For each provided key:
 *   • If the key maps to a nested object in both `schema` and `provided`, it recurses into that
 *     nested schema.
 *   • If the resulting nested schema no longer has any requirements (`properties` or `required`),
 *     the key is removed entirely from the parent schema (it has been fully satisfied).
 *   • For primitives or non-object values, the key is removed straight away.
 */
// Re-export from the separate file
export { subtractObjectPropsFromJSONSchema } from "./subtract-object-props-from-json-schema.ts";
