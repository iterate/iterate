/**
 * Board workspace naming, shared by the vessel (rpc-api.ts) and the browser
 * (routes/use-workspace-board). A board id has
 * exactly one job left: minting a fresh board workspace path under the tasks
 * app's own /workspaces/tasks/ namespace — the workspace mechanism holds all
 * actual state.
 */

/** The repo a board edits when none is picked. */
export const DEFAULT_REPO_PATH = "/repos/config";

/**
 * A board's repo path must be a clean `/repos/...` path — it becomes part
 * of a Durable Object name and a git-API target, so reject anything with
 * empty, dotted, or exotic segments. Returns null when invalid.
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

/**
 * The board's platform workspace stream path — the workspace identity
 * ENCODES the repo, so the same board id against a different repository
 * can never bind to the first repository's workspace. The human-readable
 * slug alone is NOT injective ("/repos/a/b" and "/repos/a--b" both slug to
 * "repos--a--b"); a short repoPath hash disambiguates. FNV-1a, not SHA-256:
 * the route component builds this path during render, and WebCrypto digests
 * are async-only.
 */
export function boardWorkspacePath(boardId: string, repoPath: string): string {
  const slug = repoPath.replace(/^\/+/, "").replaceAll("/", "--");
  return `/workspaces/tasks/${boardId}~${slug}-${fnv1a32Hex(repoPath)}`;
}

/**
 * Which board address a workspace path carries, resolved EXACTLY: the slug
 * alone is not injective ("--" is both the path separator and a legal repo
 * name substring), so instead of guessing readings we re-mint the path for
 * each repo the project actually has and keep the one that matches. Returns
 * null for anything that is not one of this app's board workspaces.
 */
export function boardAddressFor(
  path: string,
  repoPaths: readonly string[],
): { boardId: string; repoPath: string } | null {
  const boardId = boardIdOf(path);
  if (boardId === null) return null;
  const repoPath = repoPaths.find((candidate) => boardWorkspacePath(boardId, candidate) === path);
  return repoPath === undefined ? null : { boardId, repoPath };
}

/** The board id a /workspaces/tasks/ path carries, if it is shaped like one. */
function boardIdOf(path: string): string | null {
  const match = /^\/workspaces\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})~/.exec(path);
  return match?.[1] ?? null;
}

/**
 * How a board addresses its workspace. `boardId` is set when the board
 * uses the tasks app's own naming (the workspace is lazily created on first
 * use); null when the board is a lens on an existing workspace addressed
 * purely by path (plain get). `workspacePath` is always resolved.
 */
export type BoardAddress = {
  boardId: string | null;
  workspacePath: string;
  /** The /repos/** mount whose task files this board shows. */
  repoPath: string;
};

/**
 * Publishing is the workspace OWNER's act. The tasks app owns only the board
 * workspaces it mints itself, and a board workspace ENCODES its one repo —
 * so ownership is proven by RE-MINTING the path from (board id, this lens's
 * repo) and requiring an exact match. Anything else — an agent's workspace
 * mid-thought, a foreign name under the tasks namespace, a board opened
 * against a different mount — is a guest: read, comment, edit, but never
 * Commit or Discard-all.
 */
export function isGuestWorkspacePath(workspacePath: string, repoPath: string): boolean {
  // Scratch workspaces (the sidebar's "New workspace", /jam) are this app's
  // own creation too; they are not repo-bound, and commit scope pins the
  // mount anyway.
  if (workspacePath.startsWith(SCRATCH_WORKSPACE_PREFIX)) return false;
  const boardId = boardIdOf(workspacePath);
  return boardId === null || boardWorkspacePath(boardId, repoPath) !== workspacePath;
}

/** The app-neutral namespace "New workspace" and /jam mint under. */
export const SCRATCH_WORKSPACE_PREFIX = "/workspaces/scratch/";

/** 32-bit FNV-1a as 8 lowercase hex chars. */
function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
