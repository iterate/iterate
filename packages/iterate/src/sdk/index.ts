// sdk/index.ts — THE SDK's HOSTS, the workerd classes a loaded worker extends (this file imports
// cloudflare:workers; the Node unit tests never import it):
//   FacetDurableObject           — the `DurableObject` shell a context hosts as a facet: its class lists
//                                  the methods a caller reaches by itx expression (`publicMethods`)
//   StreamProcessorDurableObject — the facet shell that hosts ONE `StreamProcessor`
//   IterateConfigEntrypoint      — the stateless `WorkerEntrypoint` a project's config repo exports
// and capnweb's constructors (below), which loaded code has no other platform path to.
//
// Everything else has one path of its own: a processor's surface (`StreamProcessor`,
// `defineProcessorContract`, `LiveState`, the event and contract types) is `iterate/stream/processor`,
// which runs in Node too; zod is `zod`. A loaded worker imports each
// by name and the loader links this deployment's own build of it (core/os/scripts/build.ts):
//
//   import { StreamProcessorDurableObject } from "iterate/sdk";
//   import { StreamProcessor, defineProcessorContract } from "iterate/stream/processor";
//   import { z } from "zod";

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  InstalledAppRoots,
  IterateContextApi,
  IterateContextApiWith,
  StreamPage,
} from "../api.ts";
import {
  ProcessorEngine,
  type ScannedRange,
  type StreamProcessor,
  ReduceCheckpointTable,
  type StreamEvent,
  type StreamEventInput,
} from "../stream/processor.ts";
// The hosts' `callWithCause` and `fetch` run what they call under the cause the platform hands them
// (../cause.ts).
import { causeOfRequest, runCausedBy } from "../cause.ts";
import { auth } from "./auth.ts";
import { walkUnderCause, type RpcSteps } from "./call-with-cause.ts";
// The hosts' `this.getItx()` is this (itx-scope.ts says why a scope is never kept).
import { itxScope } from "./itx-scope.ts";
// capnweb's CLIENT constructors, so userspace can dial a remote capnweb API from inside its isolate
// through the context's own egress, and `newWorkersRpcResponse`, the SERVER half, so a loaded worker
// can serve a capnweb API over its `fetch`. The HTTP batch is exported ON PURPOSE beside the
// WebSocket session: a stateless entrypoint answering one method with one remote call has no session
// to hold across calls, and a one-shot POST is the honest shape (the lint rule targets long-lived workers).
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- userspace one-shot remote calls; see above
export { newHttpBatchRpcSession, newWebSocketRpcSession, newWorkersRpcResponse } from "capnweb";
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
// so it can take what its effects need from this object — reach as an accessor, never a scope:
// `new Notifier(() => this.getItx())` — and so the same class is constructed bare in a test. A
// method of the host's own that callers reach by itx expression goes on its list:
// `static override publicMethods = [...super.publicMethods, "message"]`.
//
// IDENTITY is `ctx.props` — `{ iterateContextName, name }`, minted by the parent, the only party
// that knows it (pinned in test/vitest/os-workers/facets.test.ts), plus `fedByPushes` when a row
// pushes it (FacetProps). THE STREAM is the itx scope `this.getItx()` hands out (core/os
// iterate-context.ts `ItxEntrypoint`); the engine's `append`/`read` ride it like any other dotted call.
//
// NEVER define alarm(): facets have none (workerd#6810 — the runtime answers "Facets currently
// cannot set alarms."); a timer, when one is needed, is a scheduled append on the context. The
// engine's own recovery is a CLAIM on the context's alarm (processor.ts, rule 3): while a
// `runInBackground` attempt is in flight the context owes this facet a `revive()`, so a host that
// dies mid-attempt is re-materialized and runs its at-head pass again
// (test/vitest/os-workers/agent-revive.test.ts: an LLM call survives its context's death).
//
// THE CLAIM IS ALSO WHAT KEEPS A FACET RUNNING: a loaded facet that holds none when its context
// starts a new incarnation is reset then (os FacetHost `resetUnclaimedLoadedFacets`). So work that
// must outlive the call that started it — a model request, a retry's backoff sleep, an open
// provider socket — runs through `runInBackground` (ProcessEventArgs), never as a bare floating
// promise, a `ctx.waitUntil` or a timer the facet keeps on its own.

