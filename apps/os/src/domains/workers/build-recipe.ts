import type { WorkerBuildOptions } from "./schemas.ts";
import { ITERATE_LIVE_STATE_VIRTUAL_MODULE } from "./iterate-live-state-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE } from "./iterate-processors-cloudflare-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_VIRTUAL_MODULE } from "./iterate-processors-virtual-module.generated.ts";
import { ITERATE_SDK_VIRTUAL_MODULE } from "./iterate-sdk-virtual-module.generated.ts";

/**
 * The one dynamic-worker build recipe, shared verbatim by every runner: the
 * project's builder sandbox (deployed envs), the vite dev server's
 * `/__dev/worker-build` endpoint (local dev), and the deploy-time template
 * seeder. One module generating identical files and commands is what keeps
 * those environments from growing separate resolution semantics; the runner
 * only supplies a directory, a way to execute shell commands, and a way to
 * read the outputs back.
 *
 * This module is deliberately pure (no env, no I/O) so node-side tooling can
 * import it without dragging worker bindings in.
 */

/**
 * The one options canonicalization, applied BEFORE the build key is computed
 * (options are hashed into the key wholesale). Two defaults live here so
 * differently-spelled equivalent refs hash to ONE key — a bare ref that omits
 * `options` and the fully spelled-out `defaultProjectWorkerRef` must share an
 * artifact, or the deploy-time template seed silently misses (and fresh
 * projects fall back to per-project container builds):
 *
 * - `entryPoint` defaults to "worker.ts" HERE, not just inside the recipe.
 * - The platform's virtual modules are injected: every bundled build can
 *   `import ... from "iterate/sdk"` / `"iterate/processors"` — the runtime
 *   pinned to this deployment (the seeded `iterate` devDependency exists for
 *   typechecking and editors, never as the runtime the platform executes),
 *   so a platform runtime change invalidates cached artifacts instead of
 *   serving stale builds. A source supplying its own entry for a specifier
 *   wins.
 *
 * Lives here (pure) because the deploy-time template seeder must apply the
 * SAME canonicalization the runtime resolver does, or their build keys fork.
 */
export function canonicalWorkerBuildOptions(options: WorkerBuildOptions): WorkerBuildOptions {
  return {
    ...options,
    entryPoint: options.entryPoint ?? "worker.ts",
    virtualModules: {
      "iterate/live-state": ITERATE_LIVE_STATE_VIRTUAL_MODULE,
      "iterate/sdk": ITERATE_SDK_VIRTUAL_MODULE,
      "iterate/processors": ITERATE_PROCESSORS_VIRTUAL_MODULE,
      "iterate/processors/cloudflare": ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE,
      ...options.virtualModules,
    },
  };
}

/** Dynamic-worker compatibility, hashed into every build key (worker-loader).
 * Deliberately distinct from the OS worker's own COMPATIBILITY_DATE — dynamic
 * worker compat moves on its own schedule. */
export const WORKER_COMPATIBILITY_DATE = "2026-05-01";
export const WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"];

/**
 * The wrangler pin that IS the build toolchain. Two places must agree:
 * apps/os's own `wrangler` devDependency (the host/dev runner and the deploy
 * seeder — asserted by build-key.test.ts) and this constant, which the
 * container lane installs from directly (build-backend.ts — deliberately NOT
 * baked into the sandbox image; see sandbox/Dockerfile) and which
 * participates in the build key so a toolchain bump invalidates cached
 * artifacts instead of serving output from an older bundler. esbuild rides
 * inside wrangler — there is no separate bundler pin.
 */
export const WRANGLER_VERSION = "4.107.0";

/**
 * The nub pin (https://github.com/nubjs/nub): a Rust package manager whose
 * `install` is an order of magnitude faster than npm's for the trees it can
 * resolve. The install command below runs nub FIRST and falls back to npm on
 * any nonzero exit or when nub is absent — nub's resolver is stricter than
 * npm's (observed live: react-dom@19.2.x's `scheduler@^0.27.0` has no stable
 * satisfying version, npm accommodates, nub refuses), and the host/dev/seeder
 * lanes may not have nub installed at all. npm reconciles whatever a failed
 * nub attempt left behind, so the fallback is always safe. The container lane
 * installs this pin in its toolchain step (build-backend.ts).
 */
export const NUB_VERSION = "0.4.13";
export const BUILD_TOOLCHAIN_VERSION = `wrangler@${WRANGLER_VERSION}+nub@${NUB_VERSION}`;

