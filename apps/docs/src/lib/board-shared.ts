/**
 * Board workspace naming and the ownership rule, shared by the vessel
 * (rpc-api.ts) and the browser (routes, hooks). A board id has exactly one
 * job: naming a fresh board workspace under this app's own namespace — the
 * workspace mechanism holds all actual state, and every project repo is
 * mounted in it by derivation, so the repo a board shows is a VIEW choice
 * (`?repo=`), never part of the workspace's identity.
 */

/** The repo a board edits when none is picked. */
export const DEFAULT_REPO_PATH = "/repos/config";

/** The namespace this app mints board workspaces under. */
export const BOARD_WORKSPACE_PREFIX = "/workspaces/tasks/";

/** The app-neutral scratch namespace "New workspace" and /jam mint under. */
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

/** A board workspace's stream path: the id under the tasks namespace. */
export function boardWorkspacePath(boardId: string): string {
  if (!isBoardId(boardId)) throw new Error(`bad board id: ${JSON.stringify(boardId)}`);
  return `${BOARD_WORKSPACE_PREFIX}${boardId}`;
}

/**
 * How a board addresses its workspace: an EXISTING workspace by its platform
 * path (plain get — nothing here creates) plus the /repos/** mount whose
 * task files the board shows.
 */
export type BoardAddress = {
  workspacePath: string;
  /** The /repos/** mount whose task files this board shows. */
  repoPath: string;
};

/**
 * Publishing is the workspace OWNER's act. This app owns the workspaces it
 * mints itself — boards under /workspaces/tasks/ and scratch workspaces
 * (the sidebar's "New workspace", /jam). Anything else — an agent's
 * workspace mid-thought, a foreign name — is a guest: read, comment, edit,
 * but never Commit or Discard-all, because a commit publishes a mount's
 * ENTIRE dirty set, the owner's uncommitted work included.
 */
export function isGuestWorkspacePath(workspacePath: string): boolean {
  return (
    !workspacePath.startsWith(BOARD_WORKSPACE_PREFIX) &&
    !workspacePath.startsWith(SCRATCH_WORKSPACE_PREFIX)
  );
}

/** Shareable board id: date-time prefix for humans, random tail for uniqueness. */
export function newBoardId(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const tail = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${tail}`;
}

export function isBoardId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}
