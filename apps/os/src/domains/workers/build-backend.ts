import type { CreateWorkerResult, Modules } from "@cloudflare/worker-bundler";
import { buildFailureMessageFromError, WorkerBuildFailedError } from "./artifact-store.ts";
import { ITERATE_LIVE_STATE_VIRTUAL_MODULE } from "./iterate-live-state-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE } from "./iterate-processors-cloudflare-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_VIRTUAL_MODULE } from "./iterate-processors-virtual-module.generated.ts";
import { ITERATE_SDK_VIRTUAL_MODULE } from "./iterate-sdk-virtual-module.generated.ts";
import type { WorkerBuildOptions } from "./schemas.ts";

/** Keep this pin in sync with apps/os/package.json. It participates in every
 * build key so a bundler upgrade cannot reuse artifacts made by older code. */
export const WORKER_BUNDLER_VERSION = "0.2.1";

/** Dynamic-worker compatibility moves independently from the OS worker. */
export const WORKER_COMPATIBILITY_DATE = "2026-05-01";
export const WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"];

const PLATFORM_VIRTUAL_MODULES = {
  "iterate/live-state": ITERATE_LIVE_STATE_VIRTUAL_MODULE,
  "iterate/sdk": ITERATE_SDK_VIRTUAL_MODULE,
  "iterate/processors": ITERATE_PROCESSORS_VIRTUAL_MODULE,
  "iterate/processors/cloudflare": ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE,
};

/** Apply platform-owned defaults before hashing or building ordinary Workers. */
export function canonicalWorkerBuildOptions(options: WorkerBuildOptions): WorkerBuildOptions {
  const canonical = {
    ...options,
    entryPoint: options.entryPoint ?? "worker.ts",
  };
  if (options.clientEntryPoint !== undefined) {
    return options.bundle === true ? canonical : { ...canonical, bundle: false };
  }
  return {
    ...canonical,
    virtualModules: {
      ...PLATFORM_VIRTUAL_MODULES,
      ...options.virtualModules,
    },
  };
}

/**
 * Build one dynamic Worker directly in workerd. OS only re-roots monorepo
 * input, supplies the platform virtual modules for ordinary Workers, and
 * converts worker-bundler's output to the text format used by the artifact
 * cache and Worker Loader.
 */
export async function executeWorkerBuild(input: {
  files: Record<string, string>;
  options: WorkerBuildOptions;
}): Promise<{
  assets: Record<string, string>;
  mainModule: string;
  modules: Record<string, string>;
}> {
  try {
    if (input.options.bundle === false && input.options.clientEntryPoint === undefined) {
      // Loader-ready inline JavaScript short-circuits before reaching this
      // function. Transforming repo sources would ignore virtual modules.
      throw new Error("bundle: false requires loader-ready inline JavaScript files.");
    }

    if (input.options.clientEntryPoint !== undefined) {
      if (input.options.bundle !== false) {
        throw new Error("clientEntryPoint requires bundle: false.");
      }
      const virtualModuleNames = Object.keys(input.options.virtualModules ?? {});
      if (virtualModuleNames.length > 0) {
        throw new Error(
          "clientEntryPoint does not support custom virtualModules; " +
            `remove: ${virtualModuleNames.sort().join(", ")}`,
        );
      }
    }

    const files = applyRootDir(input.files, input.options.rootDir);
    if (input.options.clientEntryPoint !== undefined) {
      if ((input.options.entryPoint ?? "worker.ts") !== "server.tsx") {
        throw new Error('clientEntryPoint requires entryPoint: "server.tsx".');
      }
      const unexpectedFiles = Object.keys(files).filter(
        (name) => name !== "client.tsx" && name !== "server.tsx",
      );
      if (unexpectedFiles.length > 0) {
        throw new Error(
          "The basic app path accepts only server.tsx and client.tsx; " +
            `remove: ${unexpectedFiles.sort().join(", ")}`,
        );
      }
    }
    const { createApp, createWorker } = await import("@cloudflare/worker-bundler");
    let assets: Record<string, string> = {};
    let result: CreateWorkerResult;
    if (input.options.clientEntryPoint === undefined) {
      result = await createWorker({
        entryPoint: input.options.entryPoint ?? "worker.ts",
        files,
        ...(input.options.minify === undefined ? {} : { minify: input.options.minify }),
        virtualModules: input.options.virtualModules,
      });
    } else {
      const appResult = await createApp({
        // There is one server file, so strip its TypeScript without bundling.
        // Only the local client TSX is bundled for the browser.
        bundle: false,
        client: input.options.clientEntryPoint,
        // Keep browser dependencies as native URL imports instead of copying
        // React (or anything else from esm.sh) into the asset.
        externals: ["https://esm.sh/"],
        files,
        ...(input.options.minify === undefined ? {} : { minify: input.options.minify }),
        server: input.options.entryPoint ?? "worker.ts",
      });
      result = appResult;
      assets = loaderReadyAssets(appResult.assets);
    }
    if (result.warnings !== undefined && result.warnings.length > 0) {
      throw new Error(`worker-bundler returned warnings:\n${result.warnings.join("\n")}`);
    }
    if (input.options.clientEntryPoint !== undefined) {
      const assetNames = Object.keys(assets).sort();
      if (assetNames.length !== 1 || assetNames[0] !== "/client.js") {
        throw new Error(
          "The basic app path must produce exactly /client.js; " +
            `worker-bundler produced: ${assetNames.join(", ") || "no assets"}`,
        );
      }
    }
    return {
      assets,
      mainModule: result.mainModule,
      modules: loaderReadyModules(result.modules),
    };
  } catch (error) {
    throw new WorkerBuildFailedError(buildFailureMessageFromError(error), { cause: error });
  }
}

/** The app path intentionally supports only browser source bundles today. */
function loaderReadyAssets(assets: Record<string, string | ArrayBuffer>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [pathname, content] of Object.entries(assets)) {
    if (typeof content !== "string") {
      throw new Error(
        `Worker app produced binary asset "${pathname}"; only text client bundles are supported.`,
      );
    }
    result[pathname] = content;
  }
  return result;
}

/** Re-root a repository snapshot at one app directory. */
export function applyRootDir(
  files: Record<string, string>,
  rootDir: string | undefined,
): Record<string, string> {
  if (rootDir === undefined) return files;
  const normalized = rootDir.replace(/^\/+|\/+$/g, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\\") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`rootDir ${JSON.stringify(rootDir)} is not a safe relative directory.`);
  }
  const prefix = `${normalized}/`;
  const rooted: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    if (name.startsWith(prefix)) rooted[name.slice(prefix.length)] = content;
  }
  if (Object.keys(rooted).length === 0) {
    throw new Error(`rootDir "${rootDir}" matches no files in the worker source.`);
  }
  return rooted;
}

/** Worker Loader artifacts currently store text modules only. */
function loaderReadyModules(modules: Modules): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module === "string") {
      result[name] = module;
    } else if (typeof module.js === "string") {
      result[name] = module.js;
    } else if (typeof module.text === "string") {
      result[name] = module.text;
    } else {
      throw new Error(
        `Worker build produced module "${name}" in an unsupported format ` +
          `(${Object.keys(module).join(", ") || "empty"}); only text modules are storable today.`,
      );
    }
  }
  return result;
}
