import { resolveJsonSchema, type JsonSchema } from "./json-schema-types.ts";

type SchemaNode = Record<string, unknown>;

// OpenAPI support is deliberately small: operationId is the RPC method name,
// args[0] is one object, and this file turns enough of the spec into a dispatch
// table for openapi-rpc-target.
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

export function operationBodySchema(
  operation: OpenApiOperation,
  spec: Record<string, unknown>,
): JsonSchema | undefined {
  return resolveJsonSchema(jsonContentSchema(operation.requestBody), spec);
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
