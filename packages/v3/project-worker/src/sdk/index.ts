// sdk/index.ts — THE userspace SDK surface, bundled (zod included — the owner's call) into every
// loaded isolate as `processor.js` by build-sdk.mjs:
//
//   import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
//
// The two workerd HOSTS live here too (this file imports cloudflare:workers; the node lane never imports it):
//   StreamProcessorDurableObject — the `DurableObject` shell that hosts ONE `StreamProcessor` as a facet
//   ConfigWorker                 — the stateless `WorkerEntrypoint` a project's one event handler extends

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  ProcessorEngine,
  type ScannedRange,
  type StreamProcessor,
  ReduceCheckpointTable,
  type StreamEvent,
} from "../stream/processor.ts";
import type { ItxEntrypoint } from "../iterate-context.ts";

export {
  StreamProcessor,
  defineProcessorContract,
  jsonEqual,
  type ProcessorContract,
  type ProcessorStream,
  type ProcessEventArgs,
  type ReduceArgs,
  type ScannedRange,
  type StreamEvent,
  type StreamEventInput,
} from "../stream/processor.ts";
export { z } from "zod";
// capnweb's CLIENT constructors, so userspace can dial a remote capnweb API from inside its isolate
// through the context's own egress, and `newWorkersRpcResponse`, the SERVER half, so a loaded worker
// can serve a capnweb API over its `fetch`. The HTTP batch is exported ON PURPOSE beside the
// WebSocket session: a stateless entrypoint answering one method with one remote call has no session
// to hold across calls, and a one-shot POST is the honest shape (the lint rule targets long-lived workers).
// eslint-disable-next-line iterate/no-capnweb-http-batch -- userspace one-shot remote calls; see above
export { newHttpBatchRpcSession, newWebSocketRpcSession, newWorkersRpcResponse } from "capnweb";
export { applyPatch, diff, type PatchOp } from "../lib.ts";

// LIVE STATE for a mini-app DO that is NOT a processor (a processor's base owns one internally):
// `new LiveState({ append: (e) => env.ITX.get().append(e) }, "chat", {…})` — a field initializer
// cannot await — then `set` to mutate and `snapshot()` as the client seed door (stream/processor.ts).
export { LiveState, type LiveStateSink } from "../stream/processor.ts";
// ── StreamProcessorDurableObject ── THE SDK HOST: the `DurableObject` shell that hosts ONE
// `StreamProcessor` as a facet of its context. An author writes the pure processor and its host,
// one line long:
//
//   export class PresenceDurableObject extends StreamProcessorDurableObject {
//     processor = new PresenceProcessor();
//   }
//
// hosted through the ordinary `itx.facets.get('presence', { source, className: 'PresenceDurableObject' })`
// — a processor is a named facet that additionally gets pushed every commit. `processor` is a FIELD
// so it can take what its effects need from this object (`new Notifier(this.env.ITX)`), and so the
// same class is constructed bare in a test.
//
// IDENTITY is `ctx.props` — `{ iterateContextName, name }`, minted by the parent, the only party
// that knows it (pinned in __workers-tests__/facet-props.test.ts). THE STREAM is the itx scope
// behind `env.ITX.get()` (iterate-context.ts `ItxEntrypoint`); the engine's `append`/`read` ride it like any other
// dotted call.
//
// NEVER define alarm(): facets have none (workerd#6810 — the runtime answers "Facets currently
// cannot set alarms."); a timer, when one is needed, is a scheduled append on the context.

/** What the parent mints the class with — the whole identity. */
export type StreamProcessorProps = { iterateContextName: string; name: string };

/** The itx scope as `env.ITX.get()` hands it over: the pipelined `IterateContext` stub. */
type ItxScope = ReturnType<Service<ItxEntrypoint>["get"]>;

export abstract class StreamProcessorDurableObject<
  State = unknown,
  Env extends { ITX: Service<ItxEntrypoint> } = { ITX: Service<ItxEntrypoint> },
