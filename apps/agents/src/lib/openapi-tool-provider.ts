import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptors,
  type ToolProvider,
} from "@cloudflare/codemode";
import { uniqueSanitizedToolKey } from "~/lib/codemode-tool-key.ts";

type OpenApiMethod = "get" | "post" | "put" | "patch" | "delete";
type OpenApiRequestMethod = Uppercase<OpenApiMethod>;
type JsonSchemaLike = Record<string, unknown>;
type FetchLike = typeof fetch;

const OPENAPI_METHODS: OpenApiMethod[] = ["get", "post", "put", "patch", "delete"];

interface OpenApiParameter {
  name?: string;
  in?: "query" | "header" | "path" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchemaLike;
}

interface OpenApiMediaType {
  schema?: JsonSchemaLike;
}

interface OpenApiRequestBody {
  required?: boolean;
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
}

interface OpenApiPathItem {
  parameters?: OpenApiParameter[];
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
}

interface OpenApiSpec {
  paths?: Record<string, OpenApiPathItem>;
}

export interface CreateOpenApiToolProviderOptions {
  name: string;
  spec: string | Record<string, unknown>;
  baseUrl: string;
  fetch?: FetchLike;
}

export async function createOpenApiToolProvider(
  options: CreateOpenApiToolProviderOptions,
): Promise<ToolProvider> {
  const rawSpec = await loadOpenApiSpec(options.spec);
  const spec = resolveRefs(rawSpec, rawSpec) as OpenApiSpec;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const tools: Record<
    string,
    { description?: string; execute: (input: unknown) => Promise<unknown> }
  > = {};
  const descriptors: JsonSchemaToolDescriptors = {};
  const usedToolKeys = new Set<string>();

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of OPENAPI_METHODS) {
      const operation = pathItem[method];
      if (!operation?.operationId) continue;

      const toolName = uniqueSanitizedToolKey(operation.operationId, usedToolKeys);
      const parameters = mergeParameters(pathItem.parameters, operation.parameters);
      const { schema: requestBodySchema, contentType } = pickRequestBody(operation);

      tools[toolName] = {
        description: describeOperation(method, path, operation),
        execute: async (input) => {
          if (typeof input !== "object" || input == null || Array.isArray(input)) {
            throw new Error("OpenAPI tools expect an object input.");
          }

          const args = { ...(input as Record<string, unknown>) };
          let resolvedPath = path;

          for (const parameter of parameters) {
            if (parameter.in !== "path" || !parameter.name) continue;

            const value = args[parameter.name];
            if (value == null) {
              if (parameter.required) {
                throw new Error(`Missing required path parameter "${parameter.name}".`);
              }
              continue;
            }

            resolvedPath = resolvedPath.replaceAll(
              `{${parameter.name}}`,
              encodeURIComponent(String(value)),
            );
            delete args[parameter.name];
          }

          const query: Record<string, string | number | boolean | undefined> = {};
          for (const parameter of parameters) {
            if (parameter.in !== "query" || !parameter.name) continue;

            const value = args[parameter.name];
            if (
              value == null ||
              (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
            ) {
              delete args[parameter.name];
              continue;
            }

            query[parameter.name] = value;
            delete args[parameter.name];
          }

          let body: unknown = undefined;
          if (requestBodySchema) {
            if ("body" in args) {
              body = args.body;
              delete args.body;
            } else if (Object.keys(args).length > 0) {
              body = args;
            }
          }

          const url = new URL(resolvedPath.replace(/^\/+/, ""), options.baseUrl);
          for (const [key, value] of Object.entries(query)) {
            if (value != null) {
              url.searchParams.set(key, String(value));
            }
          }

          const response = await fetchFn(url, {
            method: method.toUpperCase() as OpenApiRequestMethod,
            headers: contentType ? { "content-type": contentType } : undefined,
            body: body == null ? undefined : JSON.stringify(body),
          });

          if (!response.ok) {
            throw new Error(`OpenAPI request failed: ${response.status} ${url}`);
          }

          const responseContentType = response.headers.get("content-type") ?? "";
          return responseContentType.includes("application/json")
            ? await response.json()
            : await response.text();
        },
      };

      descriptors[toolName] = {
        description: describeOperation(method, path, operation),
        inputSchema: buildInputSchema(parameters, requestBodySchema, operation.requestBody),
        outputSchema: pickResponseSchema(operation),
      };
    }
  }

  return {
    name: options.name,
    tools,
    types: withNamespace(generateTypesFromJsonSchema(descriptors), options.name),
  };
}

