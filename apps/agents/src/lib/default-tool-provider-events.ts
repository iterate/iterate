function rpcCallable(
  binding: string,
  durableObjectName: string,
  method: "callTool" | "getTypes",
): {
  kind: "rpc";
  target: {
    type: "durable-object";
    binding: { $binding: string };
    address: { type: "name"; name: string };
  };
  rpcMethod: string;
  argsMode: "object";
} {
  return {
    kind: "rpc",
    target: {
      type: "durable-object",
      binding: { $binding: binding },
      address: { type: "name", name: durableObjectName },
    },
    rpcMethod: method,
    argsMode: "object",
  };
}

/** Preset event: Cloudflare MCP docs server, sandbox namespace `cloudflare_docs`. */
export const MCP_TOOL_PROVIDER_PRESET_EVENT = {
  type: "tool-provider-config-updated",
  payload: {
    slug: "cloudflare_docs",
    executeCallable: rpcCallable("MCP_CLIENT", "iterate-mcp", "callTool"),
    getTypesCallable: rpcCallable("MCP_CLIENT", "iterate-mcp", "getTypes"),
  },
} as const;

/** Preset event: Iterate Events OpenAPI, sandbox namespace `iterate_events`. */
export const OPENAPI_TOOL_PROVIDER_PRESET_EVENT = {
  type: "tool-provider-config-updated",
  payload: {
    slug: "iterate_events",
    executeCallable: rpcCallable("OPENAPI_TOOL_CLIENT", "iterate-events", "callTool"),
    getTypesCallable: rpcCallable("OPENAPI_TOOL_CLIENT", "iterate-events", "getTypes"),
  },
} as const;

/** Preset event: Slack SDK-backed API, sandbox namespace `slack`. */
export const SLACK_TOOL_PROVIDER_PRESET_EVENT = {
  type: "tool-provider-config-updated",
  payload: {
    slug: "slack",
    executeCallable: rpcCallable("SLACK_API", "slack", "callTool"),
    getTypesCallable: rpcCallable("SLACK_API", "slack", "getTypes"),
  },
} as const;
