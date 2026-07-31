/**
 * Board workspace naming, shared by the vessel (rpc-api.ts) and the browser
 * (routes/use-workspace-board). A board id ("checkout id" historically) has
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
export function checkoutWorkspacePath(checkoutId: string, repoPath: string): string {
  const slug = repoPath.replace(/^\/+/, "").replaceAll("/", "--");
  return `/workspaces/tasks/${checkoutId}~${slug}-${fnv1a32Hex(repoPath)}`;
}

/**
 * Inverse of checkoutWorkspacePath, hash-verified. The slug alone is not
 * injective ("--" is both the path separator and a legal repo-name
 * substring), so every reading of the slug is enumerated — bounded — and
 * the embedded hash picks the real one. Returns null for anything that is
 * not a board workspace path (an agent workspace, a foreign name under the
 * tasks namespace, ...).
 */
export function parseBoardWorkspacePath(
  path: string,
): { checkoutId: string; repoPath: string } | null {
  const match = /^\/workspaces\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})~(.+)-([0-9a-f]{8})$/.exec(
    path,
  );
  if (match === null) return null;
  const [, checkoutId, slug, hash] = match;
  const parts = slug!.split("--");
  // 2^6 candidate readings is plenty for real repo names; anything wilder
  // is not a path this app minted.
  if (parts.length < 2 || parts.length > 7) return null;
  for (let mask = 0; mask < 1 << (parts.length - 1); mask++) {
    let repoPath = `/${parts[0]}`;
    for (let index = 1; index < parts.length; index++) {
      repoPath += (mask & (1 << (index - 1))) === 0 ? `/${parts[index]}` : `--${parts[index]}`;
    }
    if (fnv1a32Hex(repoPath) === hash && normalizeRepoPath(repoPath) !== null) {
      return { checkoutId: checkoutId!, repoPath };
    }
  }
  return null;
}

/**
 * How a board addresses its workspace. `checkoutId` is set when the board
 * uses the tasks app's own naming (the workspace is lazily created on first
 * use); null when the board is a lens on an existing workspace addressed
 * purely by path (plain get). `workspacePath` is always resolved.
 */
export type BoardAddress = {
  checkoutId: string | null;
  workspacePath: string;
  /** The /repos/** mount whose task files this board shows. */
  repoPath: string;
};

/**
 * Publishing is the workspace owner's act: the tasks app owns only its own
 * /workspaces/tasks/ naming (boards, shared by every project member), and a
 * board workspace ENCODES its one repo — so ownership requires the path to
 * parse as a board AND the lens to be scoped to that board's own repo. A
 * lens on anything else (an agent's workspace mid-thought, an unparseable
 * tasks-namespace path, a board opened against a different mount) is a
 * guest: read, comment, edit, but never Commit or Discard-all.
 */
export function isGuestWorkspacePath(workspacePath: string, repoPath: string): boolean {
  const board = parseBoardWorkspacePath(workspacePath);
  return board === null || board.repoPath !== repoPath;
}

/** 32-bit FNV-1a as 8 lowercase hex chars. */
function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Shareable board id: date-time prefix for humans, random tail for uniqueness. */
export function newCheckoutId(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const tail = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${tail}`;
}

export function isCheckoutId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}
