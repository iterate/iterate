import { WorkerEntrypoint } from "cloudflare:workers";

const mcpCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

export class ProjectMcpServerEntrypoint extends WorkerEntrypoint {
  async fetch(request: Request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: mcpCorsHeaders });
    }

    return new Response("Project MCP hostnames have moved to the canonical MCP endpoint.", {
      status: 410,
      headers: mcpCorsHeaders,
    });
  }
}
