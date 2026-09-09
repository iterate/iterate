/**
 * What the board view needs to address a workspace, shared by the vessel
 * (rpc-api.ts) and the browser (routes, hooks). A workspace is its path and
 * nothing else — an agent's `/workspaces/agents/x`, a scratch one this app
 * minted, any path at all opens the same way; the board adds only WHICH
 * repo mount's task files it shows.
 */

/** The repo a board edits when none is picked. */
export const DEFAULT_REPO_PATH = "/repos/config";

/** The namespace this app mints scratch workspaces under ("New workspace", /jam). */
export const SCRATCH_WORKSPACE_PREFIX = "/workspaces/scratch/";

/**
 * A board's repo path must be a clean `/repos/...` path — it becomes a
 * mount lookup and a git-API scope, so reject anything with empty, dotted,
 * or exotic segments. Returns null when invalid.
 */
export function normalizeRepoPath(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return DEFAULT_REPO_PATH;
  if (!value.startsWith("/repos/")) return null;
  const segments = value.slice(1).split("/");
  if (segments.length < 2) return null;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) return null;
  }
  return value;
}

/** How the board view addresses what it shows: an existing workspace by its
 * path (plain get — nothing here creates) plus the /repos/** mount whose
 * task files it renders. */
export type BoardAddress = {
  workspacePath: string;
  /** The /repos/** mount whose task files this board shows. */
  repoPath: string;
};

/**
 * Publishing is the workspace OWNER's act. This app owns only the scratch
 * workspaces it mints itself; anything else — an agent's workspace
 * mid-thought, a foreign name — is a guest: read, comment, edit, but never
 * Commit or Discard-all, because a commit publishes a mount's ENTIRE dirty
 * set, the owner's uncommitted work included.
 */
export function isGuestWorkspacePath(workspacePath: string): boolean {
  return !workspacePath.startsWith(SCRATCH_WORKSPACE_PREFIX);
}

/** A fresh scratch workspace name: date-time prefix for humans, random tail for uniqueness. */
export function newScratchWorkspaceName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const tail = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${tail}`;
}
