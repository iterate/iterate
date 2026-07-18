import type { WorkerBuildOptions } from "./schemas.ts";
import { ITERATE_LIVE_STATE_VIRTUAL_MODULE } from "./iterate-live-state-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE } from "./iterate-processors-cloudflare-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_VIRTUAL_MODULE } from "./iterate-processors-virtual-module.generated.ts";
import { ITERATE_SDK_VIRTUAL_MODULE } from "./iterate-sdk-virtual-module.generated.ts";

/**
 * The one dynamic-worker build recipe, shared verbatim by every runner: the
 * deployment build service (deployed envs), the vite dev server's
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
 * The fixed platform toolchain. These pins participate in every build key:
 * nub is the lockless fast path, pnpm is its fixed fallback/default for pnpm
 * projects, and wrangler owns the production-shaped bundle. The stock
 * container backend installs all three with Bun into a shared versioned
 * directory on first use; none is baked into the image.
 *
 * The wrangler pin must agree with apps/os's own `wrangler` devDependency
 * (the host/dev runner and deploy seeder — asserted by build-key.test.ts).
 * esbuild rides inside wrangler; there is no separate bundler pin.
 */
export const WRANGLER_VERSION = "4.107.0";
export const PNPM_VERSION = "10.24.0";

/**
 * The nub pin (https://github.com/nubjs/nub): a Rust package manager whose
 * `install` is an order of magnitude faster than npm's for the trees it can
 * resolve. The install command below runs nub first and falls back to pnpm on
 * any nonzero exit or when nub is absent — nub's resolver is stricter than
 * pnpm's, and the host/dev/seeder lanes may not have nub installed at all.
 * Pinned pnpm reconciles whatever a failed nub attempt left behind. An
 * explicit npm lockfile still selects npm so its package-manager semantics
 * remain intact. The container adapter installs all three fixed tool pins.
 */
export const NUB_VERSION = "0.4.13";
export const BUILD_TOOLCHAIN_VERSION = `wrangler@${WRANGLER_VERSION};pnpm@${PNPM_VERSION};nub@${NUB_VERSION}`;

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
const DEPENDENCY_INSTALL_TIMEOUT_MS = 150_000;
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
 * 1. Install production dependencies only when the snapshot has a
 *    `package.json`. Lockless sources try nub then pinned pnpm; pnpm projects
 *    reuse the builder member's content-addressed store. A committed npm
 *    lockfile deliberately selects npm so its semantics remain intact. Every
 *    lane ignores lifecycle scripts: build INPUTS never execute code on the
 *    platform's behalf.
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
              // Honor explicit lockfile semantics. Lockless sources try nub's
              // fast lane first, then pinned pnpm. The inner nub timeout keeps
              // a hung fast path from consuming the whole dependency budget;
              // on hosts without nub/coreutils (including macOS dev), the
              // group simply falls through to pnpm. Every lane ignores source
              // lifecycle scripts and installs production dependencies only.
              command:
                "if [ -f pnpm-lock.yaml ]; then pnpm install --prod --ignore-scripts --prefer-offline --frozen-lockfile; elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm install --ignore-scripts --no-audit --no-fund --omit=dev --prefer-offline; else { command -v nub >/dev/null && timeout -k 5 30 nub install --ignore-scripts --prod --prefer-offline --node-linker hoisted; } || pnpm install --prod --ignore-scripts --prefer-offline --no-frozen-lockfile; fi",
              timeoutMs: DEPENDENCY_INSTALL_TIMEOUT_MS,
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
      ...("package.json" in input.files && !hasDependencyLockfile(input.files)
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
  };
}

/**
 * The lockless fast path's package.json, with devDependencies removed. They
 * are dead weight in a production-only install and can make nub resolve a
 * pkg.pr.new dev entry even under --prod. Locked projects retain their exact
 * manifest so frozen pnpm/npm lockfile validation keeps its normal semantics.
 * Malformed JSON passes through for the installer to classify clearly.
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

function hasDependencyLockfile(files: Record<string, string>): boolean {
  return (
    "pnpm-lock.yaml" in files || "package-lock.json" in files || "npm-shrinkwrap.json" in files
  );
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