/** What the parent mints a facet's class with — the whole identity, and one fact about its feed. */
export type FacetProps = {
  iterateContextName: string;
  name: string;
  /** Set when, as this facet started, a subscription row of its context pushed it every commit it
   *  consumes (`processEventBatch`, the delivery loop's push): a processor's engine then trusts the
   *  head a catch-up read until the next push (stream/processor.ts, the read verbs). Absent, only a
   *  push is proof, so a processor no row pushes reads its log on every read. */
  fedByPushes?: true;
  /** The code it was started on, as the parent names it (its loaded identity, or the deploy): work
   *  in flight that died with a restart onto other code is no death of that work (stream/processor.ts). */
  codeId?: string;
};

/** THE FACET SHELL: a `DurableObject` a context hosts as a facet — `itx.facets.get(name, { source,
 *  className })`, a rule naming it, or a processor's row. A caller reaches a facet by itx expression
 *  (`itx.facets.get(name).<method>(…)`) only through what its class lists in `publicMethods`: the
 *  context refuses any other first step FORBIDDEN before the call reaches the facet
 *  (core/os context/facet-public-methods.ts). The platform's own calls — the delivery loop's push
 *  and catch-up, the alarm's revive — never go through the list. A loaded class that does not
 *  extend this shell lists nothing, so no caller reaches it by expression. */
export abstract class FacetDurableObject<
  Env extends { ITX?: ItxEntrypointService } = { ITX: ItxEntrypointService },
  Scope = IterateContextApi,
> extends DurableObject<Env, FacetProps> {
  /** What a caller may reach by itx expression: the FIRST step of `itx.facets.get(name).<step>…`, a
   *  method or a property of this class. A subclass lists its own on top of its parent's:
   *  `static override publicMethods = [...super.publicMethods, "send"]`. */
  static publicMethods: readonly string[] = ["fetch"];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A Request the facet serves runs under the cause it carries (../cause.ts).
    const serve = (this as { fetch?: (request: Request) => unknown }).fetch;
    if (serve)
      this.fetch = (request: Request) =>
        runCausedBy(causeOfRequest(request), () => serve.call(this, request)) as Promise<Response>;
  }

  /** THE CALL UNDER A CAUSE (`walkUnderCause`): a caller's `itx.facets.get(name).<steps>`, the
   *  alarm's revive. On no list: only the platform calls it (core/os context/facet-host.ts). */
  callWithCause(cause: unknown, steps: RpcSteps): Promise<unknown> {
    return walkUnderCause(this, cause, steps);
  }

  /** This class's `publicMethods`, for the context that loaded it — a static does not cross the
   *  isolate. On no list: only the context asks it. */
  listPublicMethods(): readonly string[] {
    // `this.constructor` is the concrete facet class, a subclass of this one; TypeScript types it as
    // `Function`, which has no `publicMethods`.
    return (this.constructor as typeof FacetDurableObject).publicMethods;
  }

  /** `using itx = this.getItx()`: this facet's context's scope, released with every call made
   *  through it when the block ends (itx-scope.ts). Keep no RPC values past the block; see
   *  test/vitest/os/context-residency.e2e.test.ts, "A FACET DOES NOT OUTLIVE ITS CONTEXT", for why.
   *  A field, not a method: Workers RPC reaches a class's methods, and no caller may get the scope. */
  protected readonly getItx = (): Scope & Disposable => itxScope(this.#itxEntrypoint());

  /** The loopback to this facet's context: a LOADED class gets it as `env.ITX` (the loader bakes the
   *  stub in, worker-loader.ts); a class of THIS worker hosted through `ctx.exports` has the
   *  worker's real env and mints the same stub itself from its props — `ctx.exports` is populated
   *  inside a facet (test/vitest/os-workers/facets.test.ts). The casts name what workers-types cannot:
   *  this worker's own `ItxEntrypoint` export, and the scope its `get` answers, which `Scope` is. */
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
}

