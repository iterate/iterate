/**
 * OpenAPI bridge — a stateless WorkerEntrypoint that translates
 * ToolProvider.executeToolFunction(path, payload) into HTTP calls against an OpenAPI spec.
 *
 * Deployed as a named export from the os2 worker. Callables reach it via
 * loopback-binding with props containing the spec URL and base URL:
 *
 *   { type: "loopback-binding", bindingType: "service",
 *     exportName: "OpenApiBridge", props: { specUrl, baseUrl } }
 *
 * Use createOpenApiProvider() to construct the ToolProviderDescriptor.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";

interface OpenApiBridgeProps {
  specUrl: string;
  baseUrl: string;
}

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

export class OpenApiBridge extends WorkerEntrypoint<Record<string, unknown>, OpenApiBridgeProps> {
  /**
   * Execute a tool function call against the OpenAPI spec.
   *
   * path[0] is the operationId. payload is the request body or query params.
   */
  async executeToolFunction(input: { path: string[]; payload: unknown }) {
    const spec = await this.fetchSpec();
    const operationId = input.path[0];
    if (!operationId)
      throw new Error(
        "executeToolFunction requires a path with at least one segment (operationId)",
      );

    const operation = this.findOperation(spec, operationId);
    if (!operation) throw new Error(`Operation "${operationId}" not found in spec`);

    const url = this.buildUrl(operation, input.payload as Record<string, unknown>);
    const response = await fetch(url, {
      method: operation.method.toUpperCase(),
      headers: operation.method !== "get" ? { "content-type": "application/json" } : undefined,
      body:
        operation.method !== "get" && input.payload != null
          ? JSON.stringify(input.payload)
          : undefined,
    });

    if (!response.ok) {
      throw new Error(
        `${operation.method.toUpperCase()} ${url.pathname} returned ${response.status}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("json") ? response.json() : response.text();
  }

  /**
   * Describe the available operations as TypeScript declarations.
   */
  async describeToolFunctions() {
    const spec = await this.fetchSpec();
    const operations = this.listOperations(spec);

    if (operations.length === 0) {
      return { typeDefinitions: "/** No operations found in OpenAPI spec */" };
    }

    const lines = operations.map((op) => {
      const desc = op.summary || op.description || `${op.method.toUpperCase()} ${op.path}`;
      return `  /** ${desc} */\n  ${op.operationId}(input: Record<string, unknown>): Promise<unknown>;`;
    });

    return {
      typeDefinitions: `{\n${lines.join("\n")}\n}`,
    };
  }

  private async fetchSpec() {
    const response = await fetch(this.ctx.props.specUrl);
    if (!response.ok) throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  private listOperations(spec: Record<string, unknown>): OpenApiOperation[] {
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

  private findOperation(spec: Record<string, unknown>, operationId: string) {
    return this.listOperations(spec).find((op) => op.operationId === operationId);
  }

  private buildUrl(operation: OpenApiOperation, payload: Record<string, unknown> | null) {
    const baseUrl = this.ctx.props.baseUrl.replace(/\/+$/, "");
    let resolvedPath = operation.path;

    // Substitute path parameters
    for (const param of operation.parameters ?? []) {
      if (param.in !== "path" || !payload) continue;
      const value = payload[param.name];
      if (value != null) {
        resolvedPath = resolvedPath.replaceAll(
          `{${param.name}}`,
          encodeURIComponent(String(value)),
        );
      }
    }

    const url = new URL(`${baseUrl}${resolvedPath}`);

    // Add query parameters
    for (const param of operation.parameters ?? []) {
      if (param.in !== "query" || !payload) continue;
      const value = payload[param.name];
      if (value != null) url.searchParams.set(param.name, String(value));
    }

    return url;
  }
}

/**
 * Construct a ToolProviderDescriptor that routes through the OpenApiBridge
 * loopback entrypoint. The descriptor is pure JSON — it can be stored,
 * transmitted, or passed to the codemode execute endpoint.
 *
 *   createOpenApiProvider({
 *     path: ["petstore"],
 *     specUrl: "https://petstore.swagger.io/v2/swagger.json",
 *     baseUrl: "https://petstore.swagger.io/v2",
 *   })
 */
export function createOpenApiProvider(options: {
  path: string[];
  specUrl: string;
  baseUrl: string;
}): ToolProviderDescriptor {
  const via = {
    type: "loopback-binding" as const,
    bindingType: "service" as const,
    exportName: "OpenApiBridge",
    props: { specUrl: options.specUrl, baseUrl: options.baseUrl },
  };

  return {
    path: options.path,
    executeToolFunction: { type: "workers-rpc" as const, via, rpcMethod: "executeToolFunction" },
    describeToolFunctions: {
      type: "workers-rpc" as const,
      via,
      rpcMethod: "describeToolFunctions",
    },
  };
}
