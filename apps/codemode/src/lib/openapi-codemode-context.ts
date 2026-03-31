import type { CodemodeOpenApiSource as PublicCodemodeOpenApiSource } from "@iterate-com/codemode-contract";
import {
  generateTypesFromJsonSchema,
  jsonSchemaToType,
  sanitizeToolName,
  type JsonSchema,
  type JsonSchemaToolDescriptors,
} from "~/lib/codemode/json-schema-types.ts";
import type { DerivedContractContext, DerivedProvider } from "~/lib/derive-contract-context.ts";

interface OpenApiServer {
  url?: string;
}

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: JsonSchema;
}

interface OpenApiMediaType {
  schema?: JsonSchema;
}

interface OpenApiRequestBody {
  required?: boolean;
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

interface OpenApiDocument {
  info?: {
    title?: string;
  };
  servers?: OpenApiServer[];
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

interface NormalizedOperationInput {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
}

interface OpenApiInputPlan {
  schema: JsonSchema;
  normalize: (input: unknown) => NormalizedOperationInput;
}

export type CodemodeOpenApiSource = PublicCodemodeOpenApiSource & {
  operationAliases?: Record<string, string>;
};

export type CodemodeOpenApiFetch = (
  input: URL | string | Request,
  init?: RequestInit,
) => Promise<Response>;

type ProcedureKind = "value" | "stream";

type OpenApiProcedure = {
  rpcToolName: string;
  runtimePath: string[];
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  kind: ProcedureKind;
  invoke: (input: unknown) => Promise<unknown>;
};

type ProcedureTreeNode = {
  children: Map<string, ProcedureTreeNode>;
  rpcToolName?: string;
};

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "options", "head"] as const;

function createTreeNode(): ProcedureTreeNode {
  return {
    children: new Map(),
  };
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function trimLeadingSlash(value: string) {
  return value.replace(/^\/+/, "");
}

/**
 * Adapted from @cloudflare/codemode's OpenAPI MCP helper so large public specs
 * with internal $refs can be traversed without exploding the runtime.
 */
function resolveRefs(value: unknown, root: unknown, seen = new Set<string>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

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
    const parts = ref
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let resolved = root;

    for (const part of parts) {
      resolved =
        typeof resolved === "object" && resolved !== null
          ? (resolved as Record<string, unknown>)[part]
          : undefined;
    }

    const result = resolveRefs(resolved, root, seen);
    seen.delete(ref);
    return result;
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, resolveRefs(entry, root, seen)]),
  );
}

function toPascalCase(value: string) {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function deriveNamespace(document: OpenApiDocument, sourceUrl: string) {
  const title = document.info?.title?.trim();
  if (title) {
    return sanitizeToolName(
      title
        .toLowerCase()
        .replace(/\b(api|openapi|app)\b/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\s+/g, "_"),
    );
  }

  return sanitizeToolName(new URL(sourceUrl).hostname.split(".")[0] ?? "openapi");
}

function resolveServerBaseUrl(
  document: OpenApiDocument,
  sourceUrl: string,
  overrideBaseUrl?: string,
) {
  const serverUrl = document.servers?.[0]?.url;

  if (overrideBaseUrl) {
    if (!serverUrl) {
      return trimTrailingSlash(overrideBaseUrl);
    }

    return trimTrailingSlash(new URL(serverUrl, overrideBaseUrl).toString());
  }

  if (!serverUrl) {
    return new URL(sourceUrl).origin;
  }

  return new URL(serverUrl, sourceUrl).toString();
}

function parseOpenApiJsonSchema(value: unknown): JsonSchema {
  if (typeof value === "boolean") return value;
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  return {};
}

function buildParameterGroupSchema(parameters: OpenApiParameter[]) {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const parameter of parameters) {
    if (!parameter.name) continue;
    properties[parameter.name] = parseOpenApiJsonSchema(parameter.schema);
    if (parameter.required) {
      required.push(parameter.name);
    }
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } satisfies JsonSchema;
}

