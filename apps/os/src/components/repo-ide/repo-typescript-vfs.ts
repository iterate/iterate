import { effectiveEntry, type WorkingTreeChanges } from "./staged-changes.ts";

/**
 * The pure math of the repo IDE's TypeScript vfs sync (no React, no comlink,
 * no worker): which paths seed the environment, what the vfs should contain
 * given HEAD + the working tree, and the update/delete batch that gets it
 * there. `repo-typescript.ts` wires these to the actual worker; the spec
 * lives in `repo-typescript-vfs.test.ts`.
 */

const TYPESCRIPT_SEED_EXTENSIONS = new Set([
  "cjs",
  "cts",
  "js",
  "json",
  "jsx",
  "mjs",
  "mts",
  "ts",
  "tsx",
]);

/** Files worth showing to the TypeScript program: sources it can check plus
 * `.json` for `resolveJsonModule` (which also carries tsconfig.json in). */
function isTypeScriptSeedPath(path: string): boolean {
  const extension = path.split(".").pop() || "";
  return TYPESCRIPT_SEED_EXTENSIONS.has(extension.toLowerCase());
}

/** Whether the language service attaches to this open buffer at all. */
export function isTypeScriptEditorPath(path: string): boolean {
  const extension = (path.split(".").pop() || "").toLowerCase();
  return isTypeScriptSeedPath(path) && extension !== "json";
}

/** Repo paths are relative ("src/x.ts"); the vfs wants rooted ("/src/x.ts"). */
export function vfsPath(repoPath: string): string {
  return `/${repoPath}`;
}

const MAX_SEED_FILES = 500;

/** Behavior-carrying root files pinned past the seed cap: both sort
 * lexicographically after most source directories, and silently dropping
 * them would revert the repo's compiler options to the defaults
 * (tsconfig.json) or stop typm from ever running (package.json). */
const PINNED_SEED_PATHS = ["package.json", "tsconfig.json"];

/**
 * Which HEAD paths seed the vfs: TypeScript-relevant, sorted, capped for
 * pathological repo sizes (with {@link PINNED_SEED_PATHS} kept regardless).
 */
export function repoSeedPaths(paths: string[]): string[] {
  const seedPaths = paths.filter(isTypeScriptSeedPath).sort();
  if (seedPaths.length <= MAX_SEED_FILES) return seedPaths;
  console.warn(
    `[repo-ide] TypeScript language service is only seeing the first ${MAX_SEED_FILES} of ${seedPaths.length} TypeScript-relevant files.`,
  );
  const capped = seedPaths.slice(0, MAX_SEED_FILES);
  for (const pinned of PINNED_SEED_PATHS) {
    if (seedPaths.includes(pinned) && !capped.includes(pinned)) capped.push(pinned);
  }
  return capped;
}

/**
 * HEAD contents overlaid with the working tree: what the vfs SHOULD contain.
 * Write entries (working over staged, like everywhere else) override HEAD,
 * deletes drop the path, and binary (base64) entries are invisible to the
 * program.
 */
export function desiredRepoVfs(
  headContents: ReadonlyMap<string, string>,
  changes: WorkingTreeChanges,
): Map<string, string> {
  const desired = new Map(headContents);
  for (const [path, change] of changes) {
    if (!isTypeScriptSeedPath(path)) continue;
    const entry = effectiveEntry(change);
    if (entry === undefined) continue;
    if (entry.type === "write") desired.set(path, entry.content);
    else if (entry.type === "delete") desired.delete(path);
    // write-base64 entries are binary uploads — nothing for the program.
  }
  return desired;
}

/**
 * The worker calls that turn `pushed` (what the vfs holds, repo-relative
 * keys) into `desired`: contents to write and paths to delete, both keyed by
 * vfs-rooted path.
 */
export function repoVfsDiff(
  pushed: ReadonlyMap<string, string>,
  desired: ReadonlyMap<string, string>,
): { updates: Record<string, string>; removals: string[] } {
  const updates: Record<string, string> = {};
  for (const [path, content] of desired) {
    if (pushed.get(path) !== content) updates[vfsPath(path)] = content;
  }
  const removals = [...pushed.keys()]
    .filter((path) => !desired.has(path))
    .map((path) => vfsPath(path));
  return { updates, removals };
}
