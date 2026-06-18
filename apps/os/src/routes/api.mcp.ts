import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { handleInboundMcpRequest } from "~/domains/inbound-mcp-server/mcp-handler.ts";
import type { RequestContext } from "~/request-context.ts";

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      ANY: handleMcpStartRoute,
    },
  },
});

export async function handleMcpStartRoute(input: { context: RequestContext; request: Request }) {
  const context = { ...input.context, rawRequest: input.request };
  return await handleInboundMcpRequest({ context, env, request: input.request });
}