/**
 * Everything the recipe generates lives under this reserved name prefix in
 * the build directory, so generated files can never collide with (or be
 * shadowed by) source files — source files claiming the prefix are rejected
 * instead.
 */
const RESERVED_PREFIX = ".iterate-build";
const CONFIG_FILE = `${RESERVED_PREFIX}.wrangler.jsonc`;
const VIRTUAL_MODULE_DIR = `${RESERVED_PREFIX}.virtual`;
const OUTPUT_DIR = `${RESERVED_PREFIX}.out`;
const ENTRY_SHIM_FILE = `${RESERVED_PREFIX}.entry.ts`;

/** Hard per-command bounds on container/host work — independent of the
 * caller's buildBudgetMs race, which keeps working unchanged (past budget the
 * caller serves the building page while the build finishes into the cache). */
const NPM_INSTALL_TIMEOUT_MS = 150_000;
const BUNDLE_TIMEOUT_MS = 90_000;
/** The vite lane installs devDependencies (a react+vite tree is heavier) and
 * runs a real framework build; both get wider hard bounds. */
const VITE_INSTALL_TIMEOUT_MS = 240_000;
const VITE_BUILD_TIMEOUT_MS = 240_000;
/** Where the vite lane's collected outputs live and the wrapper module the
 * collector generates around them. */
const VITE_OUTPUT_DIR = "dist";
const ENTRY_WRAPPER_MODULE = `${RESERVED_PREFIX}.entry.js`;
const VITE_ASSETS_MODULE = `${RESERVED_PREFIX}.assets.js`;

export type WorkerBuildRecipe = {
  /** Which lane produced this recipe — runners pick output collection by it:
   * "wrangler" outputs are a flat outputDir (collectRecipeOutputs), "vite"
   * outputs are the nested dist/ tree (collectViteRecipeOutputs). */
  pipeline: "wrangler" | "vite";
  /** Shell commands, run in order in the build directory. Fixed strings by
   * construction — nothing user-controlled is ever interpolated into one. */
  commands: { command: string; timeoutMs: number }[];
  /** Everything to write into the build directory before running commands:
   * the source files plus the generated wrangler config and materialized
   * virtual modules. Paths are validated relative paths. */
  files: Record<string, string>;
  /** The module name the bundle's entry emits as inside {@link outputDir}. */
  mainModule: string;
  /** Directory (relative to the build directory) the bundle lands in. */
  outputDir: string;
};

/**
 * Build a worker source snapshot into loader-ready modules:
 *
 * 1. `npm install --ignore-scripts --omit=dev` — only when the snapshot has a
 *    `package.json`. Real npm: every dependency npm can resolve just works,
 *    lockfiles are honored, and `--ignore-scripts` keeps build INPUTS from
 *    executing code during a build the platform runs on the project's behalf.
 * 2. `wrangler deploy --dry-run` — wrangler's bundling is the canonical
 *    nodejs_compat pipeline (node-builtin externalization, CJS require
 *    interop, unenv aliases), i.e. exactly what production workers get, so
 *    there is no shim list to maintain.
 *
 * Compatibility date/flags are deliberately NOT read from any wrangler config
 * in the source snapshot: OS owns dynamic-worker compatibility (the constants
 * above, hashed into every build key). The generated config is the only one
 * the build reads.
 */
export function workerBuildRecipe(input: {
  files: Record<string, string>;
  options: WorkerBuildOptions;
}): WorkerBuildRecipe {
  if (input.options.bundle === false) {
    // Loader-ready inline JavaScript short-circuits in worker-loader.ts and
    // never reaches a build; anything else asking for no-bundle has no
    // meaning under this pipeline.
    throw new Error("bundle: false requires loader-ready inline JavaScript files.");
  }
  const files = applyRootDir(input.files, input.options.rootDir);
  for (const name of Object.keys(files)) assertSafeSourcePath(name);
  if (input.options.pipeline === "vite") {
    return viteAppRecipe(files);
  }
  return wranglerRecipe({ files, options: input.options });
}

/** Re-root the file map at `rootDir` (a repo can host an app in a
 * subdirectory with its own package.json/config); files outside it drop. */
function applyRootDir(
  files: Record<string, string>,
  rootDir: string | undefined,
): Record<string, string> {
  if (rootDir === undefined) return files;
  const prefix = `${rootDir.replace(/^\/+|\/+$/g, "")}/`;
  const rooted = Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, content]) => [name.slice(prefix.length), content]),
  );
  if (Object.keys(rooted).length === 0) {
    throw new Error(`rootDir "${rootDir}" matches no files in the worker source.`);
  }
  return rooted;
}

