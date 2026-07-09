// The platform's runtime SDK, seeded into this repo: the `IterateProjectWorker`
// base class plus the env type it needs. Capability TYPES live in the
// `iterate` package (a devDependency of this repo) and are re-exported below,
// so `./sdk.ts` stays the one import surface for worker code. The runtime part
// is seeded rather than imported because the worker build pipeline installs
// only registry `dependencies` — and `iterate` is a devDependency (worker code
// otherwise only needs its types). Treat this file as read-only — the
// platform's copy is the design of record.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { ItxBinding, StreamEvent, StreamEventBatch } from "iterate/sdk";

export type * from "iterate/sdk";

/** Bindings the platform supplies to every project worker. `ItxBinding`
 * (iterate/sdk) documents the two channels: `get()` for capability method
 * calls, `fetch()` for HTTP into sibling workers. */
export type ProjectWorkerEnv = {
  ITX: ItxBinding;
};

/**
 * Base class for the project worker's event surface: unpacks the platform's
 * checkpointed per-stream batch deliveries into one `processEvent(event)` call
 * per event. Every committed event on every stream in this project lands here
 * — in per-stream order, at-least-once. `event.path` says which stream the
 * event lives on, so reactions read as "if I see such-and-such event on
 * such-and-such path, do such-and-such". Because delivery is at-least-once,
 * give any event a reaction appends an idempotency key derived from what it
 * reacts to — `${event.path}@${event.offset}` — and a redelivery becomes a
 * no-op. Throwing (or a worker that fails to build) leaves that stream's
 * checkpoint in place and the whole batch is redelivered later; return
 * normally to advance past events you don't care about.
 */
export class IterateProjectWorker<
  Env extends ProjectWorkerEnv = ProjectWorkerEnv,
> extends WorkerEntrypoint<Env> {
  async processEventBatch(batch: StreamEventBatch): Promise<void> {
    for (const event of batch.events) await this.processEvent(event);
  }

  /** Override to react to any event on any stream in the project. */
  async processEvent(_event: StreamEvent): Promise<void> {}
}
