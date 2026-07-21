import { stableSha256 } from "./utils.ts";
import { WORKER_BUILD_ARTIFACT_SCHEMA_VERSION } from "./artifact-store.ts";
import {
  WORKER_BUNDLER_ADAPTER_VERSION,
  WORKER_BUNDLER_VERSION,
  workerVirtualModules,
} from "./build-backend.ts";
import type { DynamicWorkerSource } from "./schemas.ts";

/**
 * A worker file source with all late-bound identity resolved: repo branches
 * are pinned to the commit they named at request time, so a build key (and the
 * artifact filed under it) is immutable and auditable.
 *
 * `contentHash` is the checkout's content identity (from the repo's head
 * cache). When present it replaces the commit oid in the content key, so
 * equivalent commits reuse one artifact even across projects. Pinned-commit
 * refs skip the head cache and have no content identity, hence the optionality.
 *
 * A plain type, not a schema: only the trusted resolver constructs this
 * value (worker-loader.ts resolveFileSource), hashes it into the key, and
 * expands it to a file map before calling the compiler sidecar.
 */
export type ResolvedWorkerFileSource =
  | {
      files: Record<string, string>;
      type: "inline";
    }
  | {
      /** The branch the pinned commit was resolved from. Snapshot resolution
       * needs it (clones are single-branch, so an off-default commit is only
       * reachable through its branch's history); the build key deliberately
       * ignores it — content identity is the commit/content hash. */
      branch?: string;
      commitOid: string;
      contentHash?: string;
      exclude?: string[];
      include?: string[];
      repoPath: string;
      type: "repo";
    };

export type WorkerBuildInput = {
  compatibilityDate: string;
  compatibilityFlags: string[];
  files: ResolvedWorkerFileSource;
  source: DynamicWorkerSource;
};

let platformVirtualModulesDigest: Promise<string> | undefined;

function virtualModulesDigest(overrides?: Record<string, string>): Promise<string> {
  if (overrides !== undefined && Object.keys(overrides).length > 0) {
    return stableSha256(workerVirtualModules(overrides));
  }
  return (platformVirtualModulesDigest ??= stableSha256(workerVirtualModules()));
}

/**
 * Deterministic identity of one build: normalized source snapshot, build
 * options, the bundler pin, our adapter version, compatibility settings, and
 * the artifact schema version. Same input, same key — concurrent callers
 * converge on one artifact and a repeated request is a cache hit.
 *
 * Identical build requests share this key across projects. If package ranges
 * are not locked, the first successful worker-bundler resolution becomes the
 * cached artifact for that source+options identity until the cache expires.
 */
export async function workerBuildKey(input: WorkerBuildInput): Promise<string> {
  let build: unknown;
  if ("createApp" in input.source) {
    const { files: _files, ...options } = input.source.createApp;
    build = { method: "createApp", options };
  } else {
    const { files: _files, virtualModules, ...options } = input.source.createWorker;
    build = {
      method: "createWorker",
      options: { ...options, virtualModulesSha256: await virtualModulesDigest(virtualModules) },
    };
  }
  return await stableSha256({
    artifactSchemaVersion: WORKER_BUILD_ARTIFACT_SCHEMA_VERSION,
    build,
    compatibilityDate: input.compatibilityDate,
    compatibilityFlags: input.compatibilityFlags,
    files: normalizeResolvedSource(input.files),
    bundlerAdapterVersion: WORKER_BUNDLER_ADAPTER_VERSION,
    bundlerVersion: WORKER_BUNDLER_VERSION,
    type: "worker-build-key",
  });
}

type NormalizedRepoSourceIdentity = {
  content: string;
  exclude?: string[];
  include?: string[];
  type: "repo";
};

/**
 * Glob mask order carries no semantics (a path is included when any include
 * pattern matches and no exclude pattern matches), so sorting the masks makes
 * equivalent sources hash equal. Repo identity prefers the content hash over
 * the commit oid — same content, same content key — falling back to the
 * commit oid for pinned refs where no content identity is known.
 */
function normalizeResolvedSource(
  source: ResolvedWorkerFileSource,
): ResolvedWorkerFileSource | NormalizedRepoSourceIdentity {
  if (source.type === "inline") return source;
  return {
    content: source.contentHash ?? `commit:${source.commitOid}`,
    exclude: source.exclude === undefined ? undefined : [...source.exclude].sort(),
    include: source.include === undefined ? undefined : [...source.include].sort(),
    type: "repo",
  };
}
