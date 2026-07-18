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
export const BUILD_TOOLCHAIN_VERSION = `wrangler@${WRANGLER_VERSION}`;

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

export type WorkerBuildRecipe = {
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
  for (const name of Object.keys(input.files)) assertSafeSourcePath(name);

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
              command: "npm install --ignore-scripts --no-audit --no-fund --omit=dev",
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
  };
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