/** What hands the itx scope over — a loaded worker's `env.ITX`, or the loopback a class of the
 *  platform's own worker mints from `ctx.exports`: `get()` its scope (a context's declared API,
 *  api.ts, which a capnweb stub of core/os's `IterateContextRpcTarget` satisfies), or `fetch` a
 *  request through the context's dispatch (a fetch route's target, the `x-itx-expression` header). */
export type ItxEntrypointService = {
  get(): IterateContextApi;
  fetch(request: Request): Promise<Response>;
};
/** The least a host needs of its scope: the fixed-point log calls the engine makes. The platform's own
 *  facets pass the Workers-RPC STUB of a context (every dotted step pipelined; a property there is a
 *  promise), which no plain-promise interface can name — so the constraint is this, not
 *  `IterateContextApi`. */
export type ProcessorScope = {
  append(...events: StreamEventInput[]): Promise<unknown>;
  readEvents(afterOffset?: number, limit?: number): Promise<unknown>;
  /** The engine's claim on the context's alarm (processor.ts rule 3): "come back by `at`", or null. */
  processors: { claim(name: string, at: number | null): Promise<unknown> };
  /** Another context of the project by its dotted surface (`.append`), which the platform's handle
   *  and a loaded worker's alike answer — how an entity's processor cross-posts its certificate to
   *  `/` (`itx.cd("/").append(certificate)`). Through the table like every other
   *  word here: anyone's `cd(path).append` reaches any context of the project, stamped with where
   *  it came from; a jail's bare null refuses it. */
  cd(path: string): { append(...events: StreamEventInput[]): Promise<unknown> };
};

export abstract class StreamProcessorDurableObject<
  State = unknown,
  Env extends { ITX?: ItxEntrypointService } = { ITX: ItxEntrypointService },
  Scope extends ProcessorScope = IterateContextApi,
> extends FacetDurableObject<Env, Scope> {
  /** The reads a caller reaches on every processor: `fetch`, and the state caught up through the log
   *  (`snapshot`, `liveSnapshot`) or awaited (`waitUntilProcessed`). What feeds the processor —
   *  `processEventBatch`, `catchUpFromLog`, `revive` — is the platform's, never a caller's. */
  static override publicMethods = [
    ...super.publicMethods,
    "snapshot",
    "liveSnapshot",
    "waitUntilProcessed",
  ];

  /** The processor this object hosts — `processor = new PresenceProcessor()` at the top of the subclass. */
  abstract readonly processor: StreamProcessor<State>;

  // ── what an author reaches (the itx scope: `this.getItx()`; identity: `this.ctx.props`) ──

  /** After a runtime field on the processor moved OUTSIDE a batch (an RPC method on this object);
   *  inside `processEvent` the engine re-projects on its own. */
  protected publishLiveState(): void {
    this.#engine.publishLiveState();
  }

  // ── what the platform calls: the delivery loop's push and catch-up, the alarm's revive ──

  /** THE push: the context hands over each committed batch with its scanned-range proof. */
  processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    return this.#engine.processEventBatch(events, range);
  }
  /** Catch up from the log (the delivery loop's, when a row is configured or resumed). */
  catchUpFromLog(): Promise<void> {
    return this.#engine.catchUpFromLog();
  }
  /** THE REVIVE: the context's alarm pass calls it for a due claim — catch up, then run the
   *  at-head pass, so an attempt the last incarnation was running is started again from state. */
  revive(): Promise<void> {
    return this.#engine.revive();
  }

  // ── what a caller reaches by itx expression (`publicMethods`) ──

  /** Caught up through the log, then `{ offset, state }`. */
  snapshot(): Promise<{ offset: number; state: State }> {
    return this.#engine.snapshot();
  }
  /** The live-state seed read: `{ rev, state: projectLiveState(reduced) }`. */
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
      // The engine's own emits, catch-up and gap repair are the CONTEXT ROOTS `append`, `readEvents`,
      // `processors.claim` — implicit in every context (itx-expression-rewriting.ts rule 3), so they
      // resolve to this log with no row and no hop; a row at `itx.append` is the OWNER's deliberate
      // wall (a jailed processor halts visibly), never a loaded worker's — the fixed point is not a
      // loaded worker's word.
      stream: {
        // A stub scope's answers are pipelined shapes by type and plain data on the wire (the
        // engine awaits them): the engine's own types, asserted.
        append: async (...events) => {
          using itx = this.getItx();
          return (await itx.append(...events)) as StreamEvent[];
        },
        read: async (after, limit) => {
          using itx = this.getItx();
          return (await itx.readEvents(after, limit)) as StreamPage;
        },
        claim: async (at) => {
          using itx = this.getItx();
          return await itx.processors.claim(this.ctx.props.name, at);
        },
      },
      storage: new ReduceCheckpointTable(this.ctx.storage.sql),
      fedByPushes: this.ctx.props.fedByPushes === true,
      kv: this.ctx.storage.kv,
      codeId: this.ctx.props.codeId,
    }));
  }
}

