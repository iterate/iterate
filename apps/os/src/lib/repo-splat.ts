import { PROJECT_REPO_PATH } from "~/domains/repos/utils.ts";

/**
 * TEMPORARY HACK — delete this module when the legacy `/` repo is replaced by
 * `/repos/config`.
 *
 * The repo viewer routes address a repo by putting the suffix of its path
 * (after `/repos/`) into the URL splat. The legacy project repo lives at the
 * stream root path `/` (`PROJECT_REPO_PATH`), so its suffix is empty and the
 * URL `/projects/<slug>/repos//` normalizes to the repos index — making it
 * unviewable. Until the migration, the sentinel segment below stands in for
 * the root repo. A real repo at `/repos/~` would collide with it; accepted,
 * because this whole mapping is short-lived.
 */
const ROOT_REPO_SPLAT_SENTINEL = "~";

export function repoPathToSplat(path: string): string {
  if (path === PROJECT_REPO_PATH) return ROOT_REPO_SPLAT_SENTINEL;
  return path.startsWith("/repos/") ? path.slice("/repos/".length) : path;
}

export function repoPathFromSplat(splat: string | undefined): string {
  const suffix = splat?.replace(/^\/+/, "") ?? "";
  if (suffix === ROOT_REPO_SPLAT_SENTINEL) return PROJECT_REPO_PATH;
  return `/repos/${suffix}`;
}
