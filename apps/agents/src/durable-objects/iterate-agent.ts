import {
  DynamicWorkerExecutor,
  sanitizeToolName,
  type ResolvedProvider,
} from "@cloudflare/codemode";
import { Agent, type Connection, type WSMessage } from "agents";
import { z } from "zod";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

const EVENTS_BASE_URL = "https://events.iterate.com";
const EVENTS_OPENAPI_URL = `${EVENTS_BASE_URL}/api/openapi.json`;

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

const EventsRequestOptions = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().trim().min(1),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z.unknown().optional(),
  contentType: z.string().trim().min(1).optional(),
  rawBody: z.boolean().optional(),
});

let eventsOpenApiSpecPromise: Promise<Record<string, unknown>> | undefined;

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
    const result = await executor.execute(event.data.payload.script, this.getCodemodeProviders());

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

  private getCodemodeProviders(): ResolvedProvider[] {
    const mcp = this.getMcpServers();
    const toolsByServerId = new Map<string, typeof mcp.tools>();

    for (const tool of mcp.tools) {
      const serverTools = toolsByServerId.get(tool.serverId) ?? [];
      serverTools.push(tool);
      toolsByServerId.set(tool.serverId, serverTools);
    }

    const usedProviderNames = new Set<string>();
    const providers: ResolvedProvider[] = [
      {
        name: toUniqueIdentifier("events", usedProviderNames, "events"),
        fns: {
          spec: async () => await getEventsOpenApiSpec(),
          request: async (args: unknown) => await requestEventsApi(args),
        },
      },
    ];

    providers.push(
      ...Array.from(toolsByServerId.entries()).flatMap(([serverId, tools]) => {
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
      }),
    );

    return providers;
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

async function getEventsOpenApiSpec() {
  eventsOpenApiSpecPromise ??= fetchOpenApiSpec();

  try {
    return await eventsOpenApiSpecPromise;
  } catch (error) {
    eventsOpenApiSpecPromise = undefined;
    throw error;
  }
}

async function fetchOpenApiSpec() {
  const response = await fetch(EVENTS_OPENAPI_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch events OpenAPI spec: ${response.status}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

async function requestEventsApi(args: unknown) {
  const options = EventsRequestOptions.parse(args);
  const url = new URL(options.path, EVENTS_BASE_URL);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const headers = new Headers();
  const init: RequestInit = {
    method: options.method,
    headers,
  };

  if (typeof options.contentType === "string") {
    headers.set("content-type", options.contentType);
  }

  if (options.body !== undefined) {
    if (options.rawBody) {
      init.body =
        typeof options.body === "string" ? options.body : JSON.stringify(options.body, null, 2);
    } else {
      headers.set("content-type", headers.get("content-type") ?? "application/json");
      init.body = JSON.stringify(options.body);
    }
  }

  const response = await fetch(url, init);
  const body = await parseResponseBody(response);

  if (!response.ok) {
    throw new Error(
      `events request failed (${response.status}): ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`,
    );
  }

  return body;
}

async function parseResponseBody(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return (await response.json()) as unknown;
  }

  return await response.text();
}
