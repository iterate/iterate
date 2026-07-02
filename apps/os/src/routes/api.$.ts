import { createFileRoute } from "@tanstack/react-router";
import { handleMcpStartRoute } from "./api.mcp.ts";
import { MCP_START_MOUNT_PATH } from "~/lib/mcp-base-url.ts";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const requestContext = { ...context, rawRequest: request };
        const pathname = new URL(request.url).pathname;
        if (pathname === MCP_START_MOUNT_PATH || pathname.startsWith(`${MCP_START_MOUNT_PATH}/`)) {
          return await handleMcpStartRoute({ context: requestContext, request });
        }

        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});
