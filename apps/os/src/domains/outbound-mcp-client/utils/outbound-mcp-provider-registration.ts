import type { ToolProviderRegistration } from "~/domains/codemode/stream-processors/codemode/contract.ts";

/**
 * Construct a codemode provider registration for a remote MCP server.
 *
 * The Durable Object instance name is the server URL itself, so multiple
 * providers pointing at the same MCP server share a connection and tool cache.
 *
 * Requires an OUTBOUND_MCP_FROM_OUR_CLIENT_CAPABILITY DurableObjectNamespace
 * binding on the worker that dispatches this callable.
 */
export function createOutboundMcpFromOurClientToolProviderRegistration(options: {
  headers?: Record<string, string>;
  instructions?: string;
  path: string[];
  serverUrl: string;
}): ToolProviderRegistration {
  const durableObjectName = JSON.stringify({
    serverUrl: options.serverUrl,
    headers: options.headers ?? {},
  });
  const via = {
    type: "env-binding" as const,
    bindingType: "durable-object-namespace" as const,
    bindingName: "OUTBOUND_MCP_FROM_OUR_CLIENT_CAPABILITY",
    durableObject: { name: durableObjectName },
  };

  return {
    instructions:
      options.instructions ??
      `Remote MCP server at ${options.serverUrl}. Call listTools() on this namespace to inspect available MCP tools, then call the returned tool name as a codemode function path.`,
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc" as const,
        via,
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
    path: options.path,
  };
}
