// Dependency-light repo path constants. Deliberately import-free: this module
// is reachable from files the `iterate` package's TUI typechecks against
// (agent-defaults → workspaces/utils), where the sibling `utils.ts` — whose
// worker-ref types pull in rpc-targets and, transitively, most of the app —
// must never enter the compilation.

/**
 * The project's config repo — an ordinary repo at an ordinary `/repos/*`
 * path, seeded during project bootstrap and the source the default project
 * worker builds from. Keeping the path here lets project creation, project
 * processors, worker refs, and workspace mounts share the same address
 * instead of each baking in their own literal. Its events reach the project
 * stream `/` through the `cross-post:/` subscription the bootstrap saga arms
 * on this repo's stream.
 */
export const CONFIG_REPO_PATH = "/repos/config";
