import type { DurableObjectNamespace, KVNamespace } from "@cloudflare/workers-types";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  MCP_OAUTH_OBJECT: DurableObjectNamespace;
  MOCK_OAUTH_SESSIONS: KVNamespace;
  OAUTH_KV: KVNamespace;
}
