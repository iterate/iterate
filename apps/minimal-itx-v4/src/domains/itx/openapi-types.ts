import {
  escapeJsDoc,
  jsonSchemaToTypeString,
  propertyKey,
  resolveJsonSchema,
  type JsonSchema,
} from "./json-schema-types.ts";

type SchemaNode = Record<string, unknown>;

// OpenAPI support is deliberately small: operationId is the RPC method name,
// args[0] is one object, and this file turns enough of the spec into a
// `types` string for project.describe() and capability.__describe().
export type OpenApiOperation = {
  method: string;
  operationId: string;
  parameters: Array<{ name: string; in: string; required?: boolean; schema?: JsonSchema }>;
  path: string;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
  summary?: string;
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

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

// The returned string is valid standalone TypeScript source. Later we can stitch
// many capabilities together by extracting each `Capability` alias and nesting
// it under its mounted path.
export function deriveOpenApiCapabilityTypes(spec: Record<string, unknown>): string {
  const members = [
    "  __describe(): Promise<{ instructions: string; types: string }>;",
    ...listOpenApiOperations(spec).flatMap((operation) => {
      if (!/^[A-Za-z_$][\w$]*$/.test(operation.operationId)) return [];
      return [
        ...(operation.summary ? [``, `  /** ${escapeJsDoc(operation.summary)} */`] : [""]),
        `  ${operation.operationId}(input: ${operationInputType(operation, spec)}): Promise<${operationResponseType(operation, spec)}>;`,
      ];
    }),
  ];
  return `export type Capability = {\n${members.join("\n")}\n};`;
}

export function operationBodySchema(
  operation: OpenApiOperation,
  spec: Record<string, unknown>,
): JsonSchema | undefined {
  return resolveJsonSchema(jsonContentSchema(operation.requestBody), spec);
}

function operationInputType(operation: OpenApiOperation, spec: Record<string, unknown>): string {
  const members: string[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    const required = parameter.in === "path" || parameter.required === true;
    members.push(
      `${propertyKey(parameter.name)}${required ? "" : "?"}: ${jsonSchemaToTypeString(parameter.schema, spec)}`,
    );
  }

  const bodySchema = operationBodySchema(operation, spec);
  if (bodySchema) {
    if (isObjectSchema(bodySchema)) {
      const required = new Set(Array.isArray(bodySchema.required) ? bodySchema.required : []);
      for (const [name, propSchema] of Object.entries(
        (bodySchema.properties ?? {}) as Record<string, SchemaNode>,
      )) {
        members.push(
          `${propertyKey(name)}${required.has(name) ? "" : "?"}: ${jsonSchemaToTypeString(propSchema, spec)}`,
        );
      }
    } else {
      // One RPC parameter still works for non-object bodies: callers pass
      // `{ body }`, and openapi-rpc-target unwraps it before fetch().
      members.push(`body: ${jsonSchemaToTypeString(bodySchema, spec)}`);
    }
  }

  return members.length === 0 ? "Record<string, never>" : `{ ${members.join("; ")} }`;
}

function operationResponseType(operation: OpenApiOperation, spec: Record<string, unknown>): string {
  const responses = operation.responses ?? {};
  const success = responses["200"] ?? responses["201"] ?? responses["default"];
  const schema = jsonContentSchema(success);
  return schema ? jsonSchemaToTypeString(schema, spec) : "unknown";
}

function jsonContentSchema(
  carrier: { content?: Record<string, { schema?: JsonSchema }> } | undefined,
): JsonSchema | undefined {
  const content = carrier?.content ?? {};
  const media = content["application/json"] ?? Object.values(content)[0];
  return media?.schema;
}

export function isObjectSchema(schema: JsonSchema | undefined): schema is SchemaNode {
  return (
    schema != null &&
    typeof schema === "object" &&
    (schema.type === "object" || (schema.type === undefined && schema.properties != null))
  );
}
