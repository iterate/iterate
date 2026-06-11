import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Deployed worker size is a latency problem, not just a storage one: every
// cold Durable Object instantiation loads the full script into a fresh
// isolate, and our request paths chain several DOs. Alchemy's noBundle upload
// globs every `.js`/`.mjs`/`.wasm` (and `.js.map`) under the server dist, but
// the Vite SSR build also emits modules only the BROWSER ever uses (web
// workers, their wasm) plus sourcemaps for everything. Measured on os prd
// before pruning: 89 MB uploaded, of which 50 MB sourcemaps and ~5 MB modules
// unreachable from the entrypoint — against a 34 MB live server graph.

const MODULE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".wasm"]);

// Matches the relative specifiers Vite emits: static imports, re-exports,
// dynamic `import("./…")` literals, and `new URL("./…", import.meta.url)`
// asset references. Conservative by design — an unmatched dynamic pattern
// keeps a module only if nothing else references it either.
const RELATIVE_SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew\s+URL\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

export type PruneServerBundleResult = {
  deletedModules: string[];
  deletedSourcemaps: string[];
  deletedBytes: number;
  keptModules: string[];
};

/**
 * Deletes from `serverDir` everything the worker upload would include but the
 * deployed module graph can never load: sourcemaps (uploaded as modules, paid
 * for on every isolate cold start) and `.js`/`.wasm` files unreachable from
 * the entrypoint via import/`new URL` literals (browser-only web workers and
 * their wasm that the SSR build emits alongside the server chunks).
 *
 * The entrypoint's own sourcemap survives: it is small, and Cloudflare can use
 * an uploaded sourcemap module to symbolicate worker stack traces. Chunk maps
 * are the bulk of the weight and mostly describe browser code, so they go.
 */
export async function pruneServerBundle(input: {
  entrypoint: string;
  serverDir: string;
}): Promise<PruneServerBundleResult> {
  const serverDir = path.resolve(input.serverDir);
  const entrypointSourcemap = `${normalize(input.entrypoint)}.map`;
  const files = await listFilesRecursively(serverDir);
  const modules = files.filter((file) => MODULE_EXTENSIONS.has(path.extname(file)));
  const sourcemaps = files.filter((file) => file.endsWith(".map") && file !== entrypointSourcemap);

  if (!modules.includes(normalize(input.entrypoint))) {
    throw new Error(
      `Entrypoint ${input.entrypoint} not found in ${serverDir} (saw ${String(modules.length)} modules).`,
    );
  }

  const moduleSet = new Set(modules);
  const reachable = new Set<string>();
  const queue = [normalize(input.entrypoint)];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (reachable.has(current) || !moduleSet.has(current)) continue;
    reachable.add(current);
    if (current.endsWith(".wasm")) continue;
    const source = await readFile(path.join(serverDir, current), "utf-8");
    for (const match of source.matchAll(RELATIVE_SPECIFIER_PATTERN)) {
      queue.push(normalize(path.posix.join(path.posix.dirname(current), match[1]!)));
    }
  }

  const deletedModules = modules.filter((file) => !reachable.has(file));
  let deletedBytes = 0;
  for (const file of [...deletedModules, ...sourcemaps]) {
    const filePath = path.join(serverDir, file);
    deletedBytes += (await readFile(filePath)).byteLength;
    await rm(filePath);
  }

  return {
    deletedModules,
    deletedSourcemaps: sourcemaps,
    deletedBytes,
    keptModules: [...reachable].sort(),
  };
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => normalize(path.relative(root, path.join(entry.parentPath, entry.name))));
}

function normalize(relativePath: string): string {
  return path.posix.normalize(relativePath.split(path.sep).join("/"));
}

const isCliInvocation =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCliInvocation) {
  const args = process.argv.slice(2);
  const readArg = (flag: string) => {
    const index = args.indexOf(flag);
    const value = index === -1 ? undefined : args[index + 1];
    if (!value) throw new Error(`${flag} <value> is required`);
    return value;
  };
  const serverDir = readArg("--server-dir");
  const result = await pruneServerBundle({
    entrypoint: readArg("--entrypoint"),
    serverDir,
  });
  console.log(
    `[prune-server-bundle] ${serverDir}: kept ${String(result.keptModules.length)} modules, ` +
      `deleted ${String(result.deletedModules.length)} unreachable modules + ` +
      `${String(result.deletedSourcemaps.length)} sourcemaps ` +
      `(${(result.deletedBytes / 1e6).toFixed(1)} MB)`,
  );
  if (result.deletedModules.length > 0) {
    console.log(`[prune-server-bundle] unreachable: ${result.deletedModules.join(", ")}`);
  }
}