function pickRequestBodySchema(requestBody: OpenApiRequestBody | undefined) {
  if (!requestBody?.content) {
    return undefined;
  }

  const jsonEntry =
    requestBody.content["application/json"] ??
    Object.entries(requestBody.content).find(([contentType]) =>
      contentType.includes("json"),
    )?.[1] ??
    Object.values(requestBody.content)[0];

  return jsonEntry?.schema ? parseOpenApiJsonSchema(jsonEntry.schema) : {};
}

function isObjectSchema(schema: JsonSchema | undefined): schema is Exclude<JsonSchema, boolean> & {
  type?: string;
  properties?: Record<string, JsonSchema>;
} {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema);
}

function isBodyPropertySchema(schema: JsonSchema | undefined): schema is Exclude<
  JsonSchema,
  boolean
> & {
  type: "object";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema;
} {
  return isObjectSchema(schema) && (schema.type === "object" || schema.properties !== undefined);
}

function pickResponseContent(response: OpenApiResponse | undefined) {
  if (!response?.content) {
    return undefined;
  }

  return (
    response.content["application/json"] ??
    response.content["text/event-stream"] ??
    response.content["text/plain"] ??
    Object.values(response.content)[0]
  );
}

function pickSuccessResponse(operation: OpenApiOperation) {
  const responses = operation.responses ?? {};
  const successKey =
    Object.keys(responses).find((key) => /^2\d\d$/.test(key)) ??
    (responses.default ? "default" : undefined);

  return successKey ? responses[successKey] : undefined;
}

function inferProcedureKind(
  operation: OpenApiOperation,
  response: OpenApiResponse | undefined,
): ProcedureKind {
  if (response?.content?.["text/event-stream"]) {
    return "stream";
  }

  return "value";
}

function inferStreamYieldSchema(response: OpenApiResponse | undefined): JsonSchema | undefined {
  const schema = response?.content?.["text/event-stream"]?.schema;
  const parsed = parseOpenApiJsonSchema(schema);

  if (typeof parsed === "boolean") {
    return parsed;
  }

  const variants = Array.isArray(parsed.oneOf) ? parsed.oneOf : [];

  for (const variant of variants) {
    const objectVariant = parseOpenApiJsonSchema(variant);
    if (typeof objectVariant === "boolean") continue;
    const properties = objectVariant.properties;
    if (typeof properties !== "object" || properties === null) continue;
    const eventSchema = (properties as Record<string, unknown>).event;
    const dataSchema = (properties as Record<string, unknown>).data;
    const eventConst =
      typeof eventSchema === "object" &&
      eventSchema !== null &&
      "const" in eventSchema &&
      typeof (eventSchema as Record<string, unknown>).const === "string"
        ? (eventSchema as Record<string, unknown>).const
        : undefined;

    if (eventConst === "message" && dataSchema) {
      return parseOpenApiJsonSchema(dataSchema);
    }
  }

  return { type: "string" };
}

function inferOutputSchema(operation: OpenApiOperation, response: OpenApiResponse | undefined) {
  if (!response) {
    return undefined;
  }

  if (response.content?.["text/event-stream"]) {
    return inferStreamYieldSchema(response);
  }

  const content = pickResponseContent(response);
  if (!content?.schema) {
    return undefined;
  }

  return parseOpenApiJsonSchema(content.schema);
}

