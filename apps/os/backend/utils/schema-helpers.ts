import z, { ZodError } from "zod";

import type { $ZodType } from "zod/v4/core";
import type { JSONSerializable } from "./type-helpers.ts";

/**
 * Get the type of a Zod schema
 */
export function getSchemaType(schema: z.ZodType | $ZodType): string {
  return "def" in schema ? schema.def.type : schema._zod.def.type;
}

/**
 * Check if a schema is a union type (union or discriminated union)
 */
export function isUnionType(schema: z.ZodType | $ZodType): boolean {
  const type = getSchemaType(schema);
  return type === "union";
}

/**
 * Check if a schema is an object type
 */
export function isObjectType(schema: z.ZodType | $ZodType): boolean {
  const type = getSchemaType(schema);
  return type === "object";
}

/**
 * Check if a schema is an optional type
 */
export function isOptionalType(schema: z.ZodType | $ZodType): boolean {
  const type = getSchemaType(schema);
  return type === "optional";
}

/**
 * Unwrap an optional schema to get its inner type
 */
export function unwrapOptionalSchema(schema: z.ZodType | $ZodType): z.ZodType {
  const type = getSchemaType(schema);
  if (type !== "optional") {
    throw new Error(`Expected optional type, got ${type}`);
  }

  if ("def" in schema && "innerType" in schema.def) {
    return schema.def.innerType as z.ZodType;
  }

  throw new Error("Unable to unwrap optional schema");
}

/**
 * Extract union options from a union or discriminated union schema
 */
export function getUnionOptions(schema: z.ZodType | $ZodType): Array<z.ZodType> {
  const type = getSchemaType(schema);
  if (type !== "union") {
    throw new Error(`Expected union type, got ${type}`);
  }

  // Handle both ZodUnion and ZodDiscriminatedUnion
  if ("def" in schema && "options" in schema.def) {
    return schema.def.options as Array<z.ZodType>;
  }

  throw new Error("Unable to extract union options");
}

/**
 * Extract shape from an object schema, handling wrapped types
 */
export function extractObjectShape(schema: z.ZodType | $ZodType): Record<string, z.ZodType> {
  const type = getSchemaType(schema);

  switch (type) {
    case "object":
      return (schema as z.ZodObject).shape;
    case "optional":
      return extractObjectShape((schema as z.ZodOptional).def.innerType);
    case "readonly":
      return extractObjectShape((schema as z.ZodReadonly).def.innerType);
    default:
      throw new Error(`Cannot extract shape from schema type: ${type}`);
  }
}

/**
 * Merge two object schemas by combining their shapes
 */
export function mergeObjectSchemas(schema1: z.ZodType, schema2: z.ZodType): z.ZodObject {
  const shape1 = extractObjectShape(schema1);
  const shape2 = extractObjectShape(schema2);

  return z.object({
    ...shape1,
    ...shape2,
  });
}

/**
 * Merge a schema with each option in a union, creating a new union
 * This implements the distributive property: A & (B | C) = (A & B) | (A & C)
 */
export function mergeSchemaWithUnion(schema: z.ZodType, unionSchema: z.ZodType): z.ZodUnion<any> {
  const unionOptions = getUnionOptions(unionSchema);

  const mergedOptions = unionOptions.map((option) => {
    if (isObjectType(schema) && isObjectType(option)) {
      return mergeObjectSchemas(schema, option);
    } else if (isObjectType(schema) && isUnionType(option)) {
      // Recursively handle nested unions
      return mergeSchemaWithUnion(schema, option);
    } else if (isUnionType(schema) && isObjectType(option)) {
      // Swap and recurse
      return mergeSchemaWithUnion(option, schema);
    } else {
      // For non-object types, we can't merge meaningfully
      // This might need more sophisticated handling depending on use case
      throw new Error(
        `Cannot merge schema types: ${getSchemaType(schema)} with ${getSchemaType(option)}`,
      );
    }
  });

  // Ensure we have at least 2 options for union
  if (mergedOptions.length < 2) {
    throw new Error("Union must have at least 2 options");
  }

  return z.union([mergedOptions[0], mergedOptions[1], ...mergedOptions.slice(2)] as [
    z.ZodType,
    z.ZodType,
    ...z.ZodType[],
  ]);
}

/**
 * Create cartesian product of two unions
 * (A | B) & (C | D) = (A & C) | (A & D) | (B & C) | (B & D)
 */
export function mergeUnionWithUnion(union1: z.ZodType, union2: z.ZodType): z.ZodUnion<any> {
  const options1 = getUnionOptions(union1);
  const options2 = getUnionOptions(union2);

  const cartesianProduct: z.ZodType[] = [];

  for (const option1 of options1) {
    for (const option2 of options2) {
      if (isObjectType(option1) && isObjectType(option2)) {
        cartesianProduct.push(mergeObjectSchemas(option1, option2));
      } else if (isUnionType(option1) && isObjectType(option2)) {
        cartesianProduct.push(mergeSchemaWithUnion(option2, option1));
      } else if (isObjectType(option1) && isUnionType(option2)) {
        cartesianProduct.push(mergeSchemaWithUnion(option1, option2));
      } else if (isUnionType(option1) && isUnionType(option2)) {
        cartesianProduct.push(mergeUnionWithUnion(option1, option2));
      } else {
        throw new Error(
          `Cannot merge schema types in cartesian product: ${getSchemaType(
            option1,
          )} with ${getSchemaType(option2)}`,
        );
      }
    }
  }

  // Ensure we have at least 2 options for union
  if (cartesianProduct.length < 2) {
    throw new Error("Union must have at least 2 options");
  }

  return z.union([cartesianProduct[0], cartesianProduct[1], ...cartesianProduct.slice(2)] as [
    z.ZodType,
    z.ZodType,
    ...z.ZodType[],
  ]);
}

