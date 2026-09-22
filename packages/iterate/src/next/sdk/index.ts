// sdk/index.ts — THE userspace SDK surface, bundled (zod included — the owner's call) into every
// loaded isolate as `processor.js` (os-next's scripts/vite-plugin-processor-sdk.ts bundles it):
//
//   import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
//
// The two workerd HOSTS live here too (this file imports cloudflare:workers; the node lane never imports it):
//   StreamProcessorDurableObject — the `DurableObject` shell that hosts ONE `StreamProcessor` as a facet
//   ConfigWorker                 — the stateless `WorkerEntrypoint` a project's one event handler extends

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { IterateContextApi, StreamPage } from "../api.ts";
import {
  ProcessorEngine,
  type ScannedRange,
  type StreamProcessor,
  ReduceCheckpointTable,
  type StreamEvent,
  type StreamEventInput,
} from "../stream/processor.ts";
import { auth } from "./auth.ts";
export { auth };
export {
  StreamProcessor,
  defineProcessorContract,
  jsonEqual,
  type ConsumedEvent,
  type EventCatalog,
  type EventDefinition,
  type EmittedEventInput,
  type EventInput,
  type ProcessorContract,
  type ProcessorState,
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
export { LiveState, type LiveStateSink } from "../stream/processor.ts";
// LIVE STATE for a mini-app DO that is NOT a processor (a processor's base owns one internally):
// `new LiveState({ append: (e) => env.ITX.get().append(e) }, "chat", {…})` — a field initializer
// cannot await — then `set` to mutate and `snapshot()` as the client seed door (stream/processor.ts).
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
// cannot set alarms."); a timer, when one is needed, is a scheduled append on the context. The
// engine's own recovery is a CLAIM on the context's alarm (processor.ts, rule 3): while a
// `runInBackground` attempt is in flight the context owes this facet a `revive()`, so a host that
// dies mid-attempt is re-materialized and runs its at-head pass again
// (__workers-tests__/agent-revive.test.ts: an LLM call survives its context's death).

/** What the parent mints the class with — the whole identity. */
export type StreamProcessorProps = { iterateContextName: string; name: string };

/** The itx scope as `env.ITX.get()` hands it over: a context's declared API (api.ts) — a capnweb stub
 *  of os-next's `IterateContextRpcTarget`, which satisfies it. */
export type ItxScope = IterateContextApi;
/** What hands the scope over: the loopback entrypoint a loaded worker has as `env.ITX`, or the one a
 *  class of the platform's own worker mints from `ctx.exports`. */
export type ItxEntrypointService = { get(): ItxScope };
/** The least a host needs of its scope: the fixed-point log calls the engine makes. The platform's own
 *  facets pass the Workers-RPC STUB of a context (every dotted step pipelined; a property there is a
 *  promise), which no plain-promise interface can name — so the constraint is this, not `ItxScope`. */
export type ProcessorScope = {
  append(...events: StreamEventInput[]): Promise<unknown>;
  readEvents(afterOffset?: number, limit?: number): Promise<unknown>;
  /** The engine's claim on the context's alarm (processor.ts rule 3): "come back by `at`", or null. */
  processors: { claim(name: string, at: number | null): Promise<unknown> };
  /** Another context of the project — where `appendTo` lands — by its dotted surface (`.append`),
   *  which the platform's handle and a loaded worker's alike answer. Through the table like every
   *  other word here: a loaded processor's `cd` goes down only (the app wall), the platform's own
   *  go anywhere. */
  cd(path: string): { append(...events: StreamEventInput[]): Promise<unknown> };
};

/** THE SCOPE ACCESSOR a host hands its processor: one pipelined round trip on the context's itx,
 *  released after (`StreamProcessorDurableObject.withItx`). A processor that needs an effect —
 *  `itx.cfArtifacts.create(path)`, `itx.ai.run(…)` — takes this and nothing else, so a unit test
 *  hands it a fake and the e2e lends one by rule on the context. */
export type WithItx<Scope = ItxScope> = <T>(call: (itx: Scope) => T) => Promise<Awaited<T>>;

export abstract class StreamProcessorDurableObject<
  State = unknown,
  Env extends { ITX?: ItxEntrypointService } = { ITX: ItxEntrypointService },
  Scope extends ProcessorScope = ItxScope,
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
  /** THE REVIVE: the context's alarm pass calls it for a due claim — catch up, then run the
   *  at-head pass, so an attempt the last incarnation was running is started again from state. */
  revive(): Promise<void> {
    return this.#engine.revive();
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

  /** The loopback to this facet's context: a LOADED class gets it as `env.ITX` (the loader bakes the
   *  stub in, worker-loader.ts); a class of THIS worker hosted through `ctx.exports` has the
   *  worker's real env and mints the same stub itself from its props — `ctx.exports` is populated
   *  inside a facet (__workers-tests__/facet-props.test.ts). */
  #itxEntrypoint(): { get(): Scope } {
    return (this.env.ITX ??
      (
        this.ctx.exports as unknown as {
          ItxEntrypoint: (options: { props: object }) => ItxEntrypointService;
        }
      ).ItxEntrypoint({
        // PLATFORM: this worker's own class, minted from its own exports — the full handle, the fixed
        // point spellable, `cd` free to go up. A LOADED class never reaches this branch (it has
        // `env.ITX`, baked in by the loader, and its own module's exports).
        props: { iterateContextName: this.ctx.props.iterateContextName, platform: true },
      })) as unknown as {
      get(): Scope;
    };
  }
  // ── the engine: one ProcessorEngine over `processor` and this object's storage, built on first use —
  // `processor` is a subclass field, which does not exist yet while this base class constructs. ──
  #engineBuiltOnFirstUse?: ProcessorEngine<State>;
  get #engine(): ProcessorEngine<State> {
    return (this.#engineBuiltOnFirstUse ??= new ProcessorEngine(this.processor, {
      // The engine's own emits, catch-up and gap repair are the CONTEXT ROOTS `append`, `readEvents`,
      // `processors.claim` — implicit in every context (itx-expression-rewriting.ts rule 3), so they
      // resolve to this log with no row and no hop; a row at `itx.append` is the OWNER's deliberate
      // wall (a jailed processor halts visibly), never a loaded worker's — the fixed point is not a
      // loaded worker's word. `appendTo` is `cd` through the same table: a first-party saga (the
      // platform's mint) reaches `/`; a loaded processor's `cd` goes down only.
      stream: {
        // A stub scope's answers are pipelined shapes by type and plain data on the wire (the
        // engine awaits them): the engine's own types, asserted.
        append: (...events) =>
          this.withItx((itx) => itx.append(...events)) as Promise<StreamEvent[]>,
        appendTo: (path, ...events) =>
          this.withItx((itx) => itx.cd(path).append(...events)) as Promise<StreamEvent[]>,
        read: (after, limit) =>
          this.withItx((itx) => itx.readEvents(after, limit)) as Promise<StreamPage>,
        claim: (at) => this.withItx((itx) => itx.processors.claim(this.ctx.props.name, at)),
      },
      storage: new ReduceCheckpointTable(this.ctx.storage.sql),
    }));
  }

  /** ONE pipelined round trip on the itx scope, then RELEASE it: `env.ITX.get()` and the call
   *  pipelined on it PIN THE PARENT DO until GC (the "GC is too late" defect the DO's facet door
   *  fixes in the other direction). Await the answer — plain data, the wire already copied it —
   *  then dispose the call AND the get. Protected: a host with methods of its own (the workspace,
   *  src/workspace/durable-object.ts) reaches its context the same way. */
  protected async withItx<T>(call: (itx: Scope) => T): Promise<Awaited<T>> {
    const itx = this.#itxEntrypoint().get();
    const result = call(itx);
    try {
      return await result;
    } finally {
      (result as unknown as Disposable)[Symbol.dispose]?.();
      (itx as unknown as Disposable)[Symbol.dispose]?.();
    }
  }
}

