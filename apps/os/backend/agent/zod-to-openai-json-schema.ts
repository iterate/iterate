import {
  strictObject,
  toJSONSchema,
  union,
  null as znull,
  ZodUndefined,
  type ZodNull,
  type ZodObject,
  type ZodType,
  type ZodUnion,
} from "zod";
import { logger } from "../tag-logger.ts";
import type { BaseJSONSchema, SchemaBranded } from "./schema-utils.ts";

const keysToStrip = ["workflowCallbackTarget"];

// Type guard to check if a schema is a union type
function isUnionType(schema: ZodType): boolean {
  return (
    schema.def.type === "union" ||
    (schema as any)._def?.typeName === "ZodUnion" ||
    (schema as any)._def?.typeName === "ZodDiscriminatedUnion"
  );
}

// Type guard to check if a schema is an object type with shape
function isObjectType(
  schema: ZodType,
): schema is ZodType & { shape: { [key: string]: ZodType<any> } } {
  return "shape" in schema && typeof schema.shape === "object" && schema.shape !== null;
}

export function zodToOpenAIJSONSchema<
  T extends
    | ZodObject<{ [key: string]: ZodType<any> }>
    | ZodUnion<readonly (ZodObject | ZodNull | ZodUndefined)[]>,
>(zodSchema: T): SchemaBranded<BaseJSONSchema, T> {
  // Handle union types directly as input
  if (isUnionType(zodSchema)) {
    const items = (zodSchema as ZodUnion).options;
    const filteredItems = items.filter((i) => !(i instanceof ZodUndefined));
    if (filteredItems.length !== items.length) {
      zodSchema = union(filteredItems.concat(znull())) as unknown as T;
    }
    return JSON.parse(
      JSON.stringify(
        toJSONSchema(zodSchema, {
          override: (ctx) => {
            logger.log("ctx.jsonSchema", ctx.jsonSchema);
            makeJSONSchemaOpenAICompatible(ctx.jsonSchema);
          },
          unrepresentable: "any",
        }),
        null,
        0,
      ).replaceAll('{"not":{}}', "false"),
    ) as SchemaBranded<BaseJSONSchema, T>;
  }
  // Fallback for other types
  try {
    if (zodSchema instanceof ZodUndefined) {
      return {
        type: "null",
        description: "The value can be null",
      } as SchemaBranded<BaseJSONSchema, T>;
    }
    // Handle object types (existing logic)
    if (isObjectType(zodSchema)) {
      return JSON.parse(
        JSON.stringify(
          toJSONSchema(strictObject(zodSchema.shape), {
            override: (ctx) => {
              makeJSONSchemaOpenAICompatible(ctx.jsonSchema);
            },
            unrepresentable: "any",
          }),
          null,
          0,
        ).replaceAll('{"not":{}}', "false"),
      ) as SchemaBranded<BaseJSONSchema, T>;
    }

    return JSON.parse(
      JSON.stringify(
        toJSONSchema(zodSchema, {
          override: (ctx) => {
            makeJSONSchemaOpenAICompatible(ctx.jsonSchema);
          },
          unrepresentable: "any",
        }),
        null,
        0,
      ).replaceAll('{"not":{}}', "false"),
    ) as SchemaBranded<BaseJSONSchema, T>;
  } catch (e) {
    logger.log(zodSchema);
    logger.error("Error converting zod schema to openai json schema", e);
    throw e;
  }
}

export function makeCloneOpenAICompatible(obj: any) {
  const clone = JSON.parse(JSON.stringify(obj));
  makeJSONSchemaOpenAICompatible(clone);
  return clone;
}

/**
 * Main function to ensure JSON schema is OpenAI compatible.
 * This needs to handle all the differences betwxeen standard JSON Schema and what OpenAI's API accepts
 */
