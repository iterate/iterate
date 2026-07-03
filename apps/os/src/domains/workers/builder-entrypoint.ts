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

  // Concurrent cold callers of one build key converge on one bundler run.
  // Per-isolate is enough: duplicate builds across isolates are harmless
  // (content-addressed, idempotent KV writes), just wasted work.
  #inFlight = new Map<string, Promise<WorkerBuildArtifact>>();

  async build(input: {
    buildKey: string;
    projectId: string;
    source: ResolvedWorkerFileSource;
    options: unknown;
  }): Promise<WorkerBuildArtifact> {
    const { buildKey, options, projectId, source } = BuildInput.parse(input);

    const store = new KvWorkerBuildArtifactStore(this.env.WORKER_BUILD_CACHE);
    const cached = await store.get(buildKey);
    if (cached !== null) return cached;

    const inFlight = this.#inFlight.get(buildKey);
    if (inFlight !== undefined) return await inFlight;

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

    this.#inFlight.set(buildKey, build);
    try {
      return await build;
    } finally {
      this.#inFlight.delete(buildKey);
    }
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
