#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

// `npx iterate` and `bunx iterate` should exercise the package that the runner
// just installed. Normal installed/global executions still delegate to local
// repo source below, which keeps monorepo development fast.
const isEphemeralPackageRunner = () =>
  process.env.npm_command === "exec" &&
  (process.env.npm_lifecycle_event === "npx" || process.env.npm_lifecycle_event === "bunx");

// The black-box PTY test (apps/os/e2e/iterate-cli.e2e.test.ts) builds the
// package, then exercises this same public bin while the monorepo source tree
// is still present. Force the published
// artifact path so that test cannot accidentally fall back to TypeScript.
const forceBuiltPackage = process.env.ITERATE_FORCE_BUILT_PACKAGE === "1";

/**
 * Find a local version of the iterate CLI that differs from the currently
 * running script. Returns an importable module path, or null.
 * @returns {string | null}
 */
const findLocalModule = () => {
  const selfReal = realpathSync(__filename);

  const repoRoot = findUp("pnpm-workspace.yaml");
  if (repoRoot) {
    const repoPkg = join(repoRoot, "packages/iterate");
    const repoBin = join(repoPkg, "bin/iterate.js");
    if (existsSync(repoBin) && realpathSync(repoBin) !== selfReal) {
      const repoSrc = join(repoPkg, "src/cli.ts");
      if (existsSync(repoSrc)) return repoSrc;
      const repoDist = join(repoPkg, "dist/cli.mjs");
      if (existsSync(repoDist)) return repoDist;
    }
  }

  const nmRoot = findUp("node_modules/.bin/iterate");
  if (nmRoot) {
    // pnpm's .bin entry is a shell shim, so compare the package's actual bin.
    // Comparing the shim itself mistakes our own package for another install
    // and sends repository development to a stale dist build.
    const nmScript = join(nmRoot, "node_modules/iterate/bin/iterate.js");
    if (existsSync(nmScript) && realpathSync(nmScript) !== selfReal) {
      const nmDist = join(nmRoot, "node_modules/iterate/dist/cli.mjs");
      if (existsSync(nmDist)) return nmDist;
    }
  }

  return null;
};

const localModule = isEphemeralPackageRunner() || forceBuiltPackage ? null : findLocalModule();
if (localModule) {
  const { runCli } = await import(localModule);
  await runCli();
} else {
  const srcPath = join(pkgRoot, "src/cli.ts");
  const distPath = join(pkgRoot, "dist/cli.mjs");
  const modulePath = !forceBuiltPackage && existsSync(srcPath) ? srcPath : distPath;
  const { runCli } = await import(modulePath);
  await runCli();
}
