import type { WorkerBuildOptions } from "../../types.ts";
import { stableSha256 } from "./utils.ts";
import { WORKER_BUILD_ARTIFACT_SCHEMA_VERSION } from "./artifact-store.ts";

/**
 * Kept in sync with the `@cloudflare/worker-bundler` dependency in
 * apps/os/package.json (pinned there and asserted by build-key.test.ts). The
 * bundler version participates in the build key so upgrading the bundler
 * invalidates cached artifacts instead of serving output from an older
 * toolchain.
 */
export const WORKER_BUNDLER_VERSION = "0.2.1";

/**
 * A worker file source with all late-bound identity resolved: repo branches
 * are pinned to the commit they named at request time, so a build key (and the
 * artifact filed under it) is immutable and auditable.
 *
 * `contentHash` is the checkout's content identity (from the repo's head
 * cache). When present it replaces the commit oid in the build key, so repos
 * with identical content — every freshly seeded project repo — share one
 * artifact instead of each paying a bundler run.
 */
export type ResolvedWorkerFileSource =
  | {
      type: "inline";
      files: Record<string, string>;
    }
  | {
      type: "repo";
      repoPath: string;
      commitOid: string;
      contentHash?: string;
      include?: string[];
      exclude?: string[];
    };

export type WorkerBuildInput = {
  compatibilityDate: string;
  compatibilityFlags: string[];
  options: WorkerBuildOptions;
  source: ResolvedWorkerFileSource;
};

/**
 * Deterministic identity of one build: normalized source snapshot, Cloudflare
 * build options, bundler/runtime version inputs, compatibility settings, and
 * the artifact schema version. Same input, same key — concurrent callers
 * converge on one artifact and a repeated request is a cache hit.
 */
export async function workerBuildKey(input: WorkerBuildInput): Promise<string> {
  return await stableSha256({
    artifactSchemaVersion: WORKER_BUILD_ARTIFACT_SCHEMA_VERSION,
    bundlerVersion: WORKER_BUNDLER_VERSION,
    compatibilityDate: input.compatibilityDate,
    compatibilityFlags: input.compatibilityFlags,
    options: input.options,
    source: normalizeResolvedSource(input.source),
    type: "worker-build-key",
  });
}

/**
 * Glob mask order carries no semantics (a path is included when any include
 * pattern matches and no exclude pattern matches), so sorting the masks makes
 * equivalent sources hash equal. Repo identity prefers the content hash over
 * the commit oid — same content, same artifact — falling back to the commit
 * oid for pinned refs where no content identity is known.
 */
function normalizeResolvedSource(source: ResolvedWorkerFileSource): Record<string, unknown> {
  if (source.type === "inline") return source;
  return {
    content: source.contentHash ?? `commit:${source.commitOid}`,
    exclude: source.exclude === undefined ? undefined : [...source.exclude].sort(),
    include: source.include === undefined ? undefined : [...source.include].sort(),
    repoPath: source.repoPath,
    type: "repo",
  };
}
