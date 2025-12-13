import { z } from "zod";
import type { AnyProcedure, AnyTRPCRouter } from "@trpc/server";
import { constructMergeSchema } from "../utils/schema-helpers.ts";
import { logger } from "../tag-logger.ts";
import type { RuntimeJsonSchema } from "./do-tools.ts";

export type DurableObjectClass<T = any> = new (ctx: DurableObjectState, env: any) => T;

const createFallbackJsonSchema = () => {
  try {
    return z.toJSONSchema(z.looseObject({}), {
      unrepresentable: "any",
      target: "draft-2020-12",
    });
  } catch (error) {
    logger.error("Failed to create fallback JSON schema:", error);
    // Ultimate fallback if even the empty object schema fails
    return { type: "object", additionalProperties: true };
  }
};

export const convertTrpcRouterToRuntimeJsonSchema = (router: AnyTRPCRouter) => {
  const procedures = Object.keys(router._def.procedures);
  const schemas = Object.fromEntries(
    procedures
      .map((p) => {
        try {
          const schema = procedureToJSONSchema(router, p);
          return [p, schema];
        } catch (error) {
          logger.error(`Failed to generate JSON schema for TRPC procedure ${p}:`, error);
          // Create a fallback runtime schema
          const fallbackJsonSchema = createFallbackJsonSchema();
          return [
            p,
            {
              metadata: {},
              inputJsonSchema: fallbackJsonSchema,
              outputJsonSchema: fallbackJsonSchema,
            } as RuntimeJsonSchema,
          ];
        }
      })
      .filter(([_, schema]) => schema !== null) as [string, RuntimeJsonSchema][],
  );
  return schemas;
};

/**
 * Filters out optional fields from a JSON schema, keeping only required fields.
 * This function recursively processes nested objects and arrays.
 *
 * @param schema - The JSON schema to filter
 * @returns A new JSON schema with only required fields
 */
export const filterOptionalFieldsFromJSONSchema = (schema: any): any => {
  // If not an object, return as-is
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  // Clone the schema to avoid mutations
  const result: any = { ...schema };

  // Handle object schemas
  if (result.type === "object" || (!result.type && result.properties)) {
    const requiredFields = result.required || [];
    const properties = result.properties || {};

    // Filter properties to only include required ones
    const filteredProperties: any = {};
    for (const field of requiredFields) {
      if (properties[field]) {
        // Recursively filter nested schemas
        filteredProperties[field] = filterOptionalFieldsFromJSONSchema(properties[field]);
      }
    }

    // Update the result
    if (Object.keys(filteredProperties).length > 0) {
      result.properties = filteredProperties;
    } else {
      delete result.properties;
    }

    // Always keep the required array if it exists
    if (result.required && result.required.length === 0) {
      delete result.required;
    }
  }

  // Handle arrays
  if (result.type === "array" && result.items) {
    result.items = filterOptionalFieldsFromJSONSchema(result.items);
  }

  // Handle oneOf, anyOf, allOf
  if (result.oneOf) {
    result.oneOf = result.oneOf.map((s: any) => filterOptionalFieldsFromJSONSchema(s));
  }
  if (result.anyOf) {
    result.anyOf = result.anyOf.map((s: any) => filterOptionalFieldsFromJSONSchema(s));
  }
  if (result.allOf) {
    result.allOf = result.allOf.map((s: any) => filterOptionalFieldsFromJSONSchema(s));
  }

  return result;
};

export const procedureToJSONSchema = (
  router: AnyTRPCRouter,
  path: string,
): RuntimeJsonSchema | null => {
  const procedure = router._def.procedures[path] as AnyProcedure;
  if (!procedure) {
    return null;
  }
  // @ts-expect-error, this is fine for our use case
  const { inputs, outputs, meta } = procedure._def;
  const inputSchema = constructMergeSchema(inputs as any) ?? z.object({});
  const outputSchema = outputs
    ? (constructMergeSchema(outputs as any) ?? z.object({}))
    : z.looseObject({});

  return {
    type: procedure._def.type,
    metadata: meta ?? {},
    inputJsonSchema: z.toJSONSchema(inputSchema, {
      unrepresentable: "any",
      io: "input",
      override: zodToJsonSchemaOverride,
    }),
    outputJsonSchema: z.toJSONSchema(outputSchema, {
      unrepresentable: "any",
      io: "output",
      override: zodToJsonSchemaOverride,
    }),
  };
};

const zodToJsonSchemaOverride: import("zod/v4/core").JSONSchemaGenerator["override"] = (ctx) => {
  if (ctx.zodSchema instanceof z.ZodDate) {
    ctx.jsonSchema.format = "date-time";
  }
};
