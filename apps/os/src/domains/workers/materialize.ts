import type { Modules } from "@cloudflare/worker-bundler";
import type { WorkerBuildOptions } from "../../types.ts";
import { workerBuildOptionsMatchCloudflare } from "./schemas.ts";

export type MaterializedWorkerBuild = {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  warnings: string[];
};

/**
 * The one materialization pipeline for dynamic worker source: resolve the file
 * source to a file map elsewhere, then turn it into loader-ready modules here
 * through Cloudflare's bundler. `bundle: false` still comes through this path
 * (transform-only mode); the invariant is one pipeline, not one output file.
 *
 * `@cloudflare/worker-bundler` bundles via an esbuild-wasm module import that
 * only the Workers module loader can resolve, so this import stays dynamic:
 * Node-side unit tests can import this module's callers without dragging the
 * wasm in, and only workerd executes builds.
 */
export async function materializeWorkerBuild(input: {
  files: Record<string, string>;
  options: WorkerBuildOptions;
}): Promise<MaterializedWorkerBuild> {
  const { createWorker } = await import("@cloudflare/worker-bundler");
  const result = await createWorker({
    ...workerBuildOptionsMatchCloudflare(input.options),
    files: input.files,
  });
  return {
    compatibilityDate: result.wranglerConfig?.compatibilityDate,
    compatibilityFlags: result.wranglerConfig?.compatibilityFlags,
    mainModule: result.mainModule,
    modules: loaderReadyModules(result.modules),
    warnings: result.warnings ?? [],
  };
}

/**
 * The artifact store and Worker Loader path carry plain text modules. The
 * bundler can emit richer module records; `js` records are text modules by
 * another name, everything else (binary data, cjs, json) is refused loudly
 * rather than stored corrupted.
 */
function loaderReadyModules(modules: Modules): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module === "string") {
      result[name] = module;
      continue;
    }
    if (typeof module.js === "string") {
      result[name] = module.js;
      continue;
    }
    if (typeof module.text === "string") {
      result[name] = module.text;
      continue;
    }
    throw new Error(
      `Worker build produced module "${name}" in an unsupported format ` +
        `(${Object.keys(module).join(", ") || "empty"}); only text modules are storable today.`,
    );
  }
  return result;
}
