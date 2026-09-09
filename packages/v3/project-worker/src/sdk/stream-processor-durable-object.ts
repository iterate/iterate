// stream-processor-durable-object.ts — THE SDK HOST: the `DurableObject` shell that hosts ONE
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
// behind `env.ITX.get()` (itx-entrypoint.ts); the engine's `append`/`read` ride it like any other
// dotted call.
//
// NEVER define alarm(): facets have none (workerd#6810 — the runtime answers "Facets currently
// cannot set alarms."); a timer, when one is needed, is a scheduled append on the context.

import { DurableObject } from "cloudflare:workers";
import { ProcessorEngine, type ScannedRange, type StreamProcessor } from "../stream/processor.ts";
import { ReduceCheckpointTable } from "../stream/reduce-checkpoint.ts";
import type { StreamEvent } from "../stream/events.ts";
import type { ItxEntrypoint } from "../itx-entrypoint.ts";

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