function parseOperationInputSchema(operation: OpenApiOperation) {
  const pathParameters = (operation.parameters ?? []).filter(
    (parameter) => parameter.in === "path",
  );
  const queryParameters = (operation.parameters ?? []).filter(
    (parameter) => parameter.in === "query",
  );
  const headerParameters = (operation.parameters ?? []).filter(
    (parameter) => parameter.in === "header",
  );
  const bodySchema = pickRequestBodySchema(operation.requestBody);
  const pathNames = new Set(
    pathParameters.flatMap((parameter) => (parameter.name ? [parameter.name] : [])),
  );
  const queryNames = new Set(
    queryParameters.flatMap((parameter) => (parameter.name ? [parameter.name] : [])),
  );
  const headerNames = new Set(
    headerParameters.flatMap((parameter) => (parameter.name ? [parameter.name] : [])),
  );
  const bodyPropertyNames = new Set(
    isBodyPropertySchema(bodySchema) ? Object.keys(bodySchema.properties ?? {}) : [],
  );

  const groupInput = (): OpenApiInputPlan => {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    if (pathParameters.length > 0) {
      properties.path = buildParameterGroupSchema(pathParameters);
      required.push("path");
    }

    if (queryParameters.length > 0) {
      properties.query = buildParameterGroupSchema(queryParameters);
    }

    if (headerParameters.length > 0) {
      properties.headers = buildParameterGroupSchema(headerParameters);
    }

    if (bodySchema) {
      properties.body = bodySchema;
      if (operation.requestBody?.required) {
        required.push("body");
      }
    }

    return {
      schema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      } satisfies JsonSchema,
      normalize: (input: unknown): NormalizedOperationInput => {
        const normalizedInput = normalizeInputObject(input);
        const grouped: NormalizedOperationInput = {};

        if (pathParameters.length > 0) {
          grouped.path = normalizeInputObject(normalizedInput.path);
        }

        if (queryParameters.length > 0) {
          grouped.query = normalizeInputObject(normalizedInput.query);
        }

        if (headerParameters.length > 0) {
          grouped.headers = normalizeInputObject(normalizedInput.headers);
        }

        if (bodySchema && Object.prototype.hasOwnProperty.call(normalizedInput, "body")) {
          grouped.body = normalizedInput.body;
        }

        return grouped;
      },
    };
  };

  const hasConflictingNames = [...pathNames, ...queryNames].some((name) =>
    bodyPropertyNames.has(name),
  );
  const canFlattenIntoObject =
    headerParameters.length === 0 &&
    (!bodySchema || isBodyPropertySchema(bodySchema)) &&
    !hasConflictingNames;

  if (canFlattenIntoObject) {
    const properties: Record<string, JsonSchema> = {};
    const required = new Set<string>();

    for (const parameter of [...pathParameters, ...queryParameters]) {
      if (!parameter.name) continue;
      properties[parameter.name] = parseOpenApiJsonSchema(parameter.schema);
      if (parameter.required) {
        required.add(parameter.name);
      }
    }

    const bodyProperties = isBodyPropertySchema(bodySchema) ? (bodySchema.properties ?? {}) : {};
    for (const [name, schema] of Object.entries(bodyProperties)) {
      properties[name] = schema;
    }

    for (const name of isBodyPropertySchema(bodySchema) ? (bodySchema.required ?? []) : []) {
      required.add(name);
    }

    return {
      schema: {
        type: "object",
        properties,
        required: [...required],
        additionalProperties:
          isBodyPropertySchema(bodySchema) && bodySchema.additionalProperties !== undefined
            ? bodySchema.additionalProperties
            : false,
      } satisfies JsonSchema,
      normalize: (input: unknown): NormalizedOperationInput => {
        const normalizedInput = normalizeInputObject(input);
        const path: Record<string, unknown> = {};
        const query: Record<string, unknown> = {};
        const bodyEntries: [string, unknown][] = [];

        for (const [key, value] of Object.entries(normalizedInput)) {
          if (pathNames.has(key)) {
            path[key] = value;
            continue;
          }

          if (queryNames.has(key)) {
            query[key] = value;
            continue;
          }

          bodyEntries.push([key, value]);
        }

        const grouped: NormalizedOperationInput = {};

        if (pathParameters.length > 0) {
          grouped.path = path;
        }

        if (queryParameters.length > 0) {
          grouped.query = query;
        }

        if (bodySchema) {
          if (bodyEntries.length > 0 || operation.requestBody?.required) {
            grouped.body = Object.fromEntries(bodyEntries);
          }
        }

        return grouped;
      },
    };
  }

  if (
    headerParameters.length === 0 &&
    pathParameters.length === 0 &&
    queryParameters.length === 0 &&
    bodySchema
  ) {
    return {
      schema: bodySchema,
      normalize: (input: unknown): NormalizedOperationInput => ({
        body: input,
      }),
    };
  }

  if (headerParameters.length === 0 && !bodySchema) {
    const properties: Record<string, JsonSchema> = {};
    const required = new Set<string>();

    for (const parameter of [...pathParameters, ...queryParameters]) {
      if (!parameter.name) continue;
      properties[parameter.name] = parseOpenApiJsonSchema(parameter.schema);
      if (parameter.required) {
        required.add(parameter.name);
      }
    }

    return {
      schema: {
        type: "object",
        properties,
        required: [...required],
        additionalProperties: false,
      } satisfies JsonSchema,
      normalize: (input: unknown): NormalizedOperationInput => {
        const normalizedInput = normalizeInputObject(input);
        const grouped: NormalizedOperationInput = {};

        if (pathParameters.length > 0) {
          grouped.path = Object.fromEntries(
            Object.entries(normalizedInput).filter(([key]) => pathNames.has(key)),
          );
        }

        if (queryParameters.length > 0) {
          grouped.query = Object.fromEntries(
            Object.entries(normalizedInput).filter(([key]) => queryNames.has(key)),
          );
        }

        return grouped;
      },
    };
  }

  return groupInput();
}

