import {
  isWorkerBuildFailedError,
  workerBuildArtifactSizes,
  type WorkerBuildArtifact,
  type WorkerBuildSizes,
} from "./artifact-store.ts";
import type { WorkerBuildRequest } from "./worker-build-capability.ts";

export type WorkerBuildCoordinatorEvent = {
  buildKey: string;
  durationMs?: number;
  kind: "coalesced" | "reused" | "settled" | "started";
  outcome?: "built" | "infrastructure-failed" | "source-failed";
  /** Bundle weight, present once a build settles successfully (and on reuses of it). */
  sizes?: WorkerBuildSizes;
  /** What's building, human-readable — the buildKey alone is an opaque hash. */
  source: string;
  waiters: number;
};

type Flight = {
  buildKey: string;
  source: string;
  startedAt: number;
  waiters: Set<{
    reject(error: unknown): void;
    resolve(artifact: WorkerBuildArtifact): void;
  }>;
};

/** `createWorker:worker.ts`-style descriptor of a build request's entry point(s). */
function describeWorkerBuildSource(source: WorkerBuildRequest["source"]): string {
  if ("createWorker" in source) {
    return `createWorker:${source.createWorker.entryPoint ?? "(default entry)"}`;
  }
  const { client, server } = source.createApp;
  const entries = [
    ...(server === undefined ? [] : [`server=${server}`]),
    ...(typeof client === "string" ? [client] : (client ?? [])).map((entry) => `client=${entry}`),
  ];
  return `createApp:${entries.join(",") || "(default entry)"}`;
}

/**
 * In-incarnation scheduling core for one build-key Durable Object.
 *
 * Followers receive promises created in their own RPC invocation rather than
 * awaiting the leader's I/O promise. The Durable Object supplies the global
 * rendezvous; this class only owns the live operation and its followers. This
 * avoids Workers' cross-request I/O ownership failure:
 * https://developers.cloudflare.com/workers/observability/errors/#cannot-perform-io-on-behalf-of-a-different-request
 */
export class WorkerBuildCoordinator {
  readonly #execute: (request: WorkerBuildRequest) => Promise<WorkerBuildArtifact>;
  readonly #now: () => number;
  readonly #observe: (event: WorkerBuildCoordinatorEvent) => void;
  #flight: Flight | undefined;
  #settled:
    | { artifact: WorkerBuildArtifact; buildKey: string; sizes: WorkerBuildSizes }
    | undefined;

  constructor(
    execute: (request: WorkerBuildRequest) => Promise<WorkerBuildArtifact>,
    options: {
      now?: () => number;
      observe?: (event: WorkerBuildCoordinatorEvent) => void;
    } = {},
  ) {
    this.#execute = execute;
    this.#now = options.now ?? Date.now;
    this.#observe = options.observe ?? (() => {});
  }

  async build(request: WorkerBuildRequest): Promise<WorkerBuildArtifact> {
    const settled = this.#settled;
    if (settled !== undefined) {
      this.#assertBuildKey(settled.buildKey, request.buildKey);
      this.#observe({
        buildKey: request.buildKey,
        kind: "reused",
        sizes: settled.sizes,
        source: describeWorkerBuildSource(request.source),
        waiters: 0,
      });
      return settled.artifact;
    }

    const existing = this.#flight;
    if (existing !== undefined) {
      this.#assertBuildKey(existing.buildKey, request.buildKey);
      return await new Promise<WorkerBuildArtifact>((resolve, reject) => {
        existing.waiters.add({ reject, resolve });
        this.#emit(existing, "coalesced");
      });
    }

    const flight: Flight = {
      buildKey: request.buildKey,
      source: describeWorkerBuildSource(request.source),
      startedAt: this.#now(),
      waiters: new Set(),
    };
    this.#flight = flight;
    this.#emit(flight, "started");
    try {
      const artifact = await this.#execute(request);
      // Sized once here; reuse events replay this value instead of re-encoding
      // megabytes of module text per call.
      const sizes = workerBuildArtifactSizes(artifact);
      // One actor owns one immutable build key. Keep its successful result in
      // memory so callers from other OS isolates do not fall back through the
      // eventually-consistent KV cache immediately after the first build.
      // Actor eviction remains the cache eviction policy; after that, the KV
      // write is visible at the coordinator's stable location.
      this.#settled = { artifact, buildKey: request.buildKey, sizes };
      this.#emit(flight, "settled", "built", sizes);
      for (const waiter of flight.waiters) waiter.resolve(artifact);
      return artifact;
    } catch (error) {
      this.#emit(
        flight,
        "settled",
        isWorkerBuildFailedError(error) ? "source-failed" : "infrastructure-failed",
      );
      for (const waiter of flight.waiters) waiter.reject(copyError(error));
      throw error;
    } finally {
      this.#flight = undefined;
    }
  }

  #assertBuildKey(expected: string, received: string): void {
    if (expected !== received) {
      throw new Error(`Worker build coordinator for ${expected} received ${received}.`);
    }
  }

  #emit(
    flight: Flight,
    kind: WorkerBuildCoordinatorEvent["kind"],
    outcome?: WorkerBuildCoordinatorEvent["outcome"],
    sizes?: WorkerBuildSizes,
  ) {
    this.#observe({
      buildKey: flight.buildKey,
      ...(kind === "settled" ? { durationMs: this.#now() - flight.startedAt } : {}),
      kind,
      ...(outcome === undefined ? {} : { outcome }),
      ...(sizes === undefined ? {} : { sizes }),
      source: flight.source,
      waiters: flight.waiters.size,
    });
  }
}

function copyError(error: unknown) {
  if (!(error instanceof Error)) return new Error(String(error));
  const copy = new Error(error.message);
  copy.name = error.name;
  return copy;
}
