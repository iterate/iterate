export type JsonSchema = boolean | Record<string, unknown>;

const MAX_DEPTH = 8;

// This is intentionally lossy. Capability descriptions need useful editor
// hints, not a full JSON Schema compiler, so unknown-on-doubt is better than
// dragging a large dependency into the minimal reference.
export function jsonSchemaToTypeString(schema: unknown, root: JsonSchema, depth = 0): string {
  if (typeof schema === "boolean") return schema ? "unknown" : "never";
  if (!schema || typeof schema !== "object") return "unknown";
  if (depth > MAX_DEPTH) return "unknown";

  const node = schema as Record<string, unknown>;
  if (typeof node.$ref === "string") {
    const resolved = resolveRef(node.$ref, root);
    return resolved === undefined ? "unknown" : jsonSchemaToTypeString(resolved, root, depth + 1);
  }

  const nullable = node.nullable === true ? " | null" : "";
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum.map((value) => JSON.stringify(value) ?? "unknown").join(" | ") + nullable;
  }
  if (node.const !== undefined) {
    return (JSON.stringify(node.const) ?? "unknown") + nullable;
  }

  const union = (variants: unknown) =>
    Array.isArray(variants) && variants.length > 0
      ? variants.map((variant) => jsonSchemaToTypeString(variant, root, depth + 1)).join(" | ")
      : null;
  const oneOf = union(node.oneOf) ?? union(node.anyOf);
  if (oneOf) return oneOf + nullable;
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    return (
      node.allOf.map((variant) => jsonSchemaToTypeString(variant, root, depth + 1)).join(" & ") +
      nullable
    );
  }

  const type = Array.isArray(node.type)
    ? node.type.map((entry) => scalarType(String(entry))).join(" | ")
    : typeof node.type === "string"
      ? node.type
      : undefined;

  if (type === "array") {
    return `${jsonSchemaToTypeString(node.items, root, depth + 1)}[]` + nullable;
  }
  if (type === "object" || (type === undefined && node.properties != null)) {
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    const members = Object.entries(properties).map(
      ([name, propSchema]) =>
        `${propertyKey(name)}${required.has(name) ? "" : "?"}: ${jsonSchemaToTypeString(propSchema, root, depth + 1)}`,
    );
    if (node.additionalProperties && node.additionalProperties !== false) {
      const valueType =
        node.additionalProperties === true
          ? "unknown"
          : jsonSchemaToTypeString(node.additionalProperties, root, depth + 1);
      members.push(`[key: string]: ${valueType}`);
    }
    return members.length === 0
      ? "Record<string, unknown>" + nullable
      : `{ ${members.join("; ")} }` + nullable;
  }
  if (type !== undefined) return scalarType(type) + nullable;
  return "unknown";
}

export function resolveJsonSchema(schema: unknown, root: JsonSchema): JsonSchema | undefined {
  if (typeof schema === "boolean") return schema;
  if (!schema || typeof schema !== "object") return undefined;
  const ref = (schema as Record<string, unknown>).$ref;
  return typeof ref === "string" ? resolveRef(ref, root) : (schema as JsonSchema);
}

export function propertyKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

export function escapeJsDoc(text: string): string {
  return text.replaceAll("*/", "*\\/");
}

function scalarType(type: string): string {
  if (type === "integer" || type === "number") return "number";
  if (type === "string" || type === "boolean") return type;
  if (type === "null") return "null";
  if (type === "array") return "unknown[]";
  if (type === "object") return "Record<string, unknown>";
  return "unknown";
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
