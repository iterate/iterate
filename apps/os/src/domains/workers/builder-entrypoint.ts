import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { KvWorkerBuildArtifactStore, type WorkerBuildArtifact } from "./artifact-store.ts";
import { ResolvedWorkerFileSource } from "./build-key.ts";
import { materializeWorkerBuild } from "./materialize.ts";
import { WorkerBuildOptions } from "./schemas.ts";

/**
 * The builder worker's entrypoint: the one place dynamic worker source is
 * bundled, and the only worker script that carries the bundler toolchain
 * (esbuild-wasm, ~11MB). Everything that RUNS dynamic workers (the worker
 * worker) stays lean and calls `env.BUILDER.build(...)` on an artifact-cache
 * miss; a bundler upgrade or shim change redeploys one worker.
 *
 * `build` returns the artifact BY VALUE, so callers never depend on KV's
 * cross-location write propagation (~60s) to see a build they just requested.
 * The KV write is still made — it is the cache every later load hits.
 */
export class BuilderEntrypoint extends WorkerEntrypoint<Env> {
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
    projectId: string;
    source: ResolvedWorkerFileSource;
    options: unknown;
  }): Promise<WorkerBuildArtifact> {
    const { buildKey, options, projectId, source } = BuildInput.parse(input);

    // The caller checked its own KV, but this is a different isolate and a
    // concurrent build may have landed since; a hit here skips the bundler.
    const store = new KvWorkerBuildArtifactStore(this.env.WORKER_BUILD_CACHE);
    const cached = await store.get(buildKey);
    if (cached !== null) return cached;

    const build = (async () => {
      const files =
        source.type === "inline"
          ? source.files
          : (
              await this.env.REPO.getByName(
                DurableObjectNameCodec.stringify({ path: source.repoPath, projectId }),
              ).getFilesSnapshot({
                branch: source.branch,
                commitOid: source.commitOid,
                exclude: source.exclude,
                include: source.include,
              })
            ).files;

      const built = await materializeWorkerBuild({ files, options });
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

/** Everything that grants authority or reaches the repo is parsed at this
 * boundary; `options` is validated against the public build-options schema. */
const BuildInput = z.object({
  buildKey: z.string().min(1),
  options: WorkerBuildOptions,
  projectId: z.string().trim().min(1),
  source: ResolvedWorkerFileSource,
});
