import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";

/**
 * Agent RPC and agent-scoped ITX both use stream paths as durable identity.
 * This guard keeps the `/agents/...` contract at the edge where callers choose
 * a path, before a stream, ITX Durable Object, or worker scope is minted for it.
 */
export function normalizeAgentPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/agents/")) {
    throw new Error(`agent path must start with "/agents/", got "${normalized}"`);
  }
  return normalized;
}

export function parseAgentDurableObjectName(name: string) {
  const parsed = DurableObjectNameCodec.parse(name);
  normalizeAgentPath(parsed.path);
  return parsed;
}
