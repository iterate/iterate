import type {
  WorkerBuildBackend,
  WorkerBuildOutcome,
  WorkerBuildRequest,
  WorkerBuildService,
} from "./worker-build-contract.ts";

export type WorkerBuildCoordinatorEvent = {
  active: number;
  buildKey: string;
  durationMs?: number;
  kind: "coalesced" | "queued" | "started" | "finished" | "errored" | "rejected";
  outcome?: WorkerBuildOutcome["status"];
  queued: number;
};

export class WorkerBuildQueueFullError extends Error {
  override readonly name = "WorkerBuildQueueFullError";
}

export class WorkerBuildQueueTimeoutError extends Error {
  override readonly name = "WorkerBuildQueueTimeoutError";
}

type Flight = {
  waiters: Set<{
    reject(error: unknown): void;
    resolve(outcome: WorkerBuildOutcome): void;
  }>;
};

type QueueWaiter = {
  reject(error: unknown): void;
  resolve(): void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Lightweight, storage-free scheduling core for the deployment singleton.
 *
 * - distinct builds run up to an explicit concurrency ceiling;
 * - excess work waits in a bounded, timed queue;
 * - concurrent calls for the same content key share one backend build.
 *
 * Followers receive their own promise rather than the leader's I/O promise.
 * That keeps cross-request I/O ownership inside the leader while still
 * coalescing work in a Durable Object incarnation.
 */
export class WorkerBuildCoordinator implements Pick<WorkerBuildService, "build"> {
  readonly #backend: WorkerBuildBackend;
  readonly #flights = new Map<string, Flight>();
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  readonly #now: () => number;
  readonly #observe: (event: WorkerBuildCoordinatorEvent) => void;
  readonly #queue: QueueWaiter[] = [];
  readonly #queueTimeoutMs: number;
  #active = 0;

  constructor(
    backend: WorkerBuildBackend,
    options: {
      maxConcurrent: number;
      maxQueued: number;
      queueTimeoutMs: number;
      now?: () => number;
      observe?: (event: WorkerBuildCoordinatorEvent) => void;
    },
  ) {
    for (const [name, value] of [
      ["maxConcurrent", options.maxConcurrent],
      ["maxQueued", options.maxQueued],
      ["queueTimeoutMs", options.queueTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < (name === "maxQueued" ? 0 : 1)) {
        throw new Error(
          `${name} must be a ${name === "maxQueued" ? "non-negative" : "positive"} integer`,
        );
      }
    }
    this.#backend = backend;
    this.#maxConcurrent = options.maxConcurrent;
    this.#maxQueued = options.maxQueued;
    this.#queueTimeoutMs = options.queueTimeoutMs;
    this.#now = options.now ?? Date.now;
    this.#observe = options.observe ?? (() => {});
  }

  async build(request: WorkerBuildRequest): Promise<WorkerBuildOutcome> {
    if (!/^[a-f0-9]{64}$/.test(request.buildKey)) {
      throw new TypeError("worker build key must be a lowercase SHA-256 digest");
    }

    const existing = this.#flights.get(request.buildKey);
    if (existing !== undefined) {
      this.#emit(request.buildKey, "coalesced");
      return await new Promise<WorkerBuildOutcome>((resolve, reject) => {
        existing.waiters.add({ reject, resolve });
      });
    }

    const flight: Flight = { waiters: new Set() };
    this.#flights.set(request.buildKey, flight);
    try {
      const outcome = await this.#scheduledBuild(request);
      for (const waiter of flight.waiters) waiter.resolve(outcome);
      return outcome;
    } catch (error) {
      for (const waiter of flight.waiters) waiter.reject(copyError(error));
      throw error;
    } finally {
      this.#flights.delete(request.buildKey);
    }
  }

  async #scheduledBuild(request: WorkerBuildRequest): Promise<WorkerBuildOutcome> {
    await this.#acquire(request.buildKey);
    const startedAt = this.#now();
    this.#emit(request.buildKey, "started");
    try {
      const outcome = await this.#backend.build(request);
      this.#emit(request.buildKey, "finished", {
        durationMs: this.#now() - startedAt,
        outcome: outcome.status,
      });
      return outcome;
    } catch (error) {
      this.#emit(request.buildKey, "errored", { durationMs: this.#now() - startedAt });
      throw error;
    } finally {
      this.#release();
    }
  }

  async #acquire(buildKey: string): Promise<void> {
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return;
    }
    if (this.#queue.length >= this.#maxQueued) {
      this.#emit(buildKey, "rejected");
      throw new WorkerBuildQueueFullError(
        `worker build queue is full (${this.#active} active, ${this.#queue.length} queued)`,
      );
    }

    const acquired = Promise.withResolvers<void>();
    const waiter: QueueWaiter = {
      reject: acquired.reject,
      resolve: acquired.resolve,
      timer: setTimeout(() => {
        const index = this.#queue.indexOf(waiter);
        if (index === -1) return;
        this.#queue.splice(index, 1);
        this.#emit(buildKey, "rejected");
        waiter.reject(
          new WorkerBuildQueueTimeoutError(
            `worker build waited more than ${this.#queueTimeoutMs}ms for capacity`,
          ),
        );
      }, this.#queueTimeoutMs),
    };
    this.#queue.push(waiter);
    this.#emit(buildKey, "queued");
    try {
      await acquired.promise;
    } finally {
      clearTimeout(waiter.timer);
    }
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      // Transfer the occupied slot directly. Decrementing before waking the
      // waiter would let a new request steal it and exceed maxConcurrent once
      // this queued request resumed.
      next.resolve();
      return;
    }
    this.#active -= 1;
  }

  #emit(
    buildKey: string,
    kind: WorkerBuildCoordinatorEvent["kind"],
    detail: Pick<WorkerBuildCoordinatorEvent, "durationMs" | "outcome"> = {},
  ): void {
    this.#observe({
      active: this.#active,
      buildKey,
      kind,
      queued: this.#queue.length,
      ...detail,
    });
  }
}

function copyError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  const copy = new Error(error.message);
  copy.name = error.name;
  return copy;
}
