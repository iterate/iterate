// stream-processor-durable-object.ts — THE SDK HOST: the `DurableObject` shell that hosts ONE
// `StreamProcessor` as a facet of its context. An author writes two classes — the processor, pure
// (`class PresenceProcessor extends StreamProcessor { contract; reduce(); processEvent() }`, unit-tested with
// `new PresenceProcessor()`), and its host, one line long:
//
//   export class PresenceDurableObject extends StreamProcessorDurableObject {
//     processor = new PresenceProcessor();
//   }
//
// The platform hosts the host through the ordinary
// `itx.load(src).getDurableObjectClass('PresenceDurableObject').get('presence')` — exactly the way
// any stateful class is hosted; a processor is a named facet that additionally gets pushed every
// commit. `processor` is a FIELD so it can take what its effects need from this object
// (`new Notifier(this.env.ITX)`), and so the same class is constructed bare in a test.
//
// IDENTITY is `ctx.props` — `{ contextName, name }` minted by the parent at `getDurableObjectClass(C,
// { props })`, the only party that knows it (pinned in __workers-tests__/facet-props.test.ts); nothing
// else names a processor. THE STREAM is `env.ITX` — the loaded isolate's binding to its owning
// context (itx-entrypoint.ts): `append`/`read` for the engine, `get()` for the scope.
//
// The engine — stream/processor.ts's `ProcessorEngine` — is built on first use with this object's kv
// and `env.ITX`; this class is that wiring plus the doors, ~a screen. Bundled into `processor.js`
// (build-sdk.mjs), so userspace imports it from "./processor.js".
//
// NEVER define alarm(): facets have none (workerd#6810 — the runtime answers "Facets currently
// cannot set alarms."); a timer, when one is needed, will be a scheduled append on the context, not
// an alarm here.

import { DurableObject } from "cloudflare:workers";
import { ProcessorEngine, type ScannedRange, type StreamProcessor } from "../stream/processor.ts";
import type { StreamEvent } from "../stream/events.ts";
import type { ItxEntrypoint } from "../itx-entrypoint.ts";
import {
  DurableObjectNameCodec,
  type DurableObjectAddress,
} from "../context/durable-object-names.ts";

/** What the parent mints the class with — the whole identity. */
export type StreamProcessorProps = { contextName: string; name: string };

export abstract class StreamProcessorDurableObject<
  State = unknown,
  Env extends { ITX: Service<ItxEntrypoint> } = { ITX: Service<ItxEntrypoint> },
> extends DurableObject<Env, StreamProcessorProps> {
  /** The processor this object hosts — `processor = new PresenceProcessor()` at the top of the subclass. */
  abstract readonly processor: StreamProcessor<State>;

  // ── what an author reaches ──

  /** The owning context's parsed address — `{ projectId, path, name }`, `name` its canonical codec
   *  string (the same object the context DO holds). From `ctx.props.contextName`. */
  protected readonly context: DurableObjectAddress = DurableObjectNameCodec.parse(
    this.ctx.props.contextName,
  );
  /** This processor's own name: the facet name, the subscription name, the `.get(name)` name. */
  protected readonly name: string = this.ctx.props.name;
  /** The owning context's itx scope — what a capnweb client holds, reached through `env.ITX`. */
  protected get itx(): Promise<unknown> {
    return this.env.ITX.get();
  }
  /** Emit a delta for the current projection if it changed — after a runtime field on the processor
   *  moved OUTSIDE a batch (an RPC method on this object). Inside `processEvent` the engine
   *  re-projects after the batch on its own. */
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

  // ── the engine: one ProcessorEngine over `processor` and this object's kv, built on first use —
  // `processor` is a subclass field, which does not exist yet while this base class constructs. ──
  #engineBuiltOnFirstUse?: ProcessorEngine<State>;
  get #engine(): ProcessorEngine<State> {
    return (this.#engineBuiltOnFirstUse ??= new ProcessorEngine(this.processor, {
      stream: {
        append: (...events) => this.env.ITX.append(...events),
        read: (after, limit) => this.env.ITX.read(after, limit),
      },
      storage: this.ctx.storage.kv,
    }));
  }
}
