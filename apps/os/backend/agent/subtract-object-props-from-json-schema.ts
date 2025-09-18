import type { JSONSchema } from "zod/v4/core";

export interface JSONSerializableObject {
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is JSONSerializableObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

export function subtractObjectPropsFromJSONSchema(
  schema: JSONSchema.JSONSchema,
  provided: JSONSerializableObject,
): JSONSchema.JSONSchema {
  // Shallow clone to avoid mutating caller's schema
  const result: Record<string, unknown> = { ...schema };
  // Ensure we are working with an object-schema (we treat missing `type` as object)
  const typeVal = result.type;
  if (typeVal && typeVal !== "object" && !(Array.isArray(typeVal) && typeVal.includes("object"))) {
    throw new Error("subtractObjectPropsFromSchema: only supports type=object schemas");
  }

  // Clean up empty required arrays before checking for early return
  if (Array.isArray(result.required) && result.required.length === 0) {
    delete result.required;
  }

  // If there are no properties defined we can bail out early
  if (!result.properties || typeof result.properties !== "object") {
    return result as JSONSchema.JSONSchema;
  }

  // Clone the properties map so we can mutate safely
  const propertiesCopy: Record<string, JSONSchema.JSONSchema> = {
    ...(result.properties as Record<string, JSONSchema.JSONSchema>),
  };

  for (const [key, providedVal] of Object.entries(provided)) {
    if (!(key in propertiesCopy)) {
      continue; // nothing to do
    }

    const propSchema = propertiesCopy[key];

    if (isPlainObject(providedVal)) {
      // recurse for nested objects (only if the schema is also an object-schema)
      const nestedSchema = subtractObjectPropsFromJSONSchema(
        propSchema,
        providedVal as JSONSerializableObject,
      );

      // If the nested schema still has validation rules keep it, otherwise drop it
      const hasRemainingRules =
        (nestedSchema.properties && Object.keys(nestedSchema.properties).length > 0) ||
        (Array.isArray(nestedSchema.required) && nestedSchema.required.length > 0);

      if (hasRemainingRules) {
        propertiesCopy[key] = nestedSchema;
      } else {
        delete propertiesCopy[key];
      }
    } else {
      // Primitive or non-object provided value — remove property completely
      delete propertiesCopy[key];
    }
  }

  // Replace properties with the pruned copy (or delete if empty)
  if (Object.keys(propertiesCopy).length > 0) {
    result.properties = propertiesCopy;
  } else {
    delete result.properties;
  }

  // Adjust required list – remove keys whose schemas have been fully satisfied (i.e. no longer
  // present in the properties map)
  if (Array.isArray(result.required)) {
    const remainingProps: Record<string, unknown> =
      result.properties && typeof result.properties === "object"
        ? (result.properties as Record<string, unknown>)
        : {};

    result.required = result.required.filter(
      (k: unknown) => typeof k === "string" && k in remainingProps,
    );
    if ((result.required as string[]).length === 0) {
      delete result.required;
    }
  }

  return result as JSONSchema.JSONSchema;
}
