// Checkpointed event delivery from one stream to the project's default worker.
//
// Every project-scoped stream pumps its committed events into the project
// worker's `processEventBatch(batch)` — the same `StreamEventBatch` envelope
// live subscribers receive. Unlike a live subscription (a retained callback
// whose checkpoint lives with the subscriber), the project worker is a
// stateless entrypoint: it can hold neither a session nor a durable cursor.
// So the roles invert — the stream owns the checkpoint, delivers by invoking
// the worker over capability dispatch, and only advances the cursor when the
// worker returns without throwing. That makes delivery at-least-once with
// per-stream ordering: a worker that is still cold-building (or broken) simply
// leaves the checkpoint where it is, and a later drain replays from there.
//
// Failures never wedge the stream and never append events (a failure that
// appended to this same stream would re-wake the pump — a feedback loop):
// they log, back off with bounded in-memory retries, and give up until the
// next append or DO wake re-arms the pump. The durable cursor survives
// eviction; timers deliberately do not (same reasoning as the configured
// subscriber wake retries in stream-durable-object.ts).

import type { StreamEventBatch } from "./rpc-types.ts";
import type { StreamEvent } from "./schemas.ts";
import type { CoreProcessorState } from "./core-processor-contract.ts";

const DELIVERY_BATCH_LIMIT = 100;

// Retry cadence for a failing drain: 500ms doubling to a 30s cap, giving up
// after 6 attempts. After giving up, each later wake (one per append burst or
// DO wake) gets exactly one fresh attempt, so a permanently broken worker
// costs bounded noise instead of a hot loop, and a fixed worker catches up on
// the next event without operator action.
const MAX_DELIVERY_RETRY_ATTEMPTS = 6;

/** The storage/dispatch seams the owning Stream Durable Object provides. */
type ProjectWorkerDeliveryHooks = {
  /** Log label naming this delivery's destination (default "Project worker"). */
  label?: string;
  /** Synchronous committed-event range read from stream storage. */
  readEvents(args: { afterOffset: number; limit: number }): StreamEvent[];
  /** Current core reduced state, read in the same synchronous block as each delivery. */
  coreState(): CoreProcessorState;
  /** Highest offset the project worker has successfully processed. */
  readCheckpoint(): number;
  /** Persist the new checkpoint. Runs only after `deliver` resolves. */
  writeCheckpoint(offset: number): void;
  /** Invoke `processEventBatch(batch)` on the project worker. */
  deliver(batch: StreamEventBatch): Promise<void>;
};

/** Serializable debug view for `runtimeState()`. */
export type ProjectWorkerDeliveryRuntimeState = {
  checkpoint: number;
  consecutiveFailures: number;
  retryScheduled: boolean;
};

export class ProjectWorkerDelivery {
  readonly #hooks: ProjectWorkerDeliveryHooks;
  #draining = false;
  #consecutiveFailures = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(hooks: ProjectWorkerDeliveryHooks) {
    this.#hooks = hooks;
  }

  /**
   * Re-arm the pump after a commit or DO wake. Idempotent: a drain already in
   * flight picks up newly committed events on its next loop iteration, and a
   * pending backoff timer keeps its schedule instead of being preempted.
   */
  wake(): void {
    if (this.#retryTimer !== undefined) return;
    void this.#drain();
  }

  runtimeState(): ProjectWorkerDeliveryRuntimeState {
    return {
      checkpoint: this.#hooks.readCheckpoint(),
      consecutiveFailures: this.#consecutiveFailures,
      retryScheduled: this.#retryTimer !== undefined,
    };
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    let failed = false;
    try {
      while (true) {
        const afterOffset = this.#hooks.readCheckpoint();
        const events = this.#hooks.readEvents({
          afterOffset,
          limit: DELIVERY_BATCH_LIMIT,
        });
        const lastOffset = events.at(-1)?.offset;
        if (lastOffset === undefined) {
          this.#consecutiveFailures = 0;
          return;
        }
        const state = this.#hooks.coreState();
        if (state.projectId === undefined || state.path === undefined) {
          // Coordinates land with the stream's very first event, so a drain
          // that found events but no coordinates is unreachable in practice.
          throw new Error("Cannot deliver stream batch before stream coordinates are initialized.");
        }
        await this.#hooks.deliver({
          projectId: state.projectId,
          path: state.path,
          events,
          streamMaxOffset: state.maxOffset,
          // Read in the same synchronous block as streamMaxOffset, so the two
          // always correspond (state-at-streamMaxOffset, exactly like live
          // subscription batches — see stream-connections.ts).
          state,
        });
        this.#hooks.writeCheckpoint(lastOffset);
        this.#consecutiveFailures = 0;
      }
    } catch (error) {
      failed = true;
      this.#consecutiveFailures += 1;
      console.error(`${this.#hooks.label ?? "Project worker"} event delivery failed`, {
        checkpoint: this.#hooks.readCheckpoint(),
        consecutiveFailures: this.#consecutiveFailures,
        error,
      });
    } finally {
      this.#draining = false;
    }
    if (failed) this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== undefined) return;
    if (this.#consecutiveFailures > MAX_DELIVERY_RETRY_ATTEMPTS) {
      console.error(
        `${this.#hooks.label ?? "Project worker"} event delivery retries exhausted; waiting for next append`,
        {
          checkpoint: this.#hooks.readCheckpoint(),
          attempts: this.#consecutiveFailures,
        },
      );
      return;
    }
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = undefined;
        void this.#drain();
      },
      Math.min(30_000, 500 * 2 ** (this.#consecutiveFailures - 1)),
    );
  }
}
