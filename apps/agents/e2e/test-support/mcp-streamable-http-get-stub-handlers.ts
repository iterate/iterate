import { http, HttpResponse } from "@iterate-com/mock-http-proxy";

/**
 * `StreamableHTTPClientTransport` (MCP SDK) opens an optional SSE listener with GET + Accept: text/event-stream
 * before POST JSON-RPC. HAR fixtures only replay POST exchanges; without a GET handler MSW logs unhandled requests
 * and the mock proxy may passthrough to the real internet.
 *
 * Returning 405 matches servers that do not expose SSE on GET; the SDK treats that as normal and continues with POST only.
 *
 * URLs must match `publicMcpServers` in `apps/agents/src/durable-objects/iterate-agent.ts`.
 */
export const mcpStreamableHttpGetStubHandlers = [
  http.get(
    "https://docs.mcp.cloudflare.com/mcp",
    () =>
      new HttpResponse(null, {
        status: 405,
        headers: {
          Allow: "GET, POST, DELETE, OPTIONS",
        },
      }),
  ),
  http.get(
    "https://mcp.canuckduck.ca/mcp",
    () =>
      new HttpResponse(null, {
        status: 405,
        headers: {
          Allow: "GET, POST, DELETE, OPTIONS",
        },
      }),
  ),
];