/**
 * The "vite" pipeline: the source is a real Vite/TanStack-Start app that owns
 * its build — `npm install` (WITH devDependencies; vite lives there) then the
 * app's own `npm run build`, expected to produce the @cloudflare/vite-plugin
 * layout (dist/server worker modules + dist/client browser assets). Unlike
 * the wrangler lane, the build EXECUTES project code (vite config, plugins,
 * the app's build script) inside the builder container — which is why
 * runtime artifacts are project-scoped (build-key.ts). The one exception is
 * the repo-owned, deterministic fresh-project template, which deploy builds
 * itself into the trusted tier. Outputs are collected by collectViteRecipeOutputs,
 * which wraps the built worker with a generated entry that serves the client assets.
 */
function viteAppRecipe(files: Record<string, string>): WorkerBuildRecipe {
  const packageJson = files["package.json"];
  if (packageJson === undefined) {
    throw new Error('The "vite" pipeline needs a package.json with a build script.');
  }
  let hasBuildScript = false;
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
    hasBuildScript = typeof parsed.scripts?.build === "string";
  } catch {
    // The install step will fail on the malformed manifest with npm's own,
    // clearer error.
    hasBuildScript = true;
  }
  if (!hasBuildScript) {
    throw new Error('The "vite" pipeline needs a "build" script in package.json.');
  }
  return {
    commands: [
      {
        // Same nub-first shape as the wrangler lane but WITHOUT --prod /
        // --omit=dev: vite and the app's build tooling are devDependencies.
        // --ignore-scripts still blocks install-time lifecycle scripts; the
        // build script below is where project code deliberately runs.
        command:
          "{ command -v nub >/dev/null && timeout -k 5 60 nub install --ignore-scripts --prefer-offline --node-linker hoisted; } || npm install --ignore-scripts --no-audit --no-fund --prefer-offline",
        timeoutMs: VITE_INSTALL_TIMEOUT_MS,
      },
      {
        command: "npm run build",
        timeoutMs: VITE_BUILD_TIMEOUT_MS,
      },
    ],
    files: {
      ...files,
      // devDependencies stay: this lane installs them (see above).
    },
    mainModule: ENTRY_WRAPPER_MODULE,
    outputDir: VITE_OUTPUT_DIR,
    pipeline: "vite",
  };
}

