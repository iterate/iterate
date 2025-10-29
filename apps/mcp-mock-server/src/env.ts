import type { DurableObjectNamespace, KVNamespace } from "@cloudflare/workers-types";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  MCP_OAUTH_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
}