export function makeJSONSchemaOpenAICompatible(obj: any) {
  // First, handle $ref resolution if there are any
  if (hasReferences(obj)) {
    const resolved = resolveReferences(obj);
    // Copy resolved properties back to obj
    Object.keys(obj).forEach((key) => delete obj[key]);
    Object.assign(obj, resolved);
  }

  // Remove $defs section after references are resolved
  if ("$defs" in obj) {
    delete obj.$defs;
  }

  if (typeof obj === "object" && Object.keys(obj).length === 0) {
    obj.$original = "empty_schema";
    obj.additionalProperties = false;
    obj.type = "string";
    obj.description = "The value can be a string containing a JSON object";
  }

  if (!obj || typeof obj !== "object") {
    return;
  }

  if (!obj.type && typeof obj.const === "string") {
    obj.type = "string";
    obj.description = `The value MUST be: ${obj.const}`;
    delete obj.type.const;
  }

  // Delete pattern key if present (openai doesn't support it)
  if (obj.type === "string" && "pattern" in obj) {
    delete obj.pattern;
  }

  // Delete format key if present
  if (obj.type === "string" && "format" in obj) {
    delete obj.format;
  }

  // Delete propertyNames key if present (OpenAI does not support it)
  if ("propertyNames" in obj) {
    delete obj.propertyNames;
  }

  if (obj.type === "object") {
    // Only set additionalProperties to false if it hasn't already been defined
    if (obj.additionalProperties === undefined) {
      obj.additionalProperties = false;
    }

    // Ensure properties field exists for OpenAI compatibility
    if (!obj.properties) {
      obj.properties = {};
    }

    keysToStrip.forEach((key) => {
      if (obj.properties && key in obj.properties) {
        delete obj.properties[key];
        // Also remove from required array if present
        if (Array.isArray(obj.required)) {
          obj.required = obj.required.filter((k: any) => k !== key);
        }
      }
    });
  }

  // Delete default key if present
  if ("default" in obj) {
    delete obj.default;
  }

  // Handle arrays (check items property)
  if (obj.items) {
    makeJSONSchemaOpenAICompatible(obj.items);
  }

  // Handle objects with properties
  if (obj.properties) {
    // Preserve existing "required" if present; do not auto-require all properties
    if (Array.isArray(obj.required) && obj.required.length === 0) {
      // Remove empty required array
      delete obj.required;
    }
    Object.values(obj.properties).forEach((prop) => {
      makeJSONSchemaOpenAICompatible(prop);
    });
  }

  // Handle anyOf, oneOf, allOf arrays
  ["anyOf", "oneOf", "allOf"].forEach((key) => {
    if (Array.isArray(obj[key])) {
      obj[key].forEach(makeJSONSchemaOpenAICompatible);
      obj[key].forEach(setAdditionalPropertiesFalse);
      // filter out any objects with only additionalProperties set to false - these are json representations of the "any" object
      obj[key] = obj[key].filter(
        (item) => !(Object.keys(item).length === 1 && item.additionalProperties === false),
      );
    }
  });

  // Recursively process additionalProperties if it's an object
  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    makeJSONSchemaOpenAICompatible(obj.additionalProperties);
  }

  // Final cleanup: remove empty required arrays
  if (Array.isArray(obj.required) && obj.required.length === 0) {
    delete obj.required;
  }
}

/**
 * Check if an object contains any $ref references
 */
function hasReferences(obj: any): boolean {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  if ("$ref" in obj) {
    return true;
  }

  for (const value of Object.values(obj)) {
    if (hasReferences(value)) {
      return true;
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (hasReferences(item)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Resolve $ref references by inlining them. For recursive references,
 * we simplify to a generic "any" representation that OpenAI can handle.
 */
function resolveReferences(obj: any, definitions?: any, visited = new Set<string>()): any {
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  // Extract definitions from the root if not provided
  const defs = definitions || obj.$defs;

  // Handle $ref
  if (obj.$ref) {
    const ref = obj.$ref;

    // Check for circular reference
    if (visited.has(ref)) {
      // Replace with a simple schema for recursive types
      return {
        type: "string",
        description: "The value can be a string containing a JSON object",
        additionalProperties: false,
      };
    }

    // Parse the reference
    if (ref.startsWith("#/$defs/")) {
      const defName = ref.replace("#/$defs/", "");
      if (defs?.[defName]) {
        visited.add(ref);
        const resolved = JSON.parse(JSON.stringify(defs[defName]));
        const result = resolveReferences(resolved, defs, visited);
        visited.delete(ref);
        return result;
      }
    }

    // If we can't resolve, replace with generic schema
    return {
      type: "string",
      description: "The value can be a string containing a JSON object",
      additionalProperties: false,
    };
  }

  // Create a copy to avoid modifying the original
  const result = Array.isArray(obj) ? [...obj] : { ...obj };

  // Process all properties recursively
  for (const key in result) {
    if (key === "$defs") {
      continue; // Skip definitions, we'll remove them later
    }

    if (Array.isArray(result[key])) {
      result[key] = result[key].map((item: any) => resolveReferences(item, defs, visited));
    } else if (typeof result[key] === "object") {
      result[key] = resolveReferences(result[key], defs, visited);
    }
  }

  return result;
}

function setAdditionalPropertiesFalse(obj: any) {
  obj.additionalProperties = false;
}
