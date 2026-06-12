// OpenAPI 3.x → TypeScript declaration STRING — the machine-facing half of a
// capability's self-description (`types` in describe()). Dependency-free and
// deliberately small: one `declare function <operationId>(input): Promise<…>`
// per operation, with JSON Schema converted structurally (objects, arrays,
// primitives, enums, unions, basic $ref against components.schemas) and
// `unknown` wherever fidelity would cost complexity. Structure cribbed from
// cloudflare/agents packages/codemode (json-schema-types.ts), reduced to what
// an agent reading describe() actually needs.

type SchemaNode = Record<string, unknown>;

export type OpenApiOperation = {
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  /** path + query parameters, path-item-level ones merged in. */
  parameters: Array<{ name: string; in: string; required?: boolean; schema?: SchemaNode }>;
  requestBody?: { content?: Record<string, { schema?: SchemaNode }> };
  responses?: Record<string, { content?: Record<string, { schema?: SchemaNode }> }>;
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const MAX_DEPTH = 6;

/** Every operation carrying an operationId, flattened across paths×methods.
 * Dispatch is by FLAT operationId: real-world specs (petstore, Stripe,
 * GitHub) keep operationIds unique and camelCased, so a nested
 * tag.operationId convention would only add ceremony. */
export function listOpenApiOperations(spec: Record<string, unknown>): OpenApiOperation[] {
  const paths = (spec.paths ?? {}) as Record<string, SchemaNode>;
  const operations: OpenApiOperation[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (pathItem == null || typeof pathItem !== "object") continue;
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as SchemaNode | undefined;
      if (typeof operation?.operationId !== "string") continue;
      const own = Array.isArray(operation.parameters) ? operation.parameters : [];
      operations.push({
        method,
        operationId: operation.operationId,
        parameters: [...shared, ...own] as OpenApiOperation["parameters"],
        path,
        requestBody: operation.requestBody as OpenApiOperation["requestBody"],
        responses: operation.responses as OpenApiOperation["responses"],
        summary: (operation.summary ?? operation.description) as string | undefined,
      });
    }
  }
  return operations;
}

/** The whole spec as one declaration string. Operations whose operationId is
 * not a plain identifier are skipped here (dot-paths could never reach them)
 * but stay visible through listOperations. */
export function deriveOpenApiTypes(spec: Record<string, unknown>): string {
  const declarations: string[] = [];
  for (const operation of listOpenApiOperations(spec)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(operation.operationId)) continue;
    if (operation.summary) {
      declarations.push(`/** ${operation.summary.replaceAll("*/", "*\\/")} */`);
    }
    declarations.push(
      `declare function ${operation.operationId}(` +
        `input: ${operationInputType(operation, spec)}` +
        `): Promise<${operationResponseType(operation, spec)}>;`,
    );
  }
  return declarations.join("\n");
}

/** One input object merging path params + query params + body properties —
 * mirroring exactly what OpenApiClient.call accepts as args[0]. */
function operationInputType(operation: OpenApiOperation, spec: Record<string, unknown>): string {
  const members: string[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    const required = parameter.in === "path" || parameter.required === true;
    const type = schemaToTs(parameter.schema, spec, 1);
    members.push(`${propertyKey(parameter.name)}${required ? "" : "?"}: ${type}`);
  }
  const bodySchema = operationBodySchema(operation, spec);
  if (bodySchema) {
    if (isObjectSchema(bodySchema)) {
      const required = new Set(Array.isArray(bodySchema.required) ? bodySchema.required : []);
      for (const [name, propSchema] of Object.entries(
        (bodySchema.properties ?? {}) as Record<string, SchemaNode>,
      )) {
        members.push(
          `${propertyKey(name)}${required.has(name) ? "" : "?"}: ${schemaToTs(propSchema, spec, 1)}`,
        );
      }
    } else {
      // Non-object bodies travel under the single `body` key (see
      // OpenApiClient's dispatch).
      members.push(`body: ${schemaToTs(bodySchema, spec, 1)}`);
    }
  }
  return members.length === 0 ? "Record<string, never>" : `{ ${members.join("; ")} }`;
}