function normalizeInputObject(input: unknown) {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function encodePathParameter(value: unknown) {
  return encodeURIComponent(typeof value === "string" ? value : String(value));
}

function appendQueryParams(url: URL, query: unknown) {
  if (typeof query !== "object" || query === null) {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          url.searchParams.append(key, String(item));
        }
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }
}

function isJsonLikeContentType(contentType: string) {
  const normalized = contentType.toLowerCase();
  return normalized.includes("application/json") || normalized.includes("+json");
}

function parseSseValue(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

async function* parseSseStream(response: Response): AsyncIterable<unknown> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const lines = chunk.split(/\r?\n/);
        let event = "message";
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
            continue;
          }

          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        const payload = parseSseValue(dataLines.join("\n"));

        if (dataLines.length === 0 && event === "message") {
          continue;
        }

        if (event === "done") {
          return;
        }

        if (event === "error") {
          throw new Error(typeof payload === "string" ? payload : JSON.stringify(payload));
        }

        yield payload;
      }

      if (done) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function buildRuntimePath(
  namespace: string,
  operationId: string,
  operationAliases?: Record<string, string>,
) {
  const alias = operationAliases?.[operationId];
  const rawPath = alias ?? operationId;
  return [namespace, ...rawPath.split(".").map((segment) => sanitizeToolName(segment))];
}

function buildRpcToolName(runtimePath: string[]) {
  return runtimePath.map((segment) => sanitizeToolName(segment)).join("__");
}

