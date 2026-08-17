import { AgentPath, type AgentPath as AgentPathValue } from "./agent-presence.ts";

/**
 * Agent RPC and agent-scoped itx both use stream paths as durable identity.
 * This guard keeps the `/agents/...` contract at the edge where callers choose
 * a path, before a stream, itx Durable Object, or worker scope is minted for it.
 */
export function parseAgentPath(path: string): AgentPathValue {
  return AgentPath.parse(path);
}

/**
 * Resolve an agent path the way callers address agents: absolute
 * `/agents/...` paths pass through, and relative paths resolve against the
 * calling scope with plain filesystem semantics — `"."` stays put, `".."`
 * climbs (the parent agent of `/agents/a/b` is `".."`). Empty
 * segments are rejected: messaging a path births an agent, so a `"//"` (or
 * trailing-slash) typo must error, not mint a junk stream. Climbing above
 * `/agents/` fails the canonical-path parser.
 */
export function resolveAgentPath(
  path: string,
  sourceScopePath: string | undefined,
): AgentPathValue {
  if (path.startsWith("/")) return parseAgentPath(path);
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
  return parseAgentPath(`/${resolved.join("/")}`);
}