/**
 * Merge two schemas with proper handling of unions and objects
 */
export function mergeTwoSchemas(schema1: z.ZodType, schema2: z.ZodType): z.ZodType {
  // Handle optional schemas by unwrapping them
  let actualSchema1 = schema1;
  let actualSchema2 = schema2;

  if (isOptionalType(schema1)) {
    actualSchema1 = unwrapOptionalSchema(schema1);
  }

  if (isOptionalType(schema2)) {
    actualSchema2 = unwrapOptionalSchema(schema2);
  }

  const isSchema1Union = isUnionType(actualSchema1);
  const isSchema2Union = isUnionType(actualSchema2);
  const isSchema1Object = isObjectType(actualSchema1);
  const isSchema2Object = isObjectType(actualSchema2);

  if (isSchema1Object && isSchema2Object) {
    // Object + Object = merged object
    return mergeObjectSchemas(actualSchema1, actualSchema2);
  } else if (isSchema1Object && isSchema2Union) {
    // Object + Union = distribute object over union
    return mergeSchemaWithUnion(actualSchema1, actualSchema2);
  } else if (isSchema1Union && isSchema2Object) {
    // Union + Object = distribute object over union
    return mergeSchemaWithUnion(actualSchema2, actualSchema1);
  } else if (isSchema1Union && isSchema2Union) {
    // Union + Union = cartesian product
    return mergeUnionWithUnion(actualSchema1, actualSchema2);
  } else {
    throw new Error(
      `Cannot merge schema types: ${getSchemaType(
        actualSchema1,
      )} with ${getSchemaType(actualSchema2)}`,
    );
  }
}

/**
 * Construct a merged schema from an array of input schemas
 * Handles objects, unions, discriminated unions, and their combinations
 */
export function constructMergeSchema(inputs: Array<z.ZodType>): z.ZodType | null {
  if (inputs.length === 0) {
    return null;
  }

  if (inputs.length === 1) {
    return inputs[0]!;
  }

  // Sequentially merge all schemas
  const merged = inputs.reduce((acc, input) => {
    return mergeTwoSchemas(acc, input);
  });

  return merged;
}

/**
 * Recursively strips properties with Symbol keys and other non-JSON-serializable values from objects
 * to ensure they can be validated against JSONSerializable
 */
export function stripNonSerializableProperties(value: any): JSONSerializable {
  // Handle primitives and null/undefined
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(stripNonSerializableProperties);
  }

  // Handle objects
  if (typeof value === "object") {
    const cleanedObject: Record<string, JSONSerializable> = {};

    // Only process properties with string keys (not Symbols)
    for (const key of Object.keys(value)) {
      const cleanedValue = stripNonSerializableProperties(value[key]);
      if (cleanedValue !== undefined) {
        cleanedObject[key] = cleanedValue;
      }
    }

    return cleanedObject;
  }

  // For any other type (functions, symbols, etc.), return undefined
  return undefined;
}

/**
 * typedParse
 * ----------
 * A thin, generic wrapper around `schema.parse()` that
 *   • infers the exact input type      ➜ IDE autocompletion
 *   • returns the correct output type  ➜ no casting needed
 *   • converts ZodError into a concise, developer‑friendly Error
 *
 * Usage:
 *   const user = typedParse(userSchema, { type: "user", name: "Ann" });
 *
 * Example:
 *   import { typedParse } from "@iterate-com/helpers/schema-helpers";
 *   import z from "zod";
 *
 *   const userSchema = z.object({
 *     name: z.string(),
 *     role: z.string().default("user"),
 *     age: z.number().min(0)
 *   });
 *
 *   // TypeScript knows input type: { name: string; role?: string; age: number }
 *   // TypeScript knows output type: { name: string; role: string; age: number }
 *   const user = typedParse(userSchema, { name: "Alice", age: 25 });
 *
 *   // If validation fails, throws formatted error:
 *   // Validation failed:
 *   // ✖ Too small: expected number to be >=0
 *   //   → at age
 *   //
 *   // Payload:
 *   // { "name": "Bob", "age": -5 }
 */
export function typedParse<S extends z.ZodTypeAny>(
  schema: S,
  data: z.input<S>, // <-- exact, validated input shape
): z.output<S> {
  // <-- exact, validated output shape
  try {
    // NOTE: `.parse` applies defaults AND (if `.strict()` is on the schema)
    //       throws on excess properties.
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      // Use Zod's built-in prettifyError for better formatting
      throw new Error(
        `Validation failed:\n${z.prettifyError(err)}\n\nPayload:\n${JSON.stringify(data, null, 2)}`,
      );
    }
    throw err; // non‑Zod errors bubble up unchanged
  }
}