async function buildProcedureFromOperation(options: {
  namespace: string;
  sourceUrl: string;
  document: OpenApiDocument;
  path: string;
  method: (typeof HTTP_METHODS)[number];
  operation: OpenApiOperation;
  headers?: Record<string, string>;
  operationAliases?: Record<string, string>;
  baseUrl?: string;
  fetch?: CodemodeOpenApiFetch;
}): Promise<OpenApiProcedure | null> {
  const operationId =
    options.operation.operationId ??
    `${options.method}.${trimLeadingSlash(options.path).replace(/[{}]/g, "").replace(/\//g, ".")}`;
  const runtimePath = buildRuntimePath(options.namespace, operationId, options.operationAliases);
  const rpcToolName = buildRpcToolName(runtimePath);
  const response = pickSuccessResponse(options.operation);
  const description =
    options.operation.description ??
    options.operation.summary ??
    `${options.method.toUpperCase()} ${options.path}`;
  const inputPlan = parseOperationInputSchema(options.operation);
  const outputSchema = inferOutputSchema(options.operation, response);
  const kind = inferProcedureKind(options.operation, response);
  const baseUrl = resolveServerBaseUrl(options.document, options.sourceUrl, options.baseUrl);
  const defaultInvoke = async (input: unknown) => {
    const normalizedInput = inputPlan.normalize(input);
    const url = new URL(trimLeadingSlash(options.path), `${trimTrailingSlash(baseUrl)}/`);

    for (const [key, value] of Object.entries(normalizeInputObject(normalizedInput.path))) {
      url.pathname = url.pathname.replaceAll(`{${key}}`, encodePathParameter(value));
    }

    appendQueryParams(url, normalizedInput.query);

    const requestHeaders = new Headers(options.headers);
    for (const [key, value] of Object.entries(normalizeInputObject(normalizedInput.headers))) {
      if (typeof value === "string") {
        requestHeaders.set(key, value);
      }
    }

    const hasBody = Object.prototype.hasOwnProperty.call(normalizedInput, "body");
    const requestInit: RequestInit = {
      method: options.method.toUpperCase(),
      headers: requestHeaders,
    };

    if (hasBody) {
      requestHeaders.set("content-type", "application/json");
      requestInit.body = JSON.stringify(normalizedInput.body);
    }

    if (kind === "stream") {
      requestHeaders.set("accept", "text/event-stream");
    }

    const response = await (options.fetch ?? fetch)(url, requestInit);
    if (!response.ok) {
      throw new Error(`${options.method.toUpperCase()} ${url} failed with ${response.status}`);
    }

    if (kind === "stream") {
      return parseSseStream(response);
    }

    if (response.status === 204) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (isJsonLikeContentType(contentType)) {
      return response.json();
    }

    return response.text();
  };

  return {
    rpcToolName,
    runtimePath,
    description,
    inputSchema: inputPlan.schema,
    outputSchema,
    kind,
    invoke: defaultInvoke,
  };
}

function buildProcedureTree(procedures: OpenApiProcedure[]) {
  const root = createTreeNode();

  for (const procedure of procedures) {
    let current = root;

    for (const segment of procedure.runtimePath) {
      let child = current.children.get(segment);
      if (!child) {
        child = createTreeNode();
        current.children.set(segment, child);
      }
      current = child;
    }

    current.rpcToolName = procedure.rpcToolName;
  }

  return root;
}

function findProcedure(procedures: OpenApiProcedure[], rpcToolName: string) {
  return procedures.find((procedure) => procedure.rpcToolName === rpcToolName);
}

function emitRuntimeTree(
  node: ProcedureTreeNode,
  procedures: OpenApiProcedure[],
  providerName: string,
): string {
  const entries: string[] = [];

  for (const [segment, child] of node.children) {
    if (child.rpcToolName) {
      const procedure = findProcedure(procedures, child.rpcToolName);
      const rootName = procedure?.kind === "stream" ? `${providerName}_stream` : providerName;
      entries.push(
        `${JSON.stringify(segment)}: (input) => ${rootName}.${child.rpcToolName}(input ?? {})`,
      );
      continue;
    }

    entries.push(`${JSON.stringify(segment)}: ${emitRuntimeTree(child, procedures, providerName)}`);
  }

  return `{ ${entries.join(", ")} }`;
}

function emitTypeTree(
  node: ProcedureTreeNode,
  procedures: OpenApiProcedure[],
  providerName: string,
): string {
  const lines: string[] = ["{"];

  for (const [segment, child] of node.children) {
    if (child.rpcToolName) {
      const procedure = findProcedure(procedures, child.rpcToolName);
      const rootName = procedure?.kind === "stream" ? `${providerName}_stream` : providerName;
      lines.push(`  ${JSON.stringify(segment)}: typeof ${rootName}.${child.rpcToolName};`);
      continue;
    }

    const nested = emitTypeTree(child, procedures, providerName)
      .split("\n")
      .map((line, index) => (index === 0 ? line : `  ${line}`))
      .join("\n");
    lines.push(`  ${JSON.stringify(segment)}: ${nested};`);
  }

  lines.push("}");
  return lines.join("\n");
}