function wranglerRecipe(input: {
  files: Record<string, string>;
  options: WorkerBuildOptions;
}): WorkerBuildRecipe {
  const entryPoint = input.options.entryPoint ?? "worker.ts";
  if (!(entryPoint in input.files)) {
    throw new Error(`Entry point "${entryPoint}" is not in the worker source files.`);
  }

  // Wrangler infers the worker FORMAT from the entry: no default export means
  // "service-worker format", which then rejects `cloudflare:workers` imports.
  // Dynamic workers legitimately export only named entrypoints / Durable
  // Object classes, so EVERY build goes through a generated shim entry that
  // re-exports the real entry and forwards (or supplies) its default.
  // Unconditional on purpose: any syntactic detection of "has a default
  // export" misclassifies strings/comments/re-export chains, and the shim is
  // correct either way (`export *` carries the named exports; the explicit
  // default line carries a real default when one exists).
  const entrySpecifier = JSON.stringify(`./${entryPoint}`);
  const entryShim: Record<string, string> = {
    [ENTRY_SHIM_FILE]: [
      `import * as entry from ${entrySpecifier};`,
      `export * from ${entrySpecifier};`,
      `export default (entry as { default?: unknown }).default ?? {};`,
      ``,
    ].join("\n"),
  };

  const virtualModules = Object.entries(input.options.virtualModules ?? {});
  const alias = Object.fromEntries(
    virtualModules.map(([specifier], index) => [
      specifier,
      `./${VIRTUAL_MODULE_DIR}/${virtualModuleFileName(specifier, index)}`,
    ]),
  );

  const config = {
    name: "dynamic-worker-build",
    main: ENTRY_SHIM_FILE,
    compatibility_date: WORKER_COMPATIBILITY_DATE,
    compatibility_flags: WORKER_COMPATIBILITY_FLAGS,
    ...(virtualModules.length > 0 ? { alias } : {}),
    ...(input.options.minify !== undefined ? { minify: input.options.minify } : {}),
  };

  return {
    commands: [
      ...("package.json" in input.files
        ? [
            {
              // nub first (pinned in the container toolchain; an order of
              // magnitude faster and flag-compatible: --ignore-scripts is the
              // same security property, --prod = --omit=dev, lockfiles are
              // honored, --node-linker hoisted keeps npm's physical layout),
              // npm as the fallback for a nub failure or a lane without nub —
              // see NUB_VERSION above. npm's --prefer-offline: resolve from
              // the runner's cache without registry freshness checks — on a
              // warm builder-pool member this is the difference between ~23s
              // and a few seconds per build, and delivery to a freshly
              // committed worker waits on exactly this step. (NOT
              // --no-package-lock: that would also stop npm READING a
              // committed lockfile, and lockfiles are honored here.)
              // nub carries its OWN inner 30s timeout so a hung nub cannot
              // starve the fallback out of the step's shared budget — the
              // fast lane either wins fast or yields. A host without
              // coreutils `timeout` (macOS dev machines) fails the left side
              // harmlessly into npm.
              command:
                "{ command -v nub >/dev/null && timeout -k 5 30 nub install --ignore-scripts --prod --prefer-offline --node-linker hoisted; } || npm install --ignore-scripts --no-audit --no-fund --omit=dev --prefer-offline",
              timeoutMs: NPM_INSTALL_TIMEOUT_MS,
            },
          ]
        : []),
      {
        // --dry-run needs no account or network; WRANGLER_SEND_METRICS keeps
        // it from phoning home from inside build environments.
        command: `WRANGLER_SEND_METRICS=false wrangler deploy --dry-run --outdir '${OUTPUT_DIR}' --config '${CONFIG_FILE}'`,
        timeoutMs: BUNDLE_TIMEOUT_MS,
      },
    ],
    files: {
      ...input.files,
      ...("package.json" in input.files
        ? { "package.json": withoutDevDependencies(input.files["package.json"]!) }
        : {}),
      ...entryShim,
      [CONFIG_FILE]: JSON.stringify(config, null, 2),
      ...Object.fromEntries(
        virtualModules.map(([specifier, source], index) => [
          `${VIRTUAL_MODULE_DIR}/${virtualModuleFileName(specifier, index)}`,
          source,
        ]),
      ),
    },
    mainModule: entryEmitName(ENTRY_SHIM_FILE),
    outputDir: OUTPUT_DIR,
    pipeline: "wrangler",
  };
}

/**
 * The build tree's package.json, with devDependencies removed. The build
 * installs production dependencies only (--prod / --omit=dev), so dev entries
 * are dead weight at best — and at worst they break the fast install lane
 * outright: every seeded project repo carries the `iterate` devDependency as
 * a pkg.pr.new URL, whose packument nub insists on resolving even under
 * --prod (npm merely skips it). Malformed JSON passes through untouched; the
 * install step then fails on it with npm's own error, which is the clearer
 * message and the same genuine-build-failure classification.
 */
function withoutDevDependencies(packageJson: string): string {
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return packageJson;
    delete parsed.devDependencies;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return packageJson;
  }
}

/**
 * Validate and shape what a runner read back from the recipe's output
 * directory into the artifact's module map. Wrangler emits the bundle plus
 * artifacts the loader must not serve (sourcemaps, its own README); anything
 * else non-JS means the build produced output this pipeline cannot store as
 * text modules — refused loudly rather than stored corrupted.
 */
export function collectRecipeOutputs(
  recipe: WorkerBuildRecipe,
  outputs: Record<string, string>,
): { mainModule: string; modules: Record<string, string> } {
  const modules: Record<string, string> = {};
  for (const [name, content] of Object.entries(outputs)) {
    if (name.endsWith(".map") || name === "README.md") continue;
    if (!name.endsWith(".js") && !name.endsWith(".mjs")) {
      throw new Error(
        `Worker build produced module "${name}" in an unsupported format; ` +
          `only text JavaScript modules are storable today.`,
      );
    }
    modules[name] = content;
  }
  if (!(recipe.mainModule in modules)) {
    throw new Error(
      `Worker build did not produce the entry module "${recipe.mainModule}" ` +
        `(got: ${Object.keys(modules).join(", ") || "nothing"}).`,
    );
  }
  return { mainModule: recipe.mainModule, modules };
}

