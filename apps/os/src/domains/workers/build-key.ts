import type { WorkerBuildOptions } from "./schemas.ts";
import { stableSha256 } from "./utils.ts";
import { WORKER_BUILD_ARTIFACT_SCHEMA_VERSION } from "./artifact-store.ts";
import { BUILD_TOOLCHAIN_VERSION } from "./build-recipe.ts";

/**
 * A worker file source with all late-bound identity resolved: repo branches
 * are pinned to the commit they named at request time, so a build key (and the
 * artifact filed under it) is immutable and auditable.
 *
 * `contentHash` is the checkout's content identity (from the repo's head
 * cache). When present it replaces the commit oid in the build key, so repos
 * with identical content — every freshly seeded project repo — share one
 * artifact instead of each paying a bundler run. Pinned-commit refs skip the
 * head cache and have no content identity, hence the optionality.
 *
 * A plain type, not a schema: only the trusted resolver constructs this
 * value (worker-loader.ts resolveFileSource), hashes it into the key, and
 * expands it to a file map before anything crosses a boundary — the build
 * backend receives files by value (build-backend.ts).
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
  options: WorkerBuildOptions;
  source: ResolvedWorkerFileSource;
};

/**
 * Deterministic identity of one build: normalized source snapshot, build
 * options, the toolchain pin, compatibility settings, and the artifact schema
 * version. Same input, same key — concurrent callers converge on one artifact
 * and a repeated request is a cache hit.
 *
 * Content-only key: the same source + options always produce the same key, so
 * every project with identical template content shares one artifact. Builds
 * only parse and bundle source (worker-bundler); they never execute project
 * build scripts, so there is no per-project builder environment that could
 * poison a shared result. Last-good pointers stay project-scoped separately
 * (worker-loader workerLastGoodKey).
 */
export async function workerBuildKey(input: WorkerBuildInput): Promise<string> {
  return await stableSha256({
    artifactSchemaVersion: WORKER_BUILD_ARTIFACT_SCHEMA_VERSION,
    compatibilityDate: input.compatibilityDate,
    compatibilityFlags: input.compatibilityFlags,
    options: input.options,
    source: normalizeResolvedSource(input.source),
    toolchainVersion: BUILD_TOOLCHAIN_VERSION,
    type: "worker-build-key",
  });
}

type NormalizedRepoSourceIdentity = {
  content: string;
  exclude?: string[];
  include?: string[];
  repoPath: string;
  type: "repo";
};

/**
 * Glob mask order carries no semantics (a path is included when any include
 * pattern matches and no exclude pattern matches), so sorting the masks makes
 * equivalent sources hash equal. Repo identity prefers the content hash over
 * the commit oid — same content, same artifact — falling back to the commit
 * oid for pinned refs where no content identity is known.
 */
function normalizeResolvedSource(
  source: ResolvedWorkerFileSource,
): ResolvedWorkerFileSource | NormalizedRepoSourceIdentity {
  if (source.type === "inline") return source;
  return {
    content: source.contentHash ?? `commit:${source.commitOid}`,
    exclude: source.exclude === undefined ? undefined : [...source.exclude].sort(),
    include: source.include === undefined ? undefined : [...source.include].sort(),
    repoPath: source.repoPath,
    type: "repo",
  };
}
