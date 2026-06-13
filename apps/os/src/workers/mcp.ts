/**
 * MCP worker: the inbound MCP server endpoint (mcp.iterate.com et al) and
 * its per-session connection Durable Objects. The ingress worker forwards
 * the configured MCP hostname here; handleMcpFetch owns auth + dispatch
 * into the McpAgent DO. Connections run itx scripts, so the loopback
 * surface is exported too.
 */
import { handleMcpFetch } from "~/domains/inbound-mcp-server/mcp-handler.ts";
import { parseConfig } from "~/config.ts";

export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export * from "./shared/loopback-exports.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const config = parseConfig(env);
    const response = await handleMcpFetch({ request, env, ctx, config });
    return response ?? Response.json({ worker: "os-mcp" }, { status: 404 });
  },
};
