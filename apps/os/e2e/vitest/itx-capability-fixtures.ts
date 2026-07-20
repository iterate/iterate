import { createWebSocketResponse, isWebSocketUpgradeRequest, WebSocketPair } from "captun";
import { mockSlackResponseBody } from "../test-support/mock-slack-api.ts";
import { withTunnel, type TunnelHandle } from "../test-support/tunnel.ts";

type CapabilityFixtureInput = {
  expectedAuthorization?: string;
};

/**
 * Slack Web API stand-in for the WORKER-side WebClient (the seeded project
 * worker's `slack` surface): local runs use loopback; deployed runs expose the
 * same local fixture through the apps/tunnels captun gateway.
 */
export async function startMockSlackApi(): Promise<TunnelHandle & { calls: string[] }> {
  const calls: string[] = [];
  const server = await withTunnel({
    path: "/",
    async fetch(request) {
      const method = new URL(request.url).pathname.replace(/^\//, "");
      calls.push(method);
      const body = await request.text();
      const contentType = request.headers.get("content-type") ?? "";
      const payload: Record<string, unknown> = contentType.includes("application/json")
        ? (JSON.parse(body || "{}") as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(body));
      return Response.json(mockSlackResponseBody(method, payload));
    },
  });
  return { ...server, calls };
}

export async function startEgressEcho(): Promise<TunnelHandle> {
  return await withTunnel({
    path: "/egress-echo",
    async fetch(request) {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = await request.text();
      const contentType = request.headers.get("content-type") || "";
      return Response.json({
        body: body && contentType.includes("json") ? JSON.parse(body) : body || null,
        headers,
      });
    },
  });
}

/** Public WSS fixture for ordinary clients and the stock Codex CLI. */
export const WEBSOCKET_ECHO_GREETING = "iterate-websocket-ready";
export const WEBSOCKET_ECHO_PROTOCOL = "iterate.websocket.proof";

export async function startWebSocketEcho(input: CapabilityFixtureInput = {}): Promise<
  TunnelHandle & {
    authHeaders: string[];
    closeEvents: Array<{ code: number; reason: string }>;
  }
> {
  const authHeaders: string[] = [];
  const closeEvents: Array<{ code: number; reason: string }> = [];
  const server = await withTunnel({
    path: "/websocket-echo",
    fetch(request) {
      const authorization = request.headers.get("authorization") ?? "";
      authHeaders.push(authorization);
      if (!isWebSocketUpgradeRequest(request)) {
        return new Response("websocket upgrade required", { status: 426 });
      }
      if (
        input.expectedAuthorization !== undefined &&
        authorization !== input.expectedAuthorization
      ) {
        return new Response("unauthorized", { status: 401 });
      }

      const pair = new WebSocketPair();
      pair[1].accept({ allowHalfOpen: false });
      pair[1].addEventListener("message", (event) => {
        pair[1].send(event.data as string | ArrayBuffer);
      });
      pair[1].addEventListener("close", (event) => {
        closeEvents.push({ code: event.code, reason: event.reason });
      });
      pair[1].send(WEBSOCKET_ECHO_GREETING);

      const offeredProtocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((protocol) => protocol.trim());
      return createWebSocketResponse(
        pair[0],
        offeredProtocols.includes(WEBSOCKET_ECHO_PROTOCOL)
          ? { protocol: WEBSOCKET_ECHO_PROTOCOL }
          : undefined,
      );
    },
  });
  return { ...server, authHeaders, closeEvents };
}

export async function startMockOpenApi(
  input: CapabilityFixtureInput = {},
): Promise<TunnelHandle & { authHeaders: string[] }> {
  const authHeaders: string[] = [];
  const server = await withTunnel({
    fetch(request) {
      authHeaders.push(request.headers.get("authorization") ?? "");
      if (
        input.expectedAuthorization !== undefined &&
        request.headers.get("authorization") !== input.expectedAuthorization
      ) {
        return Response.json({ error: "unexpected_authorization" }, { status: 401 });
      }

      const requestUrl = new URL(request.url);

      if (requestUrl.pathname === "/openapi.json") {
        const baseUrl = requestUrl.origin;
        return Response.json({
          openapi: "3.0.3",
          info: { title: "Tiny Pets", version: "1.0.0" },
          servers: [{ url: baseUrl }],
          paths: {
            "/pets": {
              get: {
                operationId: "findPetsByStatus",
                parameters: [
                  {
                    in: "query",
                    name: "status",
                    required: true,
                    schema: { enum: ["available", "pending"], type: "string" },
                  },
                ],
                responses: { "200": { content: { "application/json": { schema: {} } } } },
                summary: "Find pets by status",
              },
            },
          },
        });
      }

      if (requestUrl.pathname === "/pets") {
        const status = requestUrl.searchParams.get("status");
        return Response.json([{ id: 1, name: `${status}-pet`, status }]);
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  return { ...server, authHeaders };
}

export async function startMockMcp(
  input: CapabilityFixtureInput = {},
): Promise<TunnelHandle & { authHeaders: string[]; methods: string[] }> {
  const authHeaders: string[] = [];
  const methods: string[] = [];
  const server = await withTunnel({
    path: "/mcp",
    async fetch(request) {
      if (request.method === "GET") {
        return new Response(null, { status: 405 });
      }

      const payload = (await request.json().catch(() => ({}))) as {
        id?: string | number;
        method?: string;
        params?: { arguments?: Record<string, unknown> };
      };
      authHeaders.push(request.headers.get("authorization") ?? "");
      if (
        input.expectedAuthorization !== undefined &&
        request.headers.get("authorization") !== input.expectedAuthorization
      ) {
        return Response.json(
          { error: "unexpected_authorization", id: payload.id },
          { status: 401 },
        );
      }

      methods.push(String(payload.method ?? ""));

      if (payload.method === "initialize") {
        return Response.json({
          id: payload.id,
          jsonrpc: "2.0",
          result: {
            capabilities: { tools: {} },
            protocolVersion: "2025-11-25",
            serverInfo: { name: "mock-mcp", version: "1.0.0" },
          },
        });
      }

      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      if (payload.method === "tools/list") {
        return Response.json({
          id: payload.id,
          jsonrpc: "2.0",
          result: {
            tools: [
              {
                description: "Search docs",
                inputSchema: {
                  properties: { query: { type: "string" } },
                  required: ["query"],
                  type: "object",
                },
                name: "search_docs",
              },
            ],
          },
        });
      }

      if (payload.method === "tools/call") {
        const result = { answer: `docs:${payload.params?.arguments?.query}` };
        return Response.json({
          id: payload.id,
          jsonrpc: "2.0",
          result: {
            content: [{ text: JSON.stringify(result), type: "text" }],
            structuredContent: result,
          },
        });
      }

      return Response.json({
        error: { code: -32601, message: "Method not found" },
        id: payload.id,
        jsonrpc: "2.0",
      });
    },
  });
  return { ...server, authHeaders, methods };
}
