/** A single-record KV cache for loader-ready dynamic worker builds. */

import type { WorkerBundlerAssetConfig } from "./schemas.ts";

// v8 preserves worker-bundler's Wrangler compatibility settings.
export const WORKER_BUILD_ARTIFACT_SCHEMA_VERSION = 8;

const ARTIFACT_TTL_SECONDS = 30 * 24 * 60 * 60;
const FAILURE_TTL_SECONDS = 15 * 60;
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
  status: "complete";
  warnings?: string[];
  wranglerConfig?: WorkerBuildWranglerConfig;
};

export type WorkerBuildFailure = {
  buildKey: string;
  /** The commit whose build failed, when the source came from a repo. */
  commitOid?: string;
  createdAt: string;
  message: string;
  status: "failed";
};

type WorkerBuildRecord = WorkerBuildArtifact | WorkerBuildFailure;

/** An error returned by the worker-bundler call. Name-based because it crosses Workers
 * RPC; repo, KV, and sidecar transport errors deliberately keep other names. */
export class WorkerBuildFailedError extends Error {
  override readonly name = "WorkerBuildFailedError";
}

export function isWorkerBuildFailedError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "WorkerBuildFailedError";
}

const BUILD_FAILURE_MESSAGE_LIMIT = 2_000;

export function buildFailureMessageFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > BUILD_FAILURE_MESSAGE_LIMIT
    ? `${message.slice(0, BUILD_FAILURE_MESSAGE_LIMIT)}… (truncated)`
    : message;
}

function recordKey(buildKey: string): string {
  return `${KV_PREFIX}/${buildKey}.json`;
}

export class KvWorkerBuildArtifactStore {
  constructor(
    readonly kv: KVNamespace,
    readonly options: { expirationTtlSeconds?: number } = {},
  ) {}

  async get(buildKey: string): Promise<WorkerBuildRecord | null> {
    return await this.kv.get<WorkerBuildRecord>(recordKey(buildKey), "json");
  }

  async put(record: WorkerBuildRecord): Promise<void> {
    await this.kv.put(recordKey(record.buildKey), JSON.stringify(record), {
      expirationTtl:
        record.status === "complete"
          ? (this.options.expirationTtlSeconds ?? ARTIFACT_TTL_SECONDS)
          : FAILURE_TTL_SECONDS,
    });
  }
}