> extends DurableObject<Env, StreamProcessorProps> {
  /** The processor this object hosts — `processor = new PresenceProcessor()` at the top of the subclass. */
  abstract readonly processor: StreamProcessor<State>;

  // ── what an author reaches (the itx scope is `this.env.ITX.get()`, typed; identity is `this.ctx.props`) ──

  /** After a runtime field on the processor moved OUTSIDE a batch (an RPC method on this object);
   *  inside `processEvent` the engine re-projects on its own. */
  protected publishLiveState(): void {
    this.#engine.publishLiveState();
  }

  // ── the doors the delivery loop and `itx.facets.get(name)` reach ──

  /** THE push door: the context hands over each committed batch with its scanned-range proof. */
  processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    return this.#engine.processEventBatch(events, range);
  }
  /** Catch up from the log (the read-your-writes entry after an eviction). */
  catchUpFromLog(): Promise<void> {
    return this.#engine.catchUpFromLog();
  }
  /** Caught up through the log, then `{ offset, state }`. */
  snapshot(): Promise<{ offset: number; state: State }> {
    return this.#engine.snapshot();
  }
  /** The live-state seed door: `{ rev, state: projectLiveState(reduced) }`. */
  liveSnapshot(): Promise<{ rev: number; state: unknown }> {
    return this.#engine.liveSnapshot();
  }
  /** The barrier: resolves once processed at least through `offset` (default timeout 10s). */
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    return this.#engine.waitUntilProcessed(input);
  }

  // ── the engine: one ProcessorEngine over `processor` and this object's storage, built on first use —
  // `processor` is a subclass field, which does not exist yet while this base class constructs. ──
  #engineBuiltOnFirstUse?: ProcessorEngine<State>;
  get #engine(): ProcessorEngine<State> {
    return (this.#engineBuiltOnFirstUse ??= new ProcessorEngine(this.processor, {
      // THE PLATFORM NEVER SPELLS A SHORT NAME: the engine's own emits, catch-up and gap repair go to
      // the fixed point, `itx.builtins.…` — a context's rows (a whole-context override, a mask at
      // `itx.append`) redirect the processor's calls to `itx.…`, never its log traffic.
      stream: {
        append: (...events) => this.#withItx((itx) => itx.builtins.append(...events)),
        read: (after, limit) => this.#withItx((itx) => itx.builtins.readEvents(after, limit)),
      },
      storage: new ReduceCheckpointTable(this.ctx.storage.sql),
    }));
  }

  /** ONE pipelined round trip on the itx scope, then RELEASE it: `env.ITX.get()` and the call
   *  pipelined on it PIN THE PARENT DO until GC (the "GC is too late" defect the DO's facet door
   *  fixes in the other direction). Await the answer — plain data, the wire already copied it —
   *  then dispose the call AND the get. */
  async #withItx<T>(call: (itx: ItxScope) => T): Promise<Awaited<T>> {
    const itx = this.env.ITX.get();
    const result = call(itx);
    try {
      return await result;
    } finally {
      (result as unknown as Disposable)[Symbol.dispose]?.();
      (itx as unknown as Disposable)[Symbol.dispose]?.();
    }
  }
}

// ── ConfigWorker ── THE CONFIG WORKER base class, bundled into `processor.js` (this file).
// A project's ONE event handler: every context subscribes `itx.cd('/').worker.processEventBatch`, so
// the "/" context's config worker is called with every stream's committed batch. `itx.worker` is a
// platform row (itx-expression-rewriting.ts) a project re-points at its own source —
// `itx.provide("itx.worker", "itx.workers.get({ source: itx.repos.readFile('config','worker.ts'), cacheKey })")`
// — with no className: the module's DEFAULT export is the class, as in the bundled no-op default.
// An author writes:
//
//   import { ConfigWorker } from "./processor.js";
//   export default class extends ConfigWorker {
//     async processEvent({ event, itx }) {
//       if (event.type === "events.iterate.com/ping") await itx.builtins.append({ type: "…/pong" });
//     }
//   }
//
// STATELESS by design — it owns no stream and no checkpoint. The SUBSCRIBING context keeps the cursor
// (at-least-once), so `processEvent` must be IDEMPOTENT: an `idempotencyKey` on an appended reaction
// makes a redelivery a no-op. `range` is the contiguous `(after, through]` window the batch proves.

/** The itx scope handed to `processEvent`: `env.ITX.get()` for this batch — the genuine
 *  `IterateContext` RpcTarget, disposed after the batch so it does not pin the parent DO past the turn. */
export type ConfigWorkerItx = ReturnType<Service<ItxEntrypoint>["get"]>;

/** One committed event handed to the config worker, with the batch's range and the batch's itx scope. */
export type ConfigEventArgs = { event: StreamEvent; range: ScannedRange; itx: ConfigWorkerItx };

/** THE CONFIG WORKER — a stateless `WorkerEntrypoint`. Override `processEvent`; the platform calls
 *  `processEventBatch` (the subscription target). Nothing to construct, no contract, no reduce. */
export abstract class ConfigWorker<
  Env extends { ITX: Service<ItxEntrypoint> } = { ITX: Service<ItxEntrypoint> },
> extends WorkerEntrypoint<Env> {
  /** THE SUBSCRIBED METHOD: a committed batch, in offset order. One `env.ITX.get()` for the whole
   *  batch (the calls pipeline through it), disposed in the `finally` — bounded to this one turn. */
  async processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    const itx = this.env.ITX.get();
    try {
      for (const event of events) await this.processEvent({ event, range, itx });
    } finally {
      (itx as unknown as Disposable)[Symbol.dispose]?.();
    }
  }

  /** THE AUTHOR HOOK — one event at a time, in offset order. Append reactions through the itx scope;
   *  make them idempotent (a redelivery must be a no-op). Default: ignore the event. */
  processEvent(_args: ConfigEventArgs): void | Promise<void> {}
}