/** What `processEvent` is handed: one event, and the project's root, typed with the installed apps
 *  the config repo's init case gives it (`IterateConfigProcessEventArgs<"agents">`). */
export type IterateConfigProcessEventArgs<App extends keyof InstalledAppRoots = never> = {
  event: StreamEvent;
  itx: IterateContextApiWith<App>;
};

/** Stateless config entrypoint, the default export of a project's config repo; its init handles
 *  `events.iterate.com/project/worker-updated` (configs/default/worker.ts). */
export abstract class IterateConfigEntrypoint<
  Env extends { ITX: ItxEntrypointService } = { ITX: ItxEntrypointService },
> extends WorkerEntrypoint<Env> {
  /** At fetch entry: `const denied = this.auth.require(request); if (denied) return denied;`
   *  `x-itx-principal` is on a request only when a project member (or the operator) sent it, safe
   *  to act on. A private route written by hand answers the platform's sign-in challenge, which
   *  the edge turns into the sign-in for a page load (`auth.require` does the same):
   *
   *  ```js
   *  if (!request.headers.get("x-itx-principal"))
   *    return new Response("Sign in\n", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="iterate"' } });
   *  ``` */
  protected readonly auth = auth;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    // The author's `fetch` runs under the cause its Request carries (../cause.ts).
    const serve = this.fetch;
    this.fetch = (request: Request) =>
      runCausedBy(causeOfRequest(request), () => serve.call(this, request));
  }

  /** The platform's delivery of one event (the dispatch boundary refuses any other caller),
   *  through `callWithCause`: `processEvent` under ONE scope, released when it settles. */
  async deliverEvent(event: StreamEvent): Promise<void> {
    using itx = this.getItx();
    await this.processEvent({ event, itx });
  }

  /** THE CALL UNDER A CAUSE (`walkUnderCause`) every method but `fetch` is called through. On no
   *  list: only the platform calls it (core/os context/built-ins.ts `workers`). */
  callWithCause(cause: unknown, steps: RpcSteps): Promise<unknown> {
    return walkUnderCause(this, cause, steps);
  }

  /** `using itx = this.getItx()`: the project root's scope, released with every call made through
   *  it when the block ends (`FacetDurableObject.getItx` says why nothing is kept past it). A field,
   *  not a method: Workers RPC reaches an entrypoint's methods, and a caller must never get the
   *  scope (sdk/index.test.ts). */
  protected readonly getItx = (): IterateContextApi & Disposable => itxScope(this.env.ITX);

  /** THE AUTHOR HOOK: every durable event of every context of the project from its first
   *  publication on (what was committed while no config was published may be passed over), one per
   *  call, unordered and at least once; a throw fails that event alone, which the platform retries.
   *  `itx` is the project's root, `itx.cd(event.path)` the event's own context. Make each reaction
   *  idempotent (an append keyed by `event.path` and `event.offset`) and keep no state here.
   *  Default: ignore it. */
  processEvent(_args: IterateConfigProcessEventArgs): void | Promise<void> {}

  /** THE WEB ROOT — every Request on a host of the project that no fetch route takes (the platform
   *  serves those first: `itx.fetchRoutes`). The host's routing slug is in `x-iterate-routing-slug`
   *  (`notes` for `notes--<project>.<hostname>`; absent on the apex), written only by the platform:
   *  route on it in plain code, answering here (reaching the project through `this.getItx()`) or
   *  forwarding the Request. Default: not found. */
  override fetch(_request: Request): Response | Promise<Response> {
    return new Response("Not found\n", { status: 404 });
  }
}
