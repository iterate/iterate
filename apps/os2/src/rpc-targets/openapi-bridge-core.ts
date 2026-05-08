export interface OpenApiBridgeProps {
  specUrl: string;
  baseUrl: string;
  headers?: Record<string, string>;
}

export type OpenApiBridgeInput = {
  args: unknown[];
  functionPath: string[];
  providerProps?: OpenApiBridgeProps;
};

interface OpenApiOperation {
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: Record<string, unknown>;
    description?: string;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
}

export async function executeOpenApiToolFunction(input: OpenApiBridgeInput) {
  const providerProps = input.providerProps;
  if (!providerProps) throw new Error("OpenAPI provider props are required");

  const spec = await fetchOpenApiSpec(providerProps);
  const operationId = input.functionPath[0];
  if (!operationId)
    throw new Error(
      "executeCodemodeFunctionCall requires a path with at least one segment (operationId)",
    );
  if (operationId === "listOperations") {
    return listOpenApiOperations(spec).map((operation) => ({
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      summary: operation.summary ?? operation.description ?? null,
    }));
  }

  const operation = findOpenApiOperation(spec, operationId);
  if (!operation) throw new Error(`Operation "${operationId}" not found in spec`);
  const [payload] = input.args;

  const url = buildOpenApiRequestUrl(operation, payload as Record<string, unknown>, providerProps);
  const response = await fetch(url, {
    method: operation.method.toUpperCase(),
    headers:
      operation.method !== "get"
        ? { ...providerProps.headers, "content-type": "application/json" }
        : providerProps.headers,
    body: operation.method !== "get" && payload != null ? JSON.stringify(payload) : undefined,
  });

  if (!response.ok) {
    throw new Error(
      `${operation.method.toUpperCase()} ${url.pathname} returned ${response.status}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? response.json() : response.text();
}

async function fetchOpenApiSpec(providerProps: OpenApiBridgeProps) {
  const response = await fetch(providerProps.specUrl, { headers: providerProps.headers });
  if (!response.ok) throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function listOpenApiOperations(spec: Record<string, unknown>): OpenApiOperation[] {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  const operations: OpenApiOperation[] = [];

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = pathItem[method] as Record<string, unknown> | undefined;
      if (!op?.operationId) continue;
      operations.push({
        operationId: op.operationId as string,
        method,
        path: pathStr,
        summary: op.summary as string | undefined,
        description: op.description as string | undefined,
        parameters: op.parameters as OpenApiOperation["parameters"],
        requestBody: op.requestBody as OpenApiOperation["requestBody"],
      });
    }
  }

  return operations;
}

function findOpenApiOperation(spec: Record<string, unknown>, operationId: string) {
  return listOpenApiOperations(spec).find((op) => op.operationId === operationId);
}

function buildOpenApiRequestUrl(
  operation: OpenApiOperation,
  payload: Record<string, unknown> | null,
  providerProps: OpenApiBridgeProps,
) {
  const baseUrl = providerProps.baseUrl.replace(/\/+$/, "");
  let resolvedPath = operation.path;

  for (const param of operation.parameters ?? []) {
    if (param.in !== "path" || !payload) continue;
    const value = payload[param.name];
    if (value != null) {
      resolvedPath = resolvedPath.replaceAll(`{${param.name}}`, encodeURIComponent(String(value)));
    }
  }

  const url = new URL(`${baseUrl}${resolvedPath}`);

  for (const param of operation.parameters ?? []) {
    if (param.in !== "query" || !payload) continue;
    const value = payload[param.name];
    if (value != null) url.searchParams.set(param.name, String(value));
  }

  return url;
}
