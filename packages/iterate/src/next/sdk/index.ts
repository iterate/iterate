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
import { parse } from "../expression.ts";
import {
  ProcessorEngine,
  type ScannedRange,
  type StreamProcessor,
  ReduceCheckpointTable,
  type StreamEvent,
  type StreamEventInput,
  type ReviveSchedule,
  type ScheduleReceipt,
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
// cannot set alarms."); a timer, when one is needed, is a scheduled append on the context — the
// engine's own REVIVE is one (processor.ts, rule 3): while a `runInBackground` attempt is in flight
// the context holds a one-shot wake, so a host that dies mid-attempt is pushed and runs its at-head
// pass again (__workers-tests__/agent-revive.test.ts: an LLM call survives its context's death).

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
  builtins: {
    append(...events: StreamEventInput[]): Promise<unknown>;
    readEvents(afterOffset?: number, limit?: number): Promise<unknown>;
    /** The revive's timer (processor.ts rule 3): a one-shot scheduled append, retracted by receipt. */
    schedules: {
      set(input: ReviveSchedule): Promise<unknown>;
      cancel(receipt: ScheduleReceipt): Promise<unknown>;
    };
  };
};

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
        props: { iterateContextName: this.ctx.props.iterateContextName },
      })) as unknown as {
      get(): Scope;
    };
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
        // A stub scope's answers are pipelined shapes by type and plain data on the wire (the
        // engine awaits them): the engine's own types, asserted.
        append: (...events) =>
          this.withItx((itx) => itx.builtins.append(...events)) as Promise<StreamEvent[]>,
        read: (after, limit) =>
          this.withItx((itx) => itx.builtins.readEvents(after, limit)) as Promise<StreamPage>,
        schedule: (input) =>
          this.withItx((itx) => itx.builtins.schedules.set(input)) as Promise<ScheduleReceipt>,
        cancelSchedule: (receipt) => this.withItx((itx) => itx.builtins.schedules.cancel(receipt)),
      },
      storage: new ReduceCheckpointTable(this.ctx.storage.sql),
      name: this.ctx.props.name,
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

// ── ConfigWorker ── THE CONFIG WORKER base class, bundled into `processor.js` (this file).
// A project's ONE event handler AND its web root: every context subscribes
// `itx.cd('/').worker.processEventBatch`, so the "/" context's config worker is called with every
// stream's committed batch; a project host that names no app (the apex `<project>.<base>`,
// src/worker.ts) lands on `itx.worker.fetch(request)`, so `fetch` routes by hostname. `itx.worker` is
// a platform row (itx-expression-rewriting.ts) a project re-points at its own source —
// `itx.provide("itx.worker", "itx.workers.get({ source: itx.repos.get('/repos/config').readFile('worker.ts'), cacheKey })")`
// — with no className: the module's DEFAULT export is the class, as in the bundled no-op default.
// An author writes:
//
//   import { ConfigWorker } from "./processor.js";
//   export default class extends ConfigWorker {
//     async processEvent({ event, itx }) {
//       if (event.type === "events.iterate.com/ping") await itx.builtins.append({ type: "…/pong" });
//     }
//     fetch(request) {
//       if (new URL(request.url).hostname === "acme.example") return this.env.ITX.get().apps.site.fetch(request);
//       return new Response("no app here", { status: 404 });
//     }
//   }
//
// STATELESS by design — it owns no stream and no checkpoint. The SUBSCRIBING context keeps the cursor
// (at-least-once), so `processEvent` must be IDEMPOTENT: an `idempotencyKey` on an appended reaction
// makes a redelivery a no-op. `range` is the contiguous `(after, through]` window the batch proves.

/** The itx scope handed to `processEvent`: `env.ITX.get()` for this batch — the genuine
 *  `IterateContextRpcTarget` RpcTarget, disposed after the batch so it does not pin the parent DO past the turn. */