function buildValueToolDescriptors(procedures: OpenApiProcedure[]): JsonSchemaToolDescriptors {
  return Object.fromEntries(
    procedures.map((procedure) => [
      procedure.rpcToolName,
      {
        description: procedure.description,
        inputSchema: procedure.inputSchema,
        ...(procedure.outputSchema ? { outputSchema: procedure.outputSchema } : {}),
      },
    ]),
  );
}

function estimateSchemaSize(schema: JsonSchema | undefined) {
  if (schema === undefined) {
    return 0;
  }

  try {
    return JSON.stringify(schema).length;
  } catch {
    return 0;
  }
}

function shouldCompactTypeDefinitions(procedures: OpenApiProcedure[]) {
  const totalSchemaSize = procedures.reduce(
    (sum, procedure) =>
      sum + estimateSchemaSize(procedure.inputSchema) + estimateSchemaSize(procedure.outputSchema),
    0,
  );

  return procedures.length > 24 || totalSchemaSize > 120_000;
}

function buildFallbackValueTypeDefinitions(procedures: OpenApiProcedure[], providerName: string) {
  if (procedures.length === 0) {
    return "";
  }

  const declarations: string[] = [];
  const providerLines: string[] = [`declare const ${providerName}: {`];

  for (const procedure of procedures) {
    const baseName = toPascalCase(procedure.rpcToolName);
    const inputTypeName = `${baseName}Input`;
    const outputTypeName = `${baseName}Output`;
    const compactInput = estimateSchemaSize(procedure.inputSchema) > 12_000;
    const compactOutput = estimateSchemaSize(procedure.outputSchema) > 12_000;

    try {
      declarations.push(
        compactInput
          ? `type ${inputTypeName} = unknown;`
          : jsonSchemaToType(procedure.inputSchema, inputTypeName),
      );
    } catch {
      declarations.push(`type ${inputTypeName} = unknown;`);
    }

    try {
      declarations.push(
        compactOutput || !procedure.outputSchema
          ? `type ${outputTypeName} = unknown;`
          : jsonSchemaToType(procedure.outputSchema, outputTypeName),
      );
    } catch {
      declarations.push(`type ${outputTypeName} = unknown;`);
    }

    providerLines.push(
      `  ${JSON.stringify(procedure.rpcToolName)}: (input: ${inputTypeName}) => Promise<${outputTypeName}>;`,
    );
  }

  providerLines.push("};");
  return [...declarations, "", ...providerLines].join("\n");
}

function buildStreamTypeDefinitions(procedures: OpenApiProcedure[], providerName: string) {
  if (procedures.length === 0) {
    return "";
  }

  const declarations: string[] = [];
  const providerLines: string[] = [`declare const ${providerName}: {`];

  for (const procedure of procedures) {
    const baseName = toPascalCase(procedure.rpcToolName);
    const inputTypeName = `${baseName}Input`;
    const yieldTypeName = `${baseName}Yield`;
    const compactInput = estimateSchemaSize(procedure.inputSchema) > 12_000;
    const compactYield = estimateSchemaSize(procedure.outputSchema) > 12_000;

    declarations.push(
      compactInput
        ? `type ${inputTypeName} = unknown;`
        : jsonSchemaToType(procedure.inputSchema, inputTypeName),
    );
    declarations.push(
      compactYield || !procedure.outputSchema
        ? `type ${yieldTypeName} = unknown;`
        : jsonSchemaToType(procedure.outputSchema, yieldTypeName),
    );
    providerLines.push(
      `  ${JSON.stringify(procedure.rpcToolName)}: (input: ${inputTypeName}) => Promise<AsyncIterable<${yieldTypeName}>>;`,
    );
  }

  providerLines.push("};");
  return [...declarations, "", ...providerLines].join("\n");
}

