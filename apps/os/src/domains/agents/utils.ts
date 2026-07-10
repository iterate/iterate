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

/**
 * Resolve an agent path the way callers address agents: absolute
 * `/agents/...` paths pass through, and relative paths resolve against the
 * calling scope with plain filesystem semantics — `"."` stays put, `".."`
 * climbs (the parent agent of `/agents/a/subagents/b` is `"../.."`). Empty
 * segments are rejected: messaging a path births an agent, so a `"//"` (or
 * trailing-slash) typo must error, not mint a junk stream. Climbing above
 * `/agents/` fails the normalize guard.
 */
export function resolveAgentPath(path: string, sourceScopePath: string | undefined): string {
  if (path.startsWith("/")) return normalizeAgentPath(path);
  if (sourceScopePath === undefined || !sourceScopePath.startsWith("/agents/")) {
    throw new Error(
      `relative agent path ${JSON.stringify(path)} needs an agent scope to resolve against — use an absolute "/agents/..." path`,
    );
  }
  const resolved = sourceScopePath.split("/").filter(Boolean);
  for (const segment of path.split("/")) {
    if (segment === "") throw new Error(`invalid relative agent path ${JSON.stringify(path)}`);
    if (segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return normalizeAgentPath(`/${resolved.join("/")}`);
}

export function parseAgentDurableObjectName(name: string) {
  const parsed = DurableObjectNameCodec.parse(name);
  normalizeAgentPath(parsed.path);
  return parsed;
}