export type ConfigWorkerItx = ItxScope;

/** One committed event handed to the config worker, with the batch's range and the batch's itx scope. */
export type ConfigEventArgs = { event: StreamEvent; range: ScannedRange; itx: ConfigWorkerItx };

/** A COMMIT TAKES EFFECT: when `repo/commit-completed` lands on the repo the context's `itx.worker`
 *  rule reads its source from — a rule whose target is `itx.workers.get({ source, cacheKey })` with a
 *  `source` producer spelled `itx.repos.get('<that path>')…` — the rule is re-appended with
 *  `cacheKey: <commitOid>`, so the next `itx.worker` call is a cold isolate under a new key and the
 *  producer re-reads the repo. Without this a fixed key would load the new code only after an
 *  eviction. Idempotent by key (one re-point per commit); a rule that does not read from that repo
 *  is left alone. The funnel delivers every stream's events to `/`'s worker, so the reaction runs
 *  where the rule lives. */
async function followCommittedSource(event: StreamEvent, itx: ConfigWorkerItx): Promise<void> {
  if (event.type !== "events.iterate.com/repo/commit-completed") return;
  const commitOid = event.payload?.commitOid;
  if (typeof commitOid !== "string") return;
  const rule = await itx.rewriteRules.get("itx.worker");
  if (!rule || rule.origin !== "context" || !rule.target) return;
  // The rule's target and its `source` producer, spelled out — or NOT followed: a printed target past
  // the codec's cap, a `@` hole, a `source` that is no expression. This runs ahead of the author's
  // hook in every batch, so a rule's shape must never fail the batch (that would halt `/`'s worker).
  let spec: Record<string, unknown>;
  let source: ReturnType<typeof parse>;
  try {
    const [root, workers, get] = parse(rule.target);
    if (root !== "itx" || workers !== "workers" || !Array.isArray(get) || get[0] !== "get") return;
    const candidate = get[1];
    if (
      typeof candidate !== "object" ||
      !candidate ||
      !("source" in candidate) ||
      typeof candidate.source !== "string"
    )
      return;
    spec = candidate;
    source = parse(candidate.source);
  } catch {
    return;
  }
  const [, repos, repoGet] = source;
  if (
    repos !== "repos" ||
    !Array.isArray(repoGet) ||
    repoGet[0] !== "get" ||
    repoGet[1] !== event.path
  )
    return;
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.worker",
      target: ["itx", "workers", ["get", { ...spec, cacheKey: commitOid }]],
    },
    idempotencyKey: `itx.worker@${commitOid}`,
  });
}

/** THE CONFIG WORKER — a stateless `WorkerEntrypoint`. Override `processEvent` (the platform calls
 *  `processEventBatch`, the subscription target) and `fetch` (a project host with no app label).
 *  Nothing to construct, no contract, no reduce. */
export abstract class ConfigWorker<
  Env extends { ITX: ItxEntrypointService } = { ITX: ItxEntrypointService },
> extends WorkerEntrypoint<Env> {
  /** At fetch entry: `const denied = this.auth.require(request); if (denied) return denied;` */
  protected readonly auth = auth;
  /** THE SUBSCRIBED METHOD: a committed batch, in offset order. One `env.ITX.get()` for the whole
   *  batch (the calls pipeline through it), disposed in the `finally` — bounded to this one turn.
   *  Before the author's hook, the one convention the base follows for every project: a commit to
   *  the repo `itx.worker`'s source is read from re-points the rule at that commit. */
  async processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    const itx = this.env.ITX.get();
    try {
      for (const event of events) {
        await followCommittedSource(event, itx);
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
   *  the edge's `itx.worker` dispatch). Route by hostname to `this.env.ITX.get().apps.<x>.fetch(request)`
   *  or answer it here. Default: not found. */
  override fetch(_request: Request): Response | Promise<Response> {
    return new Response("Not found\n", { status: 404 });
  }
}