// ConfigWorker is a stateless event handler loaded with an explicit workers.get spec.
// Subscribe its processEventBatch method explicitly; fetch routing is configured separately.
export type ConfigWorkerItx = ItxScope;
export type ConfigEventArgs = { event: StreamEvent; range: ScannedRange; itx: ConfigWorkerItx };

export abstract class ConfigWorker<
  Env extends { ITX: ItxEntrypointService } = { ITX: ItxEntrypointService },
> extends WorkerEntrypoint<Env> {
  /** At fetch entry: `const denied = this.auth.require(request); if (denied) return denied;` */
  protected readonly auth = auth;
  /** Process an explicitly subscribed batch with this worker's context scope. */
  async processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    const itx = this.env.ITX.get();
    try {
      for (const event of events) {
        await this.processEvent({ event, range, itx });
      }
    } finally {
      (itx as unknown as Disposable)[Symbol.dispose]?.();
    }
  }

  /** THE AUTHOR HOOK — one event at a time, in offset order. Append reactions through the itx scope;
   *  make them idempotent (a redelivery must be a no-op). Default: ignore the event. */
  processEvent(_args: ConfigEventArgs): void | Promise<void> {}

  /** THE WEB ROOT — the Request a project host with no app label rode in on (`x-iterate-app` absent;
   *  the project's configured ingress target). Route by hostname to `this.env.ITX.get().apps.<x>.fetch(request)`
   *  or answer it here. Default: not found. */
  override fetch(_request: Request): Response | Promise<Response> {
    return new Response("Not found\n", { status: 404 });
  }
}
