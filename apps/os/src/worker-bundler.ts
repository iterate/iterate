/**
 * Isolated dynamic-worker compiler. Source text goes in over RPC and
 * loader-ready text comes back; this is the only OS script that imports
 * @cloudflare/worker-bundler (and its esbuild Wasm compiler).
 */
import {
  createMemoryStorage,
  createApp as workerBundlerCreateApp,
  createWorker as workerBundlerCreateWorker,
  handleAssetRequest as workerBundlerHandleAssetRequest,
  type CreateAppResult,
  type CreateWorkerResult,
  type Modules,
} from "@cloudflare/worker-bundler";
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  WorkerBuildAssetMetadata,
  WorkerBuildModule,
  WorkerBuildWranglerConfig,
} from "./domains/workers/artifact-store.ts";
import type {
  WorkerBundlerAssetConfig,
  WorkerBundlerCreateAppOptions,
  WorkerBundlerCreateWorkerOptions,
} from "./domains/workers/schemas.ts";

type WorkerBundlerCreateWorkerResult = {
  mainModule: string;
  modules: Record<string, WorkerBuildModule>;
  warnings: string[];
  wranglerConfig?: WorkerBuildWranglerConfig;
};

type WorkerBundlerCreateAppResult = WorkerBundlerCreateWorkerResult & {
  assetConfig?: WorkerBundlerAssetConfig;
  assetManifest: Record<string, WorkerBuildAssetMetadata>;
  assets: Record<string, string>;
};

type WorkerBundlerBuildResult<T> = { error: string } | { result: T };

/** RPC-only entrypoint: inert source values in, loader-ready text out. */
export default class WorkerBundlerEntrypoint extends WorkerEntrypoint {
  override fetch(): Response {
    return Response.json({ worker: "os-worker-bundler" }, { status: 404 });
  }

  async createWorker(
    options: Omit<WorkerBundlerCreateWorkerOptions, "files"> & {
      files: Record<string, string>;
    },
  ): Promise<WorkerBundlerBuildResult<WorkerBundlerCreateWorkerResult>> {
    return await captureBuildResult(async () =>
      normalizeBuildResult(await workerBundlerCreateWorker(options)),
    );
  }

  async createApp(
    options: Omit<WorkerBundlerCreateAppOptions, "files"> & {
      files: Record<string, string>;
    },
  ): Promise<WorkerBundlerBuildResult<WorkerBundlerCreateAppResult>> {
    return await captureBuildResult(async () =>
      normalizeAppBuildResult(await workerBundlerCreateApp(options)),
    );
  }

  async handleAssetRequest(
    request: Request,
    manifest: Record<string, WorkerBuildAssetMetadata>,
    assets: Record<string, string>,
    config?: WorkerBundlerAssetConfig,
  ): Promise<Response | null> {
    return await workerBundlerHandleAssetRequest(
      request,
      new Map(
        Object.entries(manifest).map(([pathname, metadata]) => [
          pathname,
          { contentType: metadata.contentType, etag: metadata.etag },
        ]),
      ),
      createMemoryStorage(assets),
      config,
    );
  }
}

/** Bad source is an expected build result. Only RPC/transport failures throw. */
async function captureBuildResult<T>(
  build: () => Promise<T>,
): Promise<WorkerBundlerBuildResult<T>> {
  try {
    return { result: await build() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

function normalizeBuildResult(result: CreateWorkerResult): {
  mainModule: string;
  modules: Record<string, WorkerBuildModule>;
  warnings: string[];
  wranglerConfig?: WorkerBuildWranglerConfig;
} {
  return {
    mainModule: result.mainModule,
    modules: loaderReadyModules(result.modules),
    warnings: result.warnings ?? [],
    ...(result.wranglerConfig && { wranglerConfig: result.wranglerConfig }),
  };
}

function normalizeAppBuildResult(result: CreateAppResult): WorkerBundlerCreateAppResult {
  const assets: Record<string, string> = {};
  for (const [pathname, content] of Object.entries(result.assets)) {
    if (typeof content !== "string") {
      throw new Error(
        `App build produced binary asset ${JSON.stringify(pathname)}; ` +
          "the OS build cache currently supports text assets only.",
      );
    }
    assets[pathname] = content;
  }
  const assetManifest: Record<string, WorkerBuildAssetMetadata> = {};
  for (const [pathname, metadata] of result.assetManifest) {
    assetManifest[pathname] = {
      ...(metadata.contentType && { contentType: metadata.contentType }),
      etag: metadata.etag,
    };
  }
  return {
    ...(result.assetConfig && { assetConfig: result.assetConfig }),
    assetManifest,
    assets,
    ...normalizeBuildResult(result),
  };
}

/** Keep worker-bundler's Worker Loader module shape while rejecting the one
 * representation that cannot survive the JSON artifact cache. */
function loaderReadyModules(modules: Modules): Record<string, WorkerBuildModule> {
  const result: Record<string, WorkerBuildModule> = {};
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module === "string") {
      result[name] = module;
    } else {
      if (module.data) {
        throw new Error(
          `Worker build produced binary module ${JSON.stringify(name)}; ` +
            "the OS build cache does not yet encode ArrayBuffers.",
        );
      }
      result[name] = {
        ...(module.cjs && { cjs: module.cjs }),
        ...(module.js && { js: module.js }),
        ...(module.json && { json: module.json }),
        ...(module.text && { text: module.text }),
      };
    }
  }
  return result;
}
