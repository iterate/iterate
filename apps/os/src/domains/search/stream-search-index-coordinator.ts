/**
 * Coordinates the derived search-index writes for project streams.
 *
 * A project can receive many `processEventBatch` calls concurrently (one per
 * userspace worker delivery). Every batch in a 100-event segment rewrites the
 * same R2 object, and R2 rejects overlapping writes to one key. The project
 * Durable Object owns one coordinator: writes for the same stream are
 * serialized, while offsets that arrive during a write collapse into one next
 * wave. Different streams remain independent.
 */

export type StreamSearchIndexRequest = {
  projectId: string;
  path: string;
  offsets: readonly number[];
};

type Lane = {
  offsets: Set<number>;
  running: boolean;
  waiters: Array<{
    resolve(): void;
    reject(error: unknown): void;
  }>;
};

export class StreamSearchIndexCoordinator {
  readonly #lanes = new Map<string, Lane>();

  constructor(
    private readonly write: (request: {
      projectId: string;
      path: string;
      offsets: number[];
    }) => Promise<void>,
  ) {}

  index(request: StreamSearchIndexRequest): Promise<void> {
    if (request.offsets.length === 0) return Promise.resolve();
    const key = `${request.projectId}\0${request.path}`;
    let lane = this.#lanes.get(key);
    if (lane === undefined) {
      lane = { offsets: new Set(), running: false, waiters: [] };
      this.#lanes.set(key, lane);
    }
    for (const offset of request.offsets) lane.offsets.add(offset);

    const completion = new Promise<void>((resolve, reject) => {
      lane!.waiters.push({ resolve, reject });
    });
    if (!lane.running) {
      lane.running = true;
      void this.#drain(key, request.projectId, request.path, lane);
    }
    return completion;
  }

  async #drain(key: string, projectId: string, path: string, lane: Lane): Promise<void> {
    while (lane.waiters.length > 0) {
      const offsets = [...lane.offsets].sort((left, right) => left - right);
      lane.offsets.clear();
      const waiters = lane.waiters.splice(0);
      try {
        await this.write({ projectId, path, offsets });
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of waiters) waiter.reject(error);
      }
    }
    lane.running = false;
    if (this.#lanes.get(key) === lane) this.#lanes.delete(key);
  }
}
