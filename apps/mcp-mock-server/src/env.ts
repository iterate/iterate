import type { DurableObjectNamespace, KVNamespace } from "@cloudflare/workers-types";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  MCP_OAUTH_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  /**
   * Optional bearer token required for accessing the non-OAuth endpoints (/mcp and /sse).
   * When provided, requests must include HTTP header: Authorization: Bearer <MCP_BEARER_TOKEN>
   */
  MCP_BEARER_TOKEN?: string;
}
