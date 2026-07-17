import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import {
  buildFailureMessageFromError,
  KvWorkerBuildArtifactStore,
  WorkerBuildFailedError,
  type WorkerBuildArtifact,
} from "./artifact-store.ts";
import { materializeWorkerBuild } from "./materialize.ts";
import { WorkerBuildOptions } from "./schemas.ts";

/**
 * The builder worker's whole env: the artifact cache, nothing else. The
 * builder is deliberately the MINIMUM possible deployable unit around the
 * bundler toolchain (esbuild-wasm, ~14MB) — a pure function worker (files in,
 * artifact out) with no DO namespaces, no service bindings, no repo access,
 * and nothing that orders its deploy relative to the os worker beyond
 * "builder first". It IS the "+1" in the single-worker topology (see
 * docs/worker-topology.md): the wasm never rides in the product script, and
 * the deploy DAG stays trivial.
 */
type BuilderEnv = {
  WORKER_BUILD_CACHE: KVNamespace;
};

/**
 * The builder worker's entrypoint: the one place dynamic worker source is
 * bundled, and the only worker script that carries the bundler toolchain.
 * The os worker (which runs all dynamic workers) stays lean and calls
 * `env.BUILDER.build(...)` on an artifact-cache miss; a bundler upgrade or
 * shim change redeploys one worker.
 *
 * `build` takes source files BY VALUE (the caller resolves repo snapshots —
 * it owns the REPO binding; a file map carries no authority so the builder
 * needs none) and returns the artifact BY VALUE, so callers never depend on
 * KV's cross-location write propagation (~60s) to see a build they just
 * requested. The KV write is still made — it is the cache every later load
 * hits.
 */
export class BuilderEntrypoint extends WorkerEntrypoint<BuilderEnv> {
  /** The builder serves no HTTP; everything arrives over RPC. */
  override fetch(): Response {
    return Response.json({ worker: "os-builder" }, { status: 404 });
  }

  // Concurrent cold builds of one key are NOT deduped in-process: each RPC
  // gets a fresh entrypoint instance (no instance state survives), and
  // sharing promises across request contexts is workerd's cross-request-I/O
  // trap. Duplicates converge on one content-addressed, idempotent KV write —
  // redundant bundler work, never wrong output.
  async build(input: {
    buildKey: string;
    files: Record<string, string>;
    options: unknown;
  }): Promise<WorkerBuildArtifact> {
    const { buildKey, files, options } = BuildInput.parse(input);

    // The caller checked its own KV, but this is a different isolate and a
    // concurrent build may have landed since; a hit here skips the bundler.
    const store = new KvWorkerBuildArtifactStore(this.env.WORKER_BUILD_CACHE);
    const cached = await store.get(buildKey);
    if (cached !== null) return cached;

    const build = (async () => {
      // Best-effort duplicate suppression for budgeted callers (see
      // isBuildInFlight); the artifact write below always supersedes it.
      await store.markBuildInFlight(buildKey).catch(() => {});
      // The named wrap is the caller's classification signal: only a genuine
      // bundler failure may be RECORDED as a build failure (and served as
      // one); anything else that rejects this RPC — deploy rollover,
      // cancellation when a caller's waitUntil ends — must stay retryable.
      const built = await materializeWorkerBuild({ files, options }).catch((error: unknown) => {
        throw new WorkerBuildFailedError(buildFailureMessageFromError(error), { cause: error });
      });
      for (const warning of built.warnings) {
        console.warn(`[builder] ${buildKey.slice(0, 12)}: ${warning}`);
      }
      const artifact: WorkerBuildArtifact = {
        buildKey,
        mainModule: built.mainModule,
        modules: built.modules,
      };
      await store.put(artifact);
      return artifact;
    })();
    // Survive caller disconnects: a caller that gives up on a slow build (the
    // build-in-progress page) cancels its RPC, but the build should still
    // finish into the cache so the caller's retry is a hit.
    this.ctx.waitUntil(build.catch(() => {}));
    return await build;
  }
}

/** The whole input is inert data — `buildKey` names the cache entry, `files`
 * is the already-resolved source snapshot, `options` is validated against the
 * public build-options schema. Nothing here grants authority. */
const BuildInput = z.object({
  buildKey: z.string().min(1),
  files: z.record(z.string(), z.string()),
  options: WorkerBuildOptions,
});
