// Workspace path canonicality, dependency-light on purpose: these predicates
// back the EVENT CONTRACT's schemas (workspace-processor-contract.ts), so raw
// stream appends are held to the same canonical form as the RPC doors — a
// non-canonical mount table can never become durable config. This module is
// also inside the closure the `iterate` package's TUI typechecks against
// (agent-defaults → workspaces/utils), so it must not import anything heavy.

import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";

// A placeholder projectId used only to round-trip a PATH through the codec.
// Its value never leaves this module — it just has to be a legal projectId so
// stringify/parse run.
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

/**
 * Resolve `.`/`..` segments the way the shell's own path normalization does
 * (pop-based, cannot escape the root), so the `.git` write guard, whiteout
 * keys, and mount-point keys cannot be dodged with `/foo/../.git/config`.
 */
export function resolveAbsolutePath(path: string): string {
  const resolved: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return `/${resolved.join("/")}`;
}

/**
 * A canonical mount point: already in resolved absolute form (no `.`/`..`/
 * doubled slashes — so two spellings can never alias one subtree) and free of
 * the reserved `.git` segment.
 */
export function isCanonicalMountPath(path: string): boolean {
  return path === resolveAbsolutePath(path) && !path.split("/").includes(".git");
}

/**
 * A canonical repo path: a `/repos/**` stream path in normalized form that
 * round-trips the Durable Object name codec unchanged. The round trip is the
 * load-bearing check — the codec's name grammar reserves `?` for props, so a
 * repoPath like `/repos/b?x=1` would mint a Durable Object whose parsed
 * identity differs from the configured string (two names, one logical repo).
 */
export function isCanonicalRepoPath(repoPath: string): boolean {
  try {
    if (repoPath !== normalizePath(repoPath)) return false;
    if (!repoPath.startsWith("/repos/") || repoPath === "/repos/") return false;
    const roundTripped = DurableObjectNameCodec.parse(
      DurableObjectNameCodec.stringify({ path: repoPath, projectId: ROUND_TRIP_PROJECT_ID }),
    ).path;
    return roundTripped === repoPath;
  } catch {
    return false;
  }
}
