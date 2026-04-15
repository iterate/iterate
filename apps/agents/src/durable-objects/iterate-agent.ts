import {
  DynamicWorkerExecutor,
  sanitizeToolName,
  type ResolvedProvider,
} from "@cloudflare/codemode";
import { Agent, type Connection, type WSMessage } from "agents";
import { z } from "zod";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

const EVENTS_ORIGIN = "https://events.iterate.com";
const EVENTS_API_BASE_URL = `${EVENTS_ORIGIN}/api`;
const EVENTS_OPENAPI_URL = `${EVENTS_API_BASE_URL}/openapi.json`;
const EVENTS_PROVIDER_NAME = "events";
const EVENTS_OPERATION_ALIASES: Record<string, string> = {
  appendStreamEvents: "append",
  streamEvents: "stream",
  getStreamState: "getState",
};

const AddMcpServerRequest = z.object({
  name: z.string().trim().min(1),
  url: z.string().trim().url(),
  callbackHost: z.string().trim().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const CodemodeBlockAddedMessage = z.object({
  type: z.literal("codemode-block-added"),
  payload: z.object({
    script: z.string(),
  }),
});

type OpenApiParameter = {
  name?: string;
  in?: string;
  required?: boolean;
};

type OpenApiOperation = {
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: unknown;
  responses?: Record<string, { content?: Record<string, unknown> }>;
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation | undefined> | undefined>;
};

type OperationSpec = {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathParamNames: string[];
  queryParamNames: string[];
  hasBody: boolean;
  isStream: boolean;
};

let eventsProviderPromise: Promise<ResolvedProvider> | undefined;

export class IterateAgent extends Agent<CloudflareEnv> {
  onStart() {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }

        const message = escapeHtml(result.authError ?? "OAuth failed").slice(0, 500);
        return new Response(`<pre>${message}</pre>`, {
          status: 400,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
  }

  async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") {
      return;
    }

    const parsedMessage = parseJson(message);
    const event = CodemodeBlockAddedMessage.safeParse(parsedMessage);
    if (!event.success) {
      return;
    }

    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER,
      globalOutbound: undefined,
    });
    const providers = [
      await getEventsProvider(),
      ...this.getMcpCodemodeProviders(new Set([EVENTS_PROVIDER_NAME])),
    ];
    const result = await executor.execute(event.data.payload.script, providers);

    connection.send(
      JSON.stringify({
        type: "codemode-result-added",
        payload: {
          result: result.result ?? null,
          error: result.error ?? null,
          logs: result.logs ?? [],
        },
      }),
    );
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return Response.json(this.getMcpServers());
    }

    if (request.method === "POST" && url.pathname.endsWith("/mcp/servers")) {
      const body = AddMcpServerRequest.parse(await request.json());
      const result = await this.addMcpServer(body.name, body.url, {
        callbackHost: body.callbackHost,
        transport: body.headers ? { headers: body.headers } : undefined,
      });
      return Response.json(result);
    }

    if (request.method === "DELETE" && url.pathname.includes("/mcp/servers/")) {
      const serverId = url.pathname.split("/").at(-1);
      if (!serverId) {
        return new Response("Not Found", { status: 404 });
      }

      await this.removeMcpServer(decodeURIComponent(serverId));
      return new Response(null, { status: 204 });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "GET, POST, DELETE",
      },
    });
  }

  private getMcpCodemodeProviders(usedProviderNames: Set<string>): ResolvedProvider[] {
    const mcp = this.getMcpServers();
    const toolsByServerId = new Map<string, typeof mcp.tools>();

    for (const tool of mcp.tools) {
      const serverTools = toolsByServerId.get(tool.serverId) ?? [];
      serverTools.push(tool);
      toolsByServerId.set(tool.serverId, serverTools);
    }

    return Array.from(toolsByServerId.entries()).flatMap(([serverId, tools]) => {
      const server = mcp.servers[serverId];
      if (!server || tools.length === 0) {
        return [];
      }

      const usedToolNames = new Set<string>();
      const fns = Object.fromEntries(
        tools.map((tool) => {
          const toolName = toUniqueIdentifier(tool.name, usedToolNames);
          return [
            toolName,
            async (args: unknown) =>
              this.mcp.callTool({
                serverId,
                name: tool.name,
                arguments: toToolArguments(args),
              }),
          ];
        }),
      );

      return [
        {
          name: toUniqueIdentifier(server.name, usedProviderNames, "mcp"),
          fns,
        },
      ];
    });
  }
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toToolArguments(args: unknown) {
  if (args == null) {
    return undefined;
  }

  if (isRecord(args)) {
    return args;
  }

  throw new Error("MCP tools expect a single object argument.");
}