/**
 * Shape the vite lane's collected `dist/` tree into loader-ready modules:
 * `dist/server/**` JavaScript is kept verbatim (path-preserved, so the built
 * entry's relative chunk imports keep resolving), `dist/client/**` becomes a
 * generated assets module, and a generated wrapper entry serves those assets
 * ahead of the built worker's own fetch while re-exporting its named exports
 * (Durable Object classes included) for stateful hosting.
 *
 * Text assets only: the worker loader stores text modules, so a binary
 * client asset (png/ico/woff) is a build failure with a clear message — the
 * minimal seeded app ships none, and real ones belong in project files/R2.
 */
export function collectViteRecipeOutputs(outputs: Record<string, string>): {
  mainModule: string;
  modules: Record<string, string>;
} {
  const SERVER_ENTRY = "dist/server/index.js";
  const modules: Record<string, string> = {};
  const assets: Record<string, { contentType: string; body: string }> = {};
  for (const [name, content] of Object.entries(outputs)) {
    if (name.startsWith("dist/server/")) {
      if (name.endsWith(".map") || name.includes("/.vite/") || name.endsWith("wrangler.json")) {
        continue;
      }
      if (!name.endsWith(".js") && !name.endsWith(".mjs")) continue;
      modules[name] = content;
      continue;
    }
    if (name.startsWith("dist/client/")) {
      const path = name.slice("dist/client".length);
      if (path === "/.assetsignore" || name.endsWith(".map")) continue;
      const contentType = ASSET_CONTENT_TYPES[name.slice(name.lastIndexOf(".") + 1)];
      if (contentType === undefined) {
        throw new Error(
          `Client asset "${name}" is not a text type the dynamic worker lane can serve; ` +
            `text assets only (js, css, html, svg, json, txt).`,
        );
      }
      assets[path] = { contentType, body: content };
    }
  }
  if (!(SERVER_ENTRY in modules)) {
    throw new Error(
      `Vite build did not produce "${SERVER_ENTRY}" ` +
        `(got: ${Object.keys(modules).join(", ") || "nothing"}); ` +
        `the "vite" pipeline expects a @cloudflare/vite-plugin build.`,
    );
  }
  modules[VITE_ASSETS_MODULE] = `export const ASSETS = ${JSON.stringify(assets)};`;
  modules[ENTRY_WRAPPER_MODULE] = [
    `import * as server from "./${SERVER_ENTRY}";`,
    `import { ASSETS } from "./${VITE_ASSETS_MODULE}";`,
    `export * from "./${SERVER_ENTRY}";`,
    `const fallback = server.default;`,
    `export default {`,
    `  async fetch(request, env, ctx) {`,
    `    const url = new URL(request.url);`,
    `    const asset = ASSETS[url.pathname];`,
    `    if (asset !== undefined && (request.method === "GET" || request.method === "HEAD")) {`,
    `      return new Response(request.method === "HEAD" ? null : asset.body, {`,
    `        headers: {`,
    `          "cache-control": "public, max-age=31536000, immutable",`,
    `          "content-type": asset.contentType,`,
    `        },`,
    `      });`,
    `    }`,
    `    return fallback.fetch(request, env, ctx);`,
    `  },`,
    `};`,
  ].join("\n");
  return { mainModule: ENTRY_WRAPPER_MODULE, modules };
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  mjs: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
};

/** Wrangler emits the entry under its own base name with a `.js` extension
 * (nested entry directories do not survive into the outdir). */
function entryEmitName(entryPoint: string): string {
  const base = entryPoint.split("/").at(-1)!;
  return `${base.replace(/\.(ts|tsx|js|jsx|mjs|mts)$/, "")}.js`;
}

function virtualModuleFileName(specifier: string, index: number): string {
  // The index guarantees uniqueness; the sanitized specifier is for humans
  // reading a build directory.
  return `${specifier.replaceAll(/[^A-Za-z0-9_-]+/g, "-")}-${index}.js`;
}

/**
 * Source file names come from user content and are written to disk by the
 * runners — they must be plain relative paths that stay inside the build
 * directory, and must not claim the recipe's reserved generated names.
 */
function assertSafeSourcePath(name: string): void {
  if (name.length === 0 || name.includes("\0") || name.includes("\\")) {
    throw new Error(`Worker source file name ${JSON.stringify(name)} is not a safe path.`);
  }
  if (name.startsWith("/")) {
    throw new Error(`Worker source file name "${name}" must be relative.`);
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Worker source file name "${name}" must not traverse directories.`);
  }
  if (segments[0]!.startsWith(RESERVED_PREFIX)) {
    throw new Error(
      `Worker source file name "${name}" collides with the build pipeline's reserved "${RESERVED_PREFIX}*" names.`,
    );
  }
}
