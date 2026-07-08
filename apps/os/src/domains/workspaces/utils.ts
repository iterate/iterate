import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";

// A placeholder projectId used only to round-trip the PATH through the codec.
// Its value never leaves this module — real workspace names carry the caller's
// projectId — it just has to be a legal projectId so stringify/parse run.
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

// Every workspace lives under this prefix — the domain-prefix convention every
// other domain already follows (`/secrets/...`, `/repos/...`, `/sandboxes/...`),
// so a project path names exactly one kind of object.
const WORKSPACE_PATH_PREFIX = "/workspaces";

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
 * `normalizeSandboxPath` / `normalizeAgentPath`. Beyond the prefix, the only
 * real constraint is codec safety: the path must survive the
 * `{projectId}.iterate{path}` name round trip unchanged, so two spellings can
 * never mint two Durable Objects that parse back to one canonical path.
 */
export function normalizeWorkspacePath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === WORKSPACE_PATH_PREFIX || !normalized.startsWith(`${WORKSPACE_PATH_PREFIX}/`)) {
    throw new Error(
      `workspace paths live under ${WORKSPACE_PATH_PREFIX}/ (an agent's workspace at ` +
        `${WORKSPACE_PATH_PREFIX}<agent path>, standalone ones under ` +
        `${WORKSPACE_PATH_PREFIX}/<anything>), got "${normalized}"`,
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

/**
 * The project-repo branch a workspace pushes to: the workspace path minus its
 * leading slash (`/workspaces/agents/demo` → `workspaces/agents/demo`), with
 * any git-refname-illegal sequences replaced. Deterministic per workspace, so
 * the branch IS the workspace's durable identity inside the repo — every
 * workspace's committed state lands under `workspaces/**`, never on main.
 *
 * Workspace paths are already codec-safe (no spaces or control characters),
 * so the sanitization is belt and braces for the remaining characters git
 * refuses in refnames (`~ ^ : ? * [ \`, `..`, `@{`, leading/trailing dots,
 * `.lock` suffixes).
 */
export function workspaceBranchName(workspacePath: string): string {
  return normalizeWorkspacePath(workspacePath)
    .slice(1)
    .split("/")
    .map((segment) =>
      segment
        .replace(/[~^:?*[\\]/g, "-")
        .replace(/\.\./g, "--")
        .replace(/@\{/g, "-{")
        .replace(/^\./, "-")
        .replace(/\.$/, "-")
        .replace(/\.lock$/, "-lock"),
    )
    .join("/");
}