function toUniqueIdentifier(value: string, used: Set<string>, fallback = "mcp") {
  const base = sanitizeToolName(value) || fallback;
  let candidate = base;
  let index = 2;

  while (used.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }

  used.add(candidate);
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function getEventsProvider() {
  eventsProviderPromise ??= buildOpenApiProvider({
    providerName: EVENTS_PROVIDER_NAME,
    specUrl: EVENTS_OPENAPI_URL,
    baseUrl: EVENTS_API_BASE_URL,
    operationAliases: EVENTS_OPERATION_ALIASES,
  });

  try {
    return await eventsProviderPromise;
  } catch (error) {
    eventsProviderPromise = undefined;
    throw error;
  }
}

async function buildOpenApiProvider(options: {
  providerName: string;
  specUrl: string;
  baseUrl: string;
  operationAliases?: Record<string, string>;
}): Promise<ResolvedProvider> {
  const response = await fetch(options.specUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`);
  }

  const document = (await response.json()) as OpenApiDocument;
  const operations = collectOperations(document, options.operationAliases);
  const fns = Object.fromEntries(
    operations.map(([name, operation]) => [
      name,
      async (args: unknown) => await invokeOperation(options.baseUrl, operation, args),
    ]),
  );

  return {
    name: options.providerName,
    fns,
  };
}

function collectOperations(
  document: OpenApiDocument,
  operationAliases?: Record<string, string>,
): Array<[string, OperationSpec]> {
  const operations: Array<[string, OperationSpec]> = [];

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;

    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation = pathItem[method];
      if (!operation?.operationId) continue;

      const functionName = sanitizeToolName(
        operationAliases?.[operation.operationId] ?? operation.operationId,
      );
      const parameters = operation.parameters ?? [];

      operations.push([
        functionName,
        {
          path,
          method: method.toUpperCase() as OperationSpec["method"],
          pathParamNames: parameters
            .filter((parameter) => parameter.in === "path" && parameter.name)
            .map((parameter) => parameter.name!),
          queryParamNames: parameters
            .filter((parameter) => parameter.in === "query" && parameter.name)
            .map((parameter) => parameter.name!),
          hasBody: operation.requestBody != null,
          isStream: Boolean(operation.responses?.["200"]?.content?.["text/event-stream"]),
        },
      ]);
    }
  }

  return operations;
}

async function invokeOperation(baseUrl: string, operation: OperationSpec, args: unknown) {
  const input = isRecord(args) ? { ...args } : {};
  let resolvedPath = operation.path;

  for (const name of operation.pathParamNames) {
    const value = input[name];
    if (value == null) {
      throw new Error(`Missing required path parameter: ${name}`);
    }

    resolvedPath = resolvedPath.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    delete input[name];
  }

  const url = new URL(trimLeadingSlash(resolvedPath), `${trimTrailingSlash(baseUrl)}/`);
  for (const name of operation.queryParamNames) {
    const value = input[name];
    if (value == null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(name, String(item));
      }
    } else {
      url.searchParams.set(name, String(value));
    }

    delete input[name];
  }

  const headers = new Headers();
  if (operation.hasBody) {
    headers.set("content-type", "application/json");
  }
  if (operation.isStream) {
    headers.set("accept", "text/event-stream");
  }

  const response = await fetch(url, {
    method: operation.method,
    headers,
    body: operation.hasBody ? JSON.stringify(input) : undefined,
  });

  if (!response.ok) {
    const message = await readErrorResponse(response);
    throw new Error(
      message
        ? `${operation.method} ${url} failed with ${response.status}: ${message}`
        : `${operation.method} ${url} failed with ${response.status}`,
    );
  }

  if (operation.isStream) {
    return await collectSseStream(response);
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as unknown;
  }

  return await response.text();
}

async function collectSseStream(response: Response) {
  const values: unknown[] = [];
  if (!response.body) {
    return values;
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
        const parsed = parseSseChunk(chunk);
        if (!parsed) continue;
        if (parsed.kind === "done") return values;
        if (parsed.kind === "error") {
          throw new Error(
            typeof parsed.value === "string" ? parsed.value : JSON.stringify(parsed.value),
          );
        }
        values.push(parsed.value);
      }

      if (done) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return values;
}

function parseSseChunk(
  chunk: string,
): { kind: "value"; value: unknown } | { kind: "error"; value: unknown } | { kind: "done" } | null {
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

  if (dataLines.length === 0 && event === "message") {
    return null;
  }

  const value = parseSseValue(dataLines.join("\n"));
  if (event === "done") {
    return { kind: "done" };
  }
  if (event === "error") {
    return { kind: "error", value };
  }

  return { kind: "value", value };
}

function parseSseValue(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

async function readErrorResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      return JSON.stringify(await response.json());
    }

    const text = await response.text();
    return text.trim().length > 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

function trimLeadingSlash(value: string) {
  return value.replace(/^\/+/, "");
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
