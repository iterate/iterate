export type JsonSchema = boolean | Record<string, unknown>;

export function resolveJsonSchema(schema: unknown, root: JsonSchema): JsonSchema | undefined {
  if (typeof schema === "boolean") return schema;
  if (!schema || typeof schema !== "object") return undefined;
  const ref = (schema as Record<string, unknown>).$ref;
  return typeof ref === "string" ? resolveRef(ref, root) : (schema as JsonSchema);
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[
      segment.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
  }
  return typeof current === "boolean" || (current != null && typeof current === "object")
    ? (current as JsonSchema)
    : undefined;
}