function buildTypeDeclarations(options: { procedures: OpenApiProcedure[]; providerName: string }) {
  const valueProcedures = options.procedures.filter((procedure) => procedure.kind === "value");
  const streamProcedures = options.procedures.filter((procedure) => procedure.kind === "stream");
  const useCompactMode = shouldCompactTypeDefinitions(options.procedures);

  return [
    "// Generated from OpenAPI sources",
    ...(valueProcedures.length > 0
      ? (() => {
          if (useCompactMode) {
            return [buildFallbackValueTypeDefinitions(valueProcedures, options.providerName)];
          }

          try {
            return [
              generateTypesFromJsonSchema(buildValueToolDescriptors(valueProcedures)).replace(
                "declare const codemode:",
                `declare const ${options.providerName}:`,
              ),
            ];
          } catch {
            return [buildFallbackValueTypeDefinitions(valueProcedures, options.providerName)];
          }
        })()
      : []),
    ...(streamProcedures.length > 0
      ? ["", buildStreamTypeDefinitions(streamProcedures, `${options.providerName}_stream`)]
      : []),
  ];
}

async function loadOpenApiDocument(
  source: CodemodeOpenApiSource,
  options?: { fetch?: CodemodeOpenApiFetch },
) {
  const response = await (options?.fetch ?? fetch)(source.url, {
    headers: source.headers,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI document ${source.url}: ${response.status}`);
  }

  const json = (await response.json()) as OpenApiDocument;
  const resolved = resolveRefs(json, json) as OpenApiDocument;
  return {
    document: resolved,
    namespace: source.namespace ?? deriveNamespace(resolved, source.url),
  };
}

export async function buildOpenApiCodemodeContext(
  sources: CodemodeOpenApiSource[],
  options?: { providerName?: string; fetch?: CodemodeOpenApiFetch; includeTypes?: boolean },
) {
  const providerName = options?.providerName ?? "rpc";
  const procedures: OpenApiProcedure[] = [];

  for (const source of sources) {
    const loaded = await loadOpenApiDocument(source, {
      fetch: options?.fetch,
    });

    for (const [path, pathItem] of Object.entries(loaded.document.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        const operation = pathItem?.[method];
        if (!operation) continue;

        const procedure = await buildProcedureFromOperation({
          namespace: loaded.namespace,
          sourceUrl: source.url,
          document: loaded.document,
          path,
          method,
          operation,
          headers: source.headers,
          operationAliases: source.operationAliases,
          baseUrl: source.baseUrl,
          fetch: options?.fetch,
        });

        if (procedure) {
          procedures.push(procedure);
        }
      }
    }
  }

  const procedureTree = buildProcedureTree(procedures);
  const valueProcedures = procedures.filter((procedure) => procedure.kind === "value");
  const streamProcedures = procedures.filter((procedure) => procedure.kind === "stream");
  const providers: DerivedProvider[] = [];

  if (valueProcedures.length > 0) {
    providers.push({
      name: providerName,
      mode: "value",
      fns: Object.fromEntries(
        valueProcedures.map((procedure) => [procedure.rpcToolName, procedure.invoke]),
      ),
    });
  }

  if (streamProcedures.length > 0) {
    providers.push({
      name: `${providerName}_stream`,
      mode: "stream",
      fns: Object.fromEntries(
        streamProcedures.map((procedure) => [procedure.rpcToolName, procedure.invoke]),
      ),
    });
  }

  const declarations =
    options?.includeTypes === false
      ? []
      : buildTypeDeclarations({
          procedures,
          providerName,
        });

  const context: DerivedContractContext = {
    declarations,
    providers,
    ctxExpression: emitRuntimeTree(procedureTree, procedures, providerName),
    ctxTypeExpression:
      options?.includeTypes === false
        ? "{}"
        : emitTypeTree(procedureTree, procedures, providerName),
    sandboxPrelude: `const ctx = ${emitRuntimeTree(procedureTree, procedures, providerName)};`,
    ctxTypes:
      options?.includeTypes === false
        ? "declare const ctx: {};"
        : [
            ...declarations,
            "",
            `declare const ctx: ${emitTypeTree(procedureTree, procedures, providerName)};`,
            "",
          ].join("\n"),
  };

  return context;
}
