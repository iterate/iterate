import {
  buildFailureMessageFromError,
  WorkerBuildFailedError,
  type WorkerBuildModule,
  type WorkerBuildAssetMetadata,
  type WorkerBuildWranglerConfig,
} from "./artifact-store.ts";
import { CAPNWEB_VIRTUAL_MODULE } from "./capnweb-virtual-module.generated.ts";
import { ITERATE_LIVE_STATE_VIRTUAL_MODULE } from "./iterate-live-state-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE } from "./iterate-processors-cloudflare-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_VIRTUAL_MODULE } from "./iterate-processors-virtual-module.generated.ts";
import { ITERATE_SDK_VIRTUAL_MODULE } from "./iterate-sdk-virtual-module.generated.ts";
import type { DynamicWorkerSource, WorkerBundlerAssetConfig } from "./schemas.ts";

/** Keep this pin in sync with apps/os/package.json. It participates in every
 * build key so a bundler upgrade cannot reuse artifacts made by older code. */
export const WORKER_BUNDLER_VERSION = "0.2.1";

/** Bump whenever our worker-bundler adapter changes emitted artifacts without
 * changing the upstream package pin or artifact schema. */
export const WORKER_BUNDLER_ADAPTER_VERSION = 1;

/** Dynamic-worker compatibility moves independently from the OS worker. */
export const WORKER_COMPATIBILITY_DATE = "2026-05-01";
export const WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"];

const PLATFORM_VIRTUAL_MODULES = {
  "@iterate-com/capnweb": CAPNWEB_VIRTUAL_MODULE,
  "iterate/live-state": ITERATE_LIVE_STATE_VIRTUAL_MODULE,
  "iterate/processors": ITERATE_PROCESSORS_VIRTUAL_MODULE,
  "iterate/processors/cloudflare": ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE,
  "iterate/sdk": ITERATE_SDK_VIRTUAL_MODULE,
};

/** The exact virtual-module map supplied to worker-bundler. Keeping this in
 * one place makes the compiler input and its content-addressed key identical. */
export function workerVirtualModules(overrides?: Record<string, string>): Record<string, string> {
  return { ...PLATFORM_VIRTUAL_MODULES, ...overrides };
}

/** Resolve `files`, then make one direct createWorker/createApp call in the
 * isolated compiler sidecar. */
export async function executeWorkerBuild(input: {
  files: Record<string, string>;
  source: DynamicWorkerSource;
  workerBundler: Pick<import("../../worker-bundler.ts").default, "createApp" | "createWorker">;
}): Promise<{
  assetConfig?: WorkerBundlerAssetConfig;
  assetManifest: Record<string, WorkerBuildAssetMetadata>;
  assets: Record<string, string>;
  mainModule: string;
  modules: Record<string, WorkerBuildModule>;
  warnings: string[];
  wranglerConfig?: WorkerBuildWranglerConfig;
}> {
  if ("createApp" in input.source) {
    const { files: _files, ...options } = input.source.createApp;
    return unwrapBuildResult(
      await input.workerBundler.createApp({ ...options, files: input.files }),
    );
  }

  const { files: _files, virtualModules, ...options } = input.source.createWorker;
  const built = unwrapBuildResult(
    await input.workerBundler.createWorker({
      ...options,
      files: input.files,
      virtualModules: workerVirtualModules(virtualModules),
    }),
  );
  return { assetManifest: {}, assets: {}, ...built };
}

function unwrapBuildResult<T>(result: { error: string } | { result: T }): T {
  if ("error" in result) {
    throw new WorkerBuildFailedError(buildFailureMessageFromError(result.error));
  }
  return result.result;
}
