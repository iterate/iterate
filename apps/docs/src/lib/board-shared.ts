/**
 * What the board view needs to address a workspace, shared by the vessel
 * (rpc-api.ts) and the browser (routes, hooks). A workspace is its path and
 * nothing else — an agent's `/agents/x`, one a person named, any path
 * at all opens the same way; the board adds only WHICH repo mount's task
 * files it shows.
 */

/** The repo a board edits when none is picked. */
export const DEFAULT_REPO_PATH = "/repos/config";

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