async function loadOpenApiSpec(spec: string | Record<string, unknown>) {
  if (typeof spec !== "string") {
    return spec;
  }

  const response = await fetch(spec);
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI spec: ${response.status} ${spec}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

function withNamespace(types: string, namespace: string) {
  return types.replace(/declare const codemode:/, `declare const ${namespace}:`);
}

function describeOperation(method: OpenApiMethod, path: string, operation: OpenApiOperation) {
  const summary = operation.summary?.trim();
  const description = operation.description?.trim();
  const heading = `${method.toUpperCase()} ${path}`;

  if (summary && description) {
    return `${heading} - ${summary}. ${description}`;
  }

  if (summary) {
    return `${heading} - ${summary}`;
  }

  if (description) {
    return `${heading} - ${description}`;
  }

  return heading;
}

function buildInputSchema(
  parameters: OpenApiParameter[],
  requestBodySchema: JsonSchemaLike | undefined,
  requestBody: OpenApiRequestBody | undefined,
): JsonSchemaLike {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();

  for (const parameter of parameters) {
    if (!parameter.name) continue;
    if (parameter.in !== "path" && parameter.in !== "query") continue;

    properties[parameter.name] = {
      ...(parameter.schema ?? {}),
      ...(parameter.description ? { description: parameter.description } : {}),
    };

    if (parameter.required) {
      required.add(parameter.name);
    }
  }

  if (requestBodySchema) {
    properties.body = {
      ...requestBodySchema,
      ...(requestBody?.description ? { description: requestBody.description } : {}),
    };

    if (requestBody?.required) {
      required.add("body");
    }
  }

  return {
    type: "object",
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
  };
}

function pickRequestBody(operation: OpenApiOperation) {
  const content = Object.entries(operation.requestBody?.content ?? {});
  if (content.length === 0) {
    return { schema: undefined, contentType: undefined };
  }

  const preferred =
    content.find(([contentType]) => contentType === "application/json") ?? content[0];

  return {
    schema: preferred[1].schema,
    contentType: preferred[0],
  };
}

function pickResponseSchema(operation: OpenApiOperation) {
  const preferredStatuses = ["200", "201", "202", "default"];

  for (const status of preferredStatuses) {
    const response = operation.responses?.[status];
    const schema = pickResponseContentSchema(response);
    if (schema) {
      return schema;
    }
  }

  for (const response of Object.values(operation.responses ?? {})) {
    const schema = pickResponseContentSchema(response);
    if (schema) {
      return schema;
    }
  }

  return undefined;
}

function pickResponseContentSchema(response: OpenApiResponse | undefined) {
  if (!response) return undefined;

  const content = Object.entries(response.content ?? {});
  if (content.length === 0) return undefined;

  const preferred =
    content.find(([contentType]) => contentType === "application/json") ?? content[0];

  return preferred[1].schema;
}

function mergeParameters(
  pathParameters: OpenApiParameter[] | undefined,
  operationParameters: OpenApiParameter[] | undefined,
) {
  const merged = new Map<string, OpenApiParameter>();

  for (const parameter of pathParameters ?? []) {
    merged.set(parameterKey(parameter), parameter);
  }

  for (const parameter of operationParameters ?? []) {
    merged.set(parameterKey(parameter), parameter);
  }

  return [...merged.values()];
}

function parameterKey(parameter: OpenApiParameter) {
  return `${parameter.in ?? "unknown"}:${parameter.name ?? ""}`;
}

function resolveRefs(
  value: unknown,
  root: Record<string, unknown>,
  seen = new Set<string>(),
): unknown {
  if (value == null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveRefs(item, root, seen));
  }

  const record = value as Record<string, unknown>;

  if (typeof record.$ref === "string") {
    const ref = record.$ref;
    if (seen.has(ref)) {
      return { $circular: ref };
    }

    if (!ref.startsWith("#/")) {
      return record;
    }

    seen.add(ref);
    let resolved: unknown = root;
    for (const segment of ref
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      resolved = (resolved as Record<string, unknown>)?.[segment];
    }

    const resolvedValue = resolveRefs(resolved, root, seen);
    seen.delete(ref);
    return resolvedValue;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(record)) {
    result[key] = resolveRefs(nestedValue, root, seen);
  }
  return result;
}
