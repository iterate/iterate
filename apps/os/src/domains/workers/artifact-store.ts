/** A single-record KV cache for loader-ready dynamic worker builds. */

import type { WorkerBundlerAssetConfig } from "./schemas.ts";

// v10 invalidates artifacts emitted after dependency-install warnings. Those
// bundles could retain unresolved bare imports and were never runnable.
// v11 invalidates artifacts built before the worker-bundler patch that warns
// on every unresolved import (#2292): pre-patch bundles could carry silently
// externalized imports that fail at instantiation with `No such module`, and
// without a bump their build keys would keep serving them from KV for up to
// the 30-day TTL, never reaching the new build-time gate.
// Failures are deliberately not cached: the bundler cannot distinguish
// broken source from transient infrastructure.
export const WORKER_BUILD_ARTIFACT_SCHEMA_VERSION = 11;

const ARTIFACT_TTL_SECONDS = 30 * 24 * 60 * 60;
const KV_PREFIX = `worker-build/v${WORKER_BUILD_ARTIFACT_SCHEMA_VERSION}`;

/** JSON-safe subset of Worker Loader's module representation. */
export type WorkerBuildModule =
  | string
  | {
      cjs?: string;
      js?: string;
      json?: unknown;
      text?: string;
    };

/** JSON-safe form of worker-bundler's AssetMetadata. */
export type WorkerBuildAssetMetadata = {
  contentType?: string;
  etag: string;
};

/** JSON-safe form of worker-bundler's parsed Wrangler config. */
export type WorkerBuildWranglerConfig = {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  main?: string;
};

export type WorkerBuildArtifact = {
  assetConfig?: WorkerBundlerAssetConfig;
  assetManifest: Record<string, WorkerBuildAssetMetadata>;
  assets: Record<string, string>;
  buildKey: string;
  createdAt: string;
  mainModule: string;
  modules: Record<string, WorkerBuildModule>;
  warnings?: string[];
  wranglerConfig?: WorkerBuildWranglerConfig;
};

/** An expected source-build failure; repo, KV, and sidecar transport errors stay distinct. */
export class WorkerBuildFailedError extends Error {
  override readonly name = "WorkerBuildFailedError";
}

export function isWorkerBuildFailedError(
  error: unknown,
): error is { name: "WorkerBuildFailedError" } {
  return (error as { name?: string } | null)?.name === "WorkerBuildFailedError";
}

const BUILD_FAILURE_MESSAGE_LIMIT = 2_000;

export function buildFailureMessageFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.length <= BUILD_FAILURE_MESSAGE_LIMIT) return message;
  return `${message.slice(0, BUILD_FAILURE_MESSAGE_LIMIT)}… (truncated)`;
}

function artifactKey(buildKey: string): string {
  return `${KV_PREFIX}/complete/${buildKey}.json`;
}

export class KvWorkerBuildArtifactStore {
  constructor(readonly kv: KVNamespace) {}

  async get(buildKey: string): Promise<WorkerBuildArtifact | null> {
    return await this.kv.get<WorkerBuildArtifact>(artifactKey(buildKey), "json");
  }

  async put(artifact: WorkerBuildArtifact): Promise<void> {
    await this.kv.put(artifactKey(artifact.buildKey), JSON.stringify(artifact), {
      expirationTtl: ARTIFACT_TTL_SECONDS,
    });
  }
}
