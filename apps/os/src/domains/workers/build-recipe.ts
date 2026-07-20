import type { WorkerBuildOptions } from "./schemas.ts";
import { ITERATE_LIVE_STATE_VIRTUAL_MODULE } from "./iterate-live-state-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE } from "./iterate-processors-cloudflare-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_VIRTUAL_MODULE } from "./iterate-processors-virtual-module.generated.ts";
import { ITERATE_SDK_VIRTUAL_MODULE } from "./iterate-sdk-virtual-module.generated.ts";

/**
 * Pure preparation for a dynamic-worker build. The runtime calls
 * `@cloudflare/worker-bundler` (`createWorker` / `createApp`) with this
 * prepared input inside workerd — there is no shell recipe, container, or
 * host toolchain path.
 *
 * This module stays free of env and I/O so node-side unit tests can exercise
 * option canonicalization and path rules without workerd.
 */

/**
 * The one options canonicalization, applied BEFORE the build key is computed
 * (options are hashed into the key wholesale). Defaults live here so
 * differently-spelled equivalent refs hash to ONE key:
 *
 * - `entryPoint` defaults to "worker.ts".
 * - Platform virtual modules are injected: every bundled build can
 *   `import ... from "iterate/sdk"` / `"iterate/processors"` — the runtime
 *   pinned to this deployment. A source supplying its own entry for a
 *   specifier wins.
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
 * The bundler pin that IS the build toolchain. Hashed into every build key so
 * a package bump invalidates cached artifacts instead of serving output from
 * an older esbuild-wasm.
 */
export const WORKER_BUNDLER_VERSION = "0.2.1";
export const BUILD_TOOLCHAIN_VERSION = `@cloudflare/worker-bundler@${WORKER_BUNDLER_VERSION}`;

/**
 * Package-export conditions for every dynamic-worker bundle. Prefer workerd
 * over browser so React and other dual packages resolve server-capable
 * entrypoints (e.g. `react-dom/server.edge`) when importers leave conditions
 * to the bundler.
 */
export const WORKER_BUNDLER_CONDITIONS = [
  "workerd",
  "worker",
  "import",
  "module",
  "browser",
  "default",
] as const;

/** Prepared input for {@link executeWorkerBuild} in build-backend.ts. */
export type PreparedWorkerBuild =
  | {
      kind: "worker";
      entryPoint: string;
      files: Record<string, string>;
      minify: boolean;
    }
  | {
      kind: "app";
      client: string;
      files: Record<string, string>;
      minify: boolean;
      server: string;
    };

/**
 * Validate and shape a source snapshot into the exact arguments worker-bundler
 * needs. Rejects unsafe paths and missing entries up front so failures are
 * deterministic build failures rather than opaque bundler messages.
 */
export function prepareWorkerBuild(input: {
  files: Record<string, string>;
  options: WorkerBuildOptions;
}): PreparedWorkerBuild {
  if (input.options.bundle === false) {
    // Loader-ready inline JavaScript short-circuits in worker-loader.ts and
    // never reaches a build; anything else asking for no-bundle has no
    // meaning under this pipeline.
    throw new Error("bundle: false requires loader-ready inline JavaScript files.");
  }
  const files = applyRootDir(input.files, input.options.rootDir);
  for (const name of Object.keys(files)) assertSafeSourcePath(name);

  const entryPoint = input.options.entryPoint ?? "worker.ts";
  if (!(entryPoint in files)) {
    throw new Error(`Entry point "${entryPoint}" is not in the worker source files.`);
  }

  const virtualModules = input.options.virtualModules ?? {};
  const minify = input.options.minify === true;
  const client = input.options.client;

  // createApp's public options omit virtualModules even though createWorker
  // accepts them. Materialising platform modules into the virtual node_modules
  // tree keeps one preparation path for both lanes (and is what the bundler's
  // package resolver already understands).
  const filesWithVirtuals = materializeVirtualModules(files, virtualModules);

  if (client !== undefined) {
    if (!(client in files)) {
      throw new Error(`Client entry "${client}" is not in the worker source files.`);
    }
    return {
      kind: "app",
      client,
      files: filesWithVirtuals,
      minify,
      server: entryPoint,
    };
  }

  return {
    kind: "worker",
    entryPoint,
    files: filesWithVirtuals,
    minify,
  };
}

/**
 * Write platform virtual modules into a virtual `node_modules` layout so both
 * createWorker and createApp resolve them as ordinary packages. Specifiers are
 * package subpaths (`iterate/sdk` → package `iterate`, export `./sdk`). A
 * source file already present under the same path wins (caller-supplied
 * virtualModules / package content take precedence).
 */
function materializeVirtualModules(
  files: Record<string, string>,
  virtualModules: Record<string, string>,
): Record<string, string> {
  if (Object.keys(virtualModules).length === 0) return files;
  const out: Record<string, string> = { ...files };
  const packages = new Map<
    string,
    { exports: Record<string, string>; files: Record<string, string> }
  >();

  for (const [specifier, source] of Object.entries(virtualModules)) {
    const slash = specifier.indexOf("/");
    if (slash <= 0 || specifier.startsWith("@")) {
      // Scoped packages and bare names are uncommon for platform modules; keep
      // the rule simple and refuse anything that is not `pkg/subpath`.
      throw new Error(
        `virtual module specifier ${JSON.stringify(specifier)} must look like "package/subpath"`,
      );
    }
    const packageName = specifier.slice(0, slash);
    const subpath = specifier.slice(slash + 1);
    const fileName = `${subpath.replaceAll("/", "-")}.js`;
    let pkg = packages.get(packageName);
    if (pkg === undefined) {
      pkg = { exports: {}, files: {} };
      packages.set(packageName, pkg);
    }
    pkg.exports[`./${subpath}`] = `./${fileName}`;
    pkg.files[fileName] = source;
  }

  for (const [packageName, pkg] of packages) {
    const packageJsonPath = `node_modules/${packageName}/package.json`;
    if (!(packageJsonPath in out)) {
      out[packageJsonPath] = JSON.stringify(
        {
          name: packageName,
          type: "module",
          exports: pkg.exports,
        },
        null,
        2,
      );
    }
    for (const [fileName, source] of Object.entries(pkg.files)) {
      const path = `node_modules/${packageName}/${fileName}`;
      if (!(path in out)) out[path] = source;
    }
  }
  return out;
}

/** Re-root the file map at `rootDir` (a repo can host an app in a
 * subdirectory with its own package.json/config); files outside it drop. */
export function applyRootDir(
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
 * Source file names come from user content and are materialised into the
 * bundler's virtual filesystem — they must be plain relative paths that stay
 * inside the project root.
 */
export function assertSafeSourcePath(name: string): void {
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
}
