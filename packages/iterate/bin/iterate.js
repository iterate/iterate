#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// --- Local delegation (must run before any heavy imports) ---

/**
 * Walk up from `startDir` looking for `relativePath` to exist.
 * Returns the directory where it was found, or null.
 * @param {string} relativePath
 * @param {string} [startDir]
 * @returns {string | null}
 */
const findUp = (relativePath, startDir = process.cwd()) => {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, relativePath))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = dirname(__dirname);

/**
 * Find a local version of the iterate CLI that differs from the currently
 * running script. Returns an importable module path, or null.
 * @returns {string | null}
 */
const findLocalModule = () => {
  const selfReal = realpathSync(__filename);

  // 1. Check if we're inside the iterate repo (has pnpm-workspace.yaml at root)
  const repoRoot = findUp("pnpm-workspace.yaml");
  if (repoRoot) {
    const repoPkg = join(repoRoot, "packages/iterate");
    const repoBin = join(repoPkg, "bin/iterate.js");
    if (existsSync(repoBin) && realpathSync(repoBin) !== selfReal) {
      // Prefer TS source in monorepo dev, fall back to dist
      const repoSrc = join(repoPkg, "src/index.ts");
      if (existsSync(repoSrc)) return repoSrc;
      const repoDist = join(repoPkg, "dist/index.js");
      if (existsSync(repoDist)) return repoDist;
    }
  }

  // 2. Check for a local node_modules install
  const nmRoot = findUp("node_modules/.bin/iterate");
  if (nmRoot) {
    const nmScript = join(nmRoot, "node_modules/.bin/iterate");
    if (existsSync(nmScript) && realpathSync(nmScript) !== selfReal) {
      // Published package — use dist
      const nmDist = join(nmRoot, "node_modules/iterate/dist/index.js");
      if (existsSync(nmDist)) return nmDist;
    }
  }

  return null;
};

const localModule = findLocalModule();
if (localModule) {
  const { runCli } = await import(localModule);
  await runCli();
} else {
  // No delegation — run our own copy.
  // In monorepo dev: src/index.ts exists. Published: dist/index.js exists.
  const srcPath = join(pkgRoot, "src/index.ts");
  const distPath = join(pkgRoot, "dist/index.js");
  const modulePath = existsSync(srcPath) ? srcPath : distPath;
  const { runCli } = await import(modulePath);
  await runCli();
}
