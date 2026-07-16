import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";

// A placeholder projectId used only to round-trip the PATH through the codec.
// Its value never leaves this module — real workspace names carry the caller's
// projectId — it just has to be a legal projectId so stringify/parse run.
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

// Every workspace lives under this collection prefix, matching the addressing
// convention used by `/secrets/...`, `/repos/...`, and `/sandboxes/...`. The
// prefix does not itself declare or create a stream processor.
const WORKSPACE_PATH_PREFIX = "/workspaces";

/**
 * The project's ROOT workspace: the always-fresh, read-only materialization of
 * the config repo's main branch that every other workspace falls through to
 * on missing reads. Callers spell it `"/"` (`itx.workspaces.get("/")`); the
 * bare prefix is its Durable Object identity — previously unmintable (the
 * normalizer required a path UNDER the prefix), so no existing workspace can
 * collide with it.
 */
export const ROOT_WORKSPACE_PATH = WORKSPACE_PATH_PREFIX;

export function isRootWorkspacePath(path: string): boolean {
  return path === ROOT_WORKSPACE_PATH;
}

/**
 * Where an agent's own workspace (`itx.workspace`) lives: the agent path under
 * the workspace prefix — `/agents/bla` → `/workspaces/agents/bla`. One
 * function so the birth-certificate mount and anything else addressing an
 * agent's workspace can never disagree on the mapping.
 */
export function agentWorkspacePath(agentPath: string): string {
  return normalizeWorkspacePath(`${WORKSPACE_PATH_PREFIX}${normalizePath(agentPath)}`);
}

/**
 * The workspace path is durable identity (it becomes the Durable Object name),
 * so this guard sits at the edge where callers choose a path — same role as
 * `assertSandboxPath` / `normalizeAgentPath`. Beyond the prefix, the only
 * real constraint is codec safety: the path must survive the
 * `{projectId}.iterate{path}` name round trip unchanged, so two spellings can
 * never mint two Durable Objects that parse back to one canonical path.
 */
export function normalizeWorkspacePath(path: string): string {
  const normalized = normalizePath(path);
  // "/" is the caller spelling of the root workspace; the bare prefix is its
  // durable identity. Both normalize to the same Durable Object.
  if (normalized === "/" || normalized === ROOT_WORKSPACE_PATH) return ROOT_WORKSPACE_PATH;
  if (!normalized.startsWith(`${WORKSPACE_PATH_PREFIX}/`)) {
    throw new Error(
      `workspace paths live under ${WORKSPACE_PATH_PREFIX}/ (an agent's workspace at ` +
        `${WORKSPACE_PATH_PREFIX}<agent path>, standalone ones under ` +
        `${WORKSPACE_PATH_PREFIX}/<anything>, and "/" is the project's read-only root ` +
        `workspace tracking the repo's main branch), got "${normalized}"`,
    );
  }
  const roundTripped = DurableObjectNameCodec.parse(
    DurableObjectNameCodec.stringify({ path: normalized, projectId: ROUND_TRIP_PROJECT_ID }),
  ).path;
  if (roundTripped !== normalized) {
    throw new Error(
      `workspace path must be a stable Durable Object path (it round-trips unchanged ` +
        `through the name codec), got "${normalized}" which normalizes to "${roundTripped}"`,
    );
  }
  return normalized;
}
