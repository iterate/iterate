import type { DurableObjectNamespace, KVNamespace } from "@cloudflare/workers-types";

/**
 * Worker environment bindings.
 * This interface must match the bindings defined in alchemy.run.ts
 */
export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  MCP_OAUTH_OBJECT: DurableObjectNamespace;
  MOCK_OAUTH_SESSIONS: KVNamespace;
  OAUTH_KV: KVNamespace; // Required by @cloudflare/workers-oauth-provider
}
