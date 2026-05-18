import type { Callable } from "@iterate-com/shared/callable/types.ts";

function rpcCallable(
  bindingName: string,
  durableObjectName: string,
  method: "callTool" | "getTypes",
): Extract<Callable, { type: "workers-rpc" }> {
  return {
    type: "workers-rpc",
    via: {
      type: "env-binding",
      bindingType: "durable-object-namespace",
      bindingName,
      durableObject: { name: durableObjectName },
    },
    rpcMethod: method,
    argsMode: "object",
  };
}

/** Preset event: Cloudflare MCP docs server, sandbox namespace `cloudflare_docs`. */
export const MCP_TOOL_PROVIDER_PRESET_EVENT = {
  type: "events.iterate.com/codemode/tool-provider-config-updated",
  payload: {
    slug: "cloudflare_docs",
    executeCallable: rpcCallable("MCP_CLIENT", "iterate-mcp", "callTool"),
    getTypesCallable: rpcCallable("MCP_CLIENT", "iterate-mcp", "getTypes"),
  },
} as const;

/** Preset event: Iterate Events OpenAPI, sandbox namespace `iterate_events`. */
export const OPENAPI_TOOL_PROVIDER_PRESET_EVENT = {
  type: "events.iterate.com/codemode/tool-provider-config-updated",
  payload: {
    slug: "iterate_events",
    executeCallable: rpcCallable("OPENAPI_TOOL_CLIENT", "iterate-events", "callTool"),
    getTypesCallable: rpcCallable("OPENAPI_TOOL_CLIENT", "iterate-events", "getTypes"),
  },
} as const;

/** Preset event: Slack SDK-backed API, sandbox namespace `slack`. */
export const SLACK_TOOL_PROVIDER_PRESET_EVENT = {
  type: "events.iterate.com/codemode/tool-provider-config-updated",
  payload: {
    slug: "slack",
    executeCallable: rpcCallable("SLACK_API", "slack", "callTool"),
    getTypesCallable: rpcCallable("SLACK_API", "slack", "getTypes"),
  },
} as const;