function operationResponseType(operation: OpenApiOperation, spec: Record<string, unknown>): string {
  const responses = operation.responses ?? {};
  const success = responses["200"] ?? responses["201"] ?? responses["default"];
  const schema = jsonContentSchema(success);
  return schema ? schemaToTs(schema, spec, 0) : "unknown";
}

/** The operation's request-body schema, $ref-resolved — the client's dispatch
 * uses it to decide between the inline-properties and single-`body`-key
 * conventions (the same split operationInputType declares). */
export function operationBodySchema(
  operation: OpenApiOperation,
  spec: Record<string, unknown>,
): SchemaNode | undefined {
  return resolveRef(jsonContentSchema(operation.requestBody), spec);
}

function jsonContentSchema(
  carrier: { content?: Record<string, { schema?: SchemaNode }> } | undefined,
): SchemaNode | undefined {
  const content = carrier?.content ?? {};
  const media = content["application/json"] ?? Object.values(content)[0];
  return media?.schema;
}

/** JSON Schema → TS type string: depth-capped, $ref-resolving, unknown-on-doubt. */
function schemaToTs(
  schema: SchemaNode | undefined,
  spec: Record<string, unknown>,
  depth: number,
): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (depth > MAX_DEPTH) return "unknown";
  const resolved = resolveRef(schema, spec);
  if (!resolved) return "unknown";
  schema = resolved;

  const nullable = schema.nullable === true ? " | null" : "";
  const union = (variants: unknown): string | null =>
    Array.isArray(variants) && variants.length > 0
      ? variants.map((variant) => schemaToTs(variant as SchemaNode, spec, depth + 1)).join(" | ")
      : null;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value) ?? "unknown").join(" | ") + nullable;
  }
  const oneOf = union(schema.oneOf) ?? union(schema.anyOf);
  if (oneOf) return oneOf + nullable;
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return (
      schema.allOf.map((part) => schemaToTs(part as SchemaNode, spec, depth + 1)).join(" & ") +
      nullable
    );
  }

  const type = Array.isArray(schema.type)
    ? schema.type.map((entry) => scalarTs(String(entry))).join(" | ") // 3.1 type arrays
    : typeof schema.type === "string"
      ? schema.type
      : undefined;
  if (type === "array") {
    return `${schemaToTs(schema.items as SchemaNode, spec, depth + 1)}[]` + nullable;
  }
  if (type === "object" || (type === undefined && isObjectSchema(schema))) {
    const properties = (schema.properties ?? {}) as Record<string, SchemaNode>;
    if (Object.keys(properties).length === 0) return "Record<string, unknown>" + nullable;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const members = Object.entries(properties).map(
      ([name, propSchema]) =>
        `${propertyKey(name)}${required.has(name) ? "" : "?"}: ${schemaToTs(propSchema, spec, depth + 1)}`,
    );
    return `{ ${members.join("; ")} }` + nullable;
  }
  if (type !== undefined) return scalarTs(type) + nullable;
  return "unknown";
}

function scalarTs(type: string): string {
  if (type === "integer" || type === "number") return "number";
  if (type === "string" || type === "boolean") return type;
  if (type === "null") return "null";
  return "unknown";
}

/** Internal #/… pointer resolution (components.schemas and friends). Returns
 * the input untouched when it carries no $ref; null when the ref dangles. */
function resolveRef(
  schema: SchemaNode | undefined,
  spec: Record<string, unknown>,
): SchemaNode | undefined {
  if (!schema || typeof schema.$ref !== "string") return schema;
  if (!schema.$ref.startsWith("#/")) return undefined;
  let current: unknown = spec;
  for (const segment of schema.$ref.slice(2).split("/")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[
      segment.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
  }
  return current && typeof current === "object" ? (current as SchemaNode) : undefined;
}

export function isObjectSchema(schema: SchemaNode | undefined): schema is SchemaNode {
  return (
    schema != null &&
    typeof schema === "object" &&
    (schema.type === "object" || (schema.type === undefined && schema.properties != null))
  );
}

function propertyKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}
