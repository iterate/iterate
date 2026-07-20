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

type WorkerBundlerService = Pick<
  import("../../worker-bundler.ts").WorkerBundlerEntrypoint,
  "createApp" | "createWorker"
>;

/** Resolve `files`, then make one direct createWorker/createApp call in the
 * isolated compiler sidecar. */
export async function executeWorkerBuild(input: {
  files: Record<string, string>;
  source: DynamicWorkerSource;
  workerBundler: WorkerBundlerService;
}): Promise<{
  assetConfig?: WorkerBundlerAssetConfig;
  assetManifest: Record<string, WorkerBuildAssetMetadata>;
  assets: Record<string, string>;
  mainModule: string;
  modules: Record<string, WorkerBuildModule>;
  warnings: string[];
  wranglerConfig?: WorkerBuildWranglerConfig;
}> {
  try {
    if ("createApp" in input.source) {
      const { files: _files, ...options } = input.source.createApp;
      return await input.workerBundler.createApp({ ...options, files: input.files });
    }

    const { files: _files, virtualModules, ...options } = input.source.createWorker;
    const built = await input.workerBundler.createWorker({
      ...options,
      files: input.files,
      virtualModules: workerVirtualModules(virtualModules),
    });
    return { assetManifest: {}, assets: {}, ...built };
  } catch (error) {
    // The sidecar names errors thrown by the build operation. Service-binding
    // transport/runtime errors keep their original identity and remain
    // retryable instead of poisoning the bundler-error cache.
    if ((error as { name?: string } | null)?.name !== "WorkerBundlerBuildError") throw error;
    throw new WorkerBuildFailedError(buildFailureMessageFromError(error), { cause: error });
  }
}
