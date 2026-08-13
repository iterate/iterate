// Minimal .gitignore handling for overlay workspace publishes.
//
// An overlay workspace has no .git of its own (isomorphic-git never runs over
// it), so "what does git ignore?" has to be answered here when the local layer
// is turned into a commit. This deliberately supports only the small pattern
// subset that platform and template code actually writes (the spill dir's
// `*`, name and extension patterns, directory prefixes) — an unsupported
// pattern is SKIPPED, which fails safe toward committing too much rather than
// silently dropping files.

/** Parsed patterns of one .gitignore, scoped to the directory holding it. */
type IgnoreScope = {
  /** Directory the .gitignore lives in, "/" for the root one. */
  dir: string;
  patterns: string[];
};

/**
 * Filter a set of workspace file paths down to the publishable ones by
 * honoring `.gitignore` files found AMONG those paths (the overlay's own
 * layer — parent-side ignores don't matter because only local files are ever
 * committed). Paths are absolute (`/a/b.txt`).
 */
export async function filterPublishablePaths(input: {
  paths: string[];
  readFile: (path: string) => Promise<string | null>;
}): Promise<string[]> {
  const scopes: IgnoreScope[] = [];
  for (const path of input.paths) {
    if (path.split("/").pop() !== ".gitignore") continue;
    const content = await input.readFile(path);
    if (!content) continue;
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const patterns = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
    if (patterns.length) scopes.push({ dir, patterns });
  }
  if (!scopes.length) return input.paths;
  return input.paths.filter((path) => !isIgnored(path, scopes));
}

function isIgnored(path: string, scopes: IgnoreScope[]): boolean {
  for (const scope of scopes) {
    const prefix = scope.dir === "/" ? "/" : `${scope.dir}/`;
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (scope.patterns.some((pattern) => matches(relative, pattern))) return true;
  }
  return false;
}

/**
 * One pattern against one path relative to the .gitignore's directory.
 * Supported: `*` (everything below), `name` (basename at any depth),
 * `*.ext` (extension at any depth), `dir/` (that subtree), `/exact`
 * (exact relative path). Anything else (negations were dropped earlier,
 * `**`, brackets, mid-string `*`) does not match — fail toward publishing.
 */
function matches(relative: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("/")) return relative === pattern.slice(1);
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1);
    return relative === dir || relative.startsWith(`${dir}/`);
  }
  const basename = relative.split("/").pop() ?? relative;
  if (pattern.startsWith("*.")) return basename.endsWith(pattern.slice(1));
  if (pattern.includes("*") || pattern.includes("[")) return false;
  return basename === pattern || relative === pattern || relative.startsWith(`${pattern}/`);
}
