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

export type WorkerBuildSizes = {
  assetBytes: number;
  assetCount: number;
  /** Module bytes by npm package (or source-path bucket), largest first,
   * capped with an "(other)" rollup — the "what got big" companion to the
   * totals. */
  breakdown: Record<string, number>;
  moduleBytes: number;
  moduleCount: number;
};

const BREAKDOWN_BUCKET_CAP = 8;

/** Uncompressed UTF-8 weight of one built artifact — the modules Worker Loader
 * must instantiate and the browser assets OS retains. Derived on demand rather
 * than stored, so cached artifacts need no schema bump.
 *
 * The breakdown attributes bundled code via esbuild's `// <path>` section
 * comments (present because dynamic worker builds are not minified). Text
 * before the first section comment — or a whole comment-stripped module —
 * falls back to the module's own name, so a minified build degrades to
 * per-module totals instead of lying. */
export function workerBuildArtifactSizes(artifact: WorkerBuildArtifact): WorkerBuildSizes {
  const encoder = new TextEncoder();
  const byteLength = (text: string) => encoder.encode(text).byteLength;
  const buckets = new Map<string, number>();
  const attribute = (bucket: string, bytes: number) =>
    buckets.set(bucket, (buckets.get(bucket) || 0) + bytes);
  const attributeCode = (moduleName: string, code: string) => {
    let bucket = bucketForPath(moduleName);
    for (const line of code.split("\n")) {
      const section = /^\s*\/\/ (\S+\.(?:m?[jt]sx?|json))$/.exec(line);
      if (section !== null) bucket = bucketForPath(section[1]!);
      attribute(bucket, byteLength(line) + 1);
    }
    attribute(bucket, -1); // the split added one newline the text doesn't end with
  };

  let moduleBytes = 0;
  for (const [name, module] of Object.entries(artifact.modules)) {
    const texts =
      typeof module === "string"
        ? [module]
        : [module.cjs, module.js, module.text].filter((text) => typeof text === "string");
    for (const text of texts) {
      attributeCode(name, text);
      moduleBytes += byteLength(text);
    }
    if (typeof module !== "string" && module.json !== undefined) {
      const data = JSON.stringify(module.json);
      attribute(bucketForPath(name), byteLength(data));
      moduleBytes += byteLength(data);
    }
  }
  let assetBytes = 0;
  for (const content of Object.values(artifact.assets)) assetBytes += byteLength(content);
  return {
    assetBytes,
    assetCount: Object.keys(artifact.assets).length,
    breakdown: cappedBreakdown(buckets),
    moduleBytes,
    moduleCount: Object.keys(artifact.modules).length,
  };
}

/** `…/node_modules/@scope/pkg/…` → `@scope/pkg`; anything else keeps its first
 * path segment (`worker.ts`, `apps`, a chunk name). */
function bucketForPath(path: string): string {
  const installed = path.lastIndexOf("node_modules/");
  const parts = path.slice(installed === -1 ? 0 : installed + "node_modules/".length).split("/");
  return parts[0]!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function cappedBreakdown(buckets: Map<string, number>): Record<string, number> {
  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const kept =
    sorted.length > BREAKDOWN_BUCKET_CAP ? sorted.slice(0, BREAKDOWN_BUCKET_CAP - 1) : sorted;
  const other = sorted.slice(kept.length).reduce((sum, [, bytes]) => sum + bytes, 0);
  return Object.fromEntries(other === 0 ? kept : [...kept, ["(other)", other]]);
}

/** Plain-data terminal outcome for source which the compiler cannot build. */
export type WorkerBuildFailure = {
  kind: "source";
  message: string;
};

/** JSON-safe result carried across every Worker build RPC boundary. */
export type WorkerBuildResult =
  | { artifact: WorkerBuildArtifact; ok: true }
  | { failure: WorkerBuildFailure; ok: false };

/** An expected source-build failure; repo, KV, and sidecar transport errors stay distinct. */
export class WorkerBuildFailedError extends Error {
  override readonly name = "WorkerBuildFailedError";
  readonly retryable = false;

  constructor(failure: WorkerBuildFailure) {
    super(failure.message);
  }
}

export function isWorkerBuildFailedError(
  error: unknown,
): error is { name: "WorkerBuildFailedError"; retryable?: false } {
  return (error as { name?: string } | null)?.name === "WorkerBuildFailedError";
}

const BUILD_FAILURE_MESSAGE_LIMIT = 2_000;

export function buildFailureMessageFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > BUILD_FAILURE_MESSAGE_LIMIT
    ? `${message.slice(0, BUILD_FAILURE_MESSAGE_LIMIT)}… (truncated)`
    : message;
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
