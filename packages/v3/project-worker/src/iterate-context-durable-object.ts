// iterate-context-durable-object.ts — `IterateContextDurableObject`: THE CONTEXT, one DO per
// `{projectId, path}` (codec-named `{projectId}.iterate{path}`). The DO is the parent —
// STREAM + THE CORE REDUCE + SUBSCRIPTION DELIVERY + FACETS + TRANSPORT + DOORS:
//
//   • the STREAM — a `Stream` (stream/stream.ts), DI'd with this DO's storage: the whole commit
//     pipeline (validation + the pause check + idempotency + offsets + chunking + waitForEvent +
//     the alarm armer), `appendCreatedAndWokenEvents()` — the constructor's created/woken records — and
//     `coreReducedState`, the stream's own reduced state. The DO's append/read/waitForEvent are thin wrappers; the stream's
//     one injected callback (onCommit) closes over this class — nothing in stream/stream.ts reaches back;
//   • the CORE REDUCE — ONE reduce-only processor (core-processor.ts) reduced INSIDE the commit
//     transaction, always on: who this context is, which incarnation runs, whether appends are
//     paused, the CAPABILITY MOUNTS every call routes through (capability-table.ts reads them) and
//     the SUBSCRIPTION rows every commit is sent to (subscriptions.ts builds their events). Runtime
//     state IS reduced state — observability is its snapshot (`itx.facets.get('core')`);
//   • SUBSCRIPTION DELIVERY — ONE loop (subscription-delivery.ts) run from onCommit: evaluate each
//     subscription's target and look at the value — a facet or a live stub owns its progress and
//     is pushed; anything else gets a cursor the stream keeps, at-least-once, retries on this DO's
//     own alarm;
//   • the FACETS — every loaded `DurableObject` class hosted here through `ctx.facets` with its
//     identity in `ctx.props` (a processor is a facet whose `processEventBatch` is subscribed);
//   • the TRANSPORT — every hibernatable socket: each rpc stub reaches this DO as a pager WebSocket
//     from the stateless relay (rpc-stub-directory.ts), so ANY number of connected clients leave
//     this DO free to hibernate. OUT is one-directional fire-and-forget delivery; IN borrows a
//     short stub leg from the edge per wake burst. A stub is addressed by the registry key it was
//     lent under (`itx.rpcStubs`); PRESENCE is `itx.rpcStubs.list()` plus two EPHEMERAL events
//     as it changes (`rpc-stub/attached` / `rpc-stub/detached`) — the log never claims a socket is
//     open;
//   • the FETCH DOOR — the one place a 101 can enter: `x-itx-stub-pager` accepts a stub pager
//     WebSocket, `x-itx-cap` resolves the fetch lane, anything else is EGRESS (secret
//     placeholder substitution → the FALLBACK terminal).
//
// PURE WORKERS-RPC: capnweb never terminates here (hard rule) — the stateless `/api` worker
// relays. Dispatch is ONE door: `invoke(call)` — parse → route the table → substitute → evaluate
// → replay, all against the inline capability table; this class only delegates.

import { DurableObject } from "cloudflare:workers";
import { substituteHeaderSecrets } from "@v3/shared/egress";
import {
  facetLoaderOwner,
  loadConfinedWorker,
  type WorkerSource,
} from "./context/worker-loader.ts";
import { CoreContract } from "./stream/core-processor.ts";
import { codedError, errorCode } from "./lib/errors.ts";
import { withTimeout } from "./lib/timeout.ts";
import type { StreamEvent, StreamEventInput } from "./stream/events.ts";
import {
  parse,
  canonicalItxExpressionPrefix,
  print,
  toItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
} from "./context/expression.ts";
import {
  CAPABILITY_FETCH_HEADER,
  expressionEndingInFetch,
  LiveCapabilityFetchServer,
} from "./fetch/fetch-capabilities.ts";
import { invokePath } from "./context/dispatch.ts";
import { FacetHandle, RpcStubHandle } from "./context/invoke-handle.ts";
import { localContext, Stream, type WaitForEventFilter } from "./stream/stream.ts";
import {
  RpcStubDirectory,
  STUB_PAGER_KEEPALIVE_REQUEST,
  STUB_PAGER_KEEPALIVE_RESPONSE,
  type BorrowedStub,
} from "./context/rpc-stub-directory.ts";
import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import { itxEntrypointFor } from "./itx-entrypoint.ts";
import {
  CapabilityResolver,
  capabilityProvidedEvent,
  capabilityRevokedEvent,
} from "./context/capability-table.ts";
import { buildBuiltIns, type SubscriptionListEntry } from "./context/built-ins.ts";
import { subscriptionConfiguredEvent, subscriptionRemovedEvent } from "./stream/subscriptions.ts";
import { SubscriptionDelivery } from "./stream/subscription-delivery.ts";

function parseIterateContextDurableObjectName(name: string | undefined) {
  if (!name)
    throw new Error(
      "IterateContextDurableObject must be addressed by name (reach it via getByName).",
    );
  return DurableObjectNameCodec.parse(name);
}

/** The core reduce's facet-shaped address (`itx.facets.get('core')`) — always on, never deletable,
 *  and reserved as a subscription name. */
const CORE_SLUG = CoreContract.slug;

/** The context worker's bindings (wrangler.jsonc): the DO namespace, the Worker Loader, the two kv
 *  namespaces, the deploy id, and the egress terminal. */
export interface Env {
  CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
  LOADER: WorkerLoader;
  ITX_KV: KVNamespace;
  SECRETS_KV?: KVNamespace;
  /** Deploy identity — reduced into loader cacheKeys so a redeploy mints fresh isolates. */
  CF_VERSION_METADATA?: { id: string };
  /** The egress terminal this context's `fetch` bottoms out at (secret-substituted, then sent). */
  FALLBACK: Fetcher;
}

export class IterateContextDurableObject extends DurableObject<Env> {
  /** WHO THIS DO IS — the first line, the apps/os shape: the DO name parsed ONCE into `{ name,
   *  projectId, path }` (`name` is the codec string itself). A context is only ever reached
   *  `getByName`; an id-addressed instance fails right here, before it can touch anything. */
  readonly #name = parseIterateContextDurableObjectName(this.ctx.id.name);
  /** The `env.ITX` / `globalOutbound` stub every worker this context loads receives — a loopback onto
   *  this worker's own ItxEntrypoint with this context's name as its one prop. Minted once: it names
   *  the context, not an incarnation, and a warm loader never re-reads it anyway. */
  readonly #itxHost = itxEntrypointFor(this.ctx, this.#name.name);
  /** The live-capability fetch subsystem (fetch/fetch-capabilities.ts) — the DO wires its three
   *  halves directly: the upgrade-leg door (fetch), frame forwarding (webSocketMessage), and
   *  peer close (webSocketClose); the rpc-stub directory borrows it for serve(). */
  readonly #liveCapabilityFetch = new LiveCapabilityFetchServer(this.ctx);
  readonly #rpcStubs = new RpcStubDirectory({
    liveCapabilityFetch: this.#liveCapabilityFetch,
    hooks: this.ctx,
    // PRESENCE, as it changes: an EPHEMERAL fact a live watcher can subscribe to (`consumes:
    // ["events.iterate.com/rpc-stub/attached", …]`), never a durable row — presence is physical
    // (`itx.rpcStubs.list()`), and the log must never claim a socket is open. A refusal (a paused
    // stream) is nothing to report: the watcher re-seeds from list().
    onPresence: (kind, key) =>
      void this.append({
        type: `events.iterate.com/rpc-stub/${kind}`,
        ephemeral: true,
        payload: { key },
      }).catch(() => undefined),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Auto-answer the edge relay's 30s keepalive at the RUNTIME level — the message never reaches a
    // handler, so it keeps the pager sockets warm (defeats the ~100s idle-close) WITHOUT waking
    // this DO, leaving hibernation intact. Set ONCE here: it is DO-wide and persisted (it also
    // covers fetch-upgrade EYEBALL sockets, which is why the literal is deliberately distinctive —
    // a plain "ping" would silently hijack any client frame that equals it; ws-fetch-live-101
    // caught exactly that).
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(STUB_PAGER_KEEPALIVE_REQUEST, STUB_PAGER_KEEPALIVE_RESPONSE),
    );
    // THE WAKE RECORD, synchronously, before any door opens (the apps/os shape): the first
    // incarnation appends `stream/created { projectId, path }`, every incarnation `stream/woken` —
    // so the core reduce knows who it is and which incarnation runs before the first append, read
    // or facet call, and the wake fan-out re-establishes deliveries after hibernation.
    this.#stream.appendCreatedAndWokenEvents();
  }

  /** THE STREAM — the commit point AND the core reduce (stream/stream.ts: `append` is the pipeline
   *  top to bottom — may-this-land, offsets, reduce + commit, after — and `coreReducedState` is the stream's own
   *  reduced state, reduced inside every commit). The name check already happened above (`#name`).
   *  Its one callback, `onCommit`, is the post-commit fan-out: the ONE delivery loop. */
  readonly #stream = new Stream({
    storage: this.ctx.storage,
    path: this.#name.path,
    projectId: this.#name.projectId,
    onCommit: (freshEvents, afterOffset, nextOffset) =>
      this.#delivery.onCommit(freshEvents, afterOffset, nextOffset),
  });

  /** Commit events: idempotency-checked, offsets assigned from ONE shared sequence (ephemeral
   *  events consume offsets but never touch the log — their bodies exist only in this batch and
   *  in whatever pushes deliver them; after a reboot their offsets survive as valid gaps), then
   *  every subscription is served (the delivery loop). A thin wrapper: the whole pipeline lives in
   *  Stream.append; the tail runs #recordActivityForQuietClock on every LANDED append regardless of offset growth
   *  (a REFUSED one doesn't: arming the quiet-clock alarm is a storage write a rejected probe must
   *  not pay). */
  async append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    const committedEvents = this.#stream.append(...events);
    this.#recordActivityForQuietClock();
    return committedEvents;
  }

  /** Wait for the next event matching `filter` (or the first committed durable match already in
   *  the log after an explicit `afterOffset`) — see Stream.waitForEvent for the whole contract.
   *  Deliberately not counted as activity: the caller's own open RPC keeps this DO awake for the
   *  wait's duration, and a wait quiesces nothing. */
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent> {
    return this.#stream.waitForEvent(filter);
  }

  read(afterOffset = 0, limit = 500): { events: StreamEvent[]; scannedThroughOffset: number } {
    return this.#stream.read(afterOffset, limit);
  }

  /** THE DISPATCHER (context/capability-table.ts), built once over the physical built-ins — every
   *  entry below closes over this context's identity, so cross-project access is unspellable. */
  readonly #capabilityResolver = new CapabilityResolver({
    mounts: () => this.#stream.coreReducedState.mounts,
    builtIns: buildBuiltIns({
      projectId: this.#name.projectId,
      path: this.#name.path,
      contextName: this.#name.name,
      env: this.env,
      invoke: (call) => this.invoke(call),
      // a sibling context by path; the own path is this DO as a uniform-async Context (stream.ts)
      context: (p) =>
        p === this.#name.path
          ? localContext(this)
          : this.env.CONTEXT.getByName(
              DurableObjectNameCodec.stringify({ projectId: this.#name.projectId, path: p }),
            ),
      egress: (request) => this.#egress(request),
      // THE LIVE-STUB REGISTRY, DO half: `get(key)` is the transport's pipelinable handle (a GENUINE
      // RpcTarget so `itx.rpcStubs.get('k').hello()` pipelines the mid-chain `.hello()` on every lane
      // — workerd's classifier rejects a Proxy, #6873), branded RpcStubHandle for the delivery loop.
      rpcStubs: {
        // Re-note AFTER the call: this invoke may have borrowed the stub, and a borrowed stub is
        // exactly what the quiet clock exists to return — the arm must not wait for the next call.
        get: (key) =>
          new RpcStubHandle(async (segments, args) => {
            try {
              return await this.#rpcStubs.invoke(key, segments, args);
            } finally {
              this.#recordActivityForQuietClock();
            }
          }),
        list: () => this.#rpcStubs.list(),
      },
      // The facets view is PARENT-LOCAL — the facets live here and can never move (workerd#6702:
      // sockets never leave the parent). Branded FacetHandle for the delivery loop.
      facets: {
        get: (ref) => new FacetHandle((path, args) => this.#invokeFacet(ref, path, args)),
        delete: (name) => this.#deleteFacet(name),
      },
      subscriptions: {
        list: () => this.#subscriptionList(),
        get: (name) => this.#subscriptionList().find((s) => s.name === name) ?? null,
      },
      host: this.#itxHost,
    }),
  });

  // ── SUBSCRIPTION DELIVERY: the one loop (subscription-delivery.ts), wired to this DO ──

  readonly #delivery = new SubscriptionDelivery({
    kv: this.ctx.storage.kv,
    stream: this.#stream,
    // A target is evaluated through the ONE dispatch door — through every mount, a mount whose target names another capability included — so what
    // comes back is exactly what a caller would get: a FacetHandle, an RpcStubHandle, an entrypoint
    // handle, a value.
    evaluate: (expression) => this.invoke(expression),
    recordActivityForQuietClock: () => this.#recordActivityForQuietClock(),
  });

  /** Configure (or replace) a subscription — the layer's one door (edge `subscribe` is sugar over
   *  it). Idempotent against the current table: an identical subscribe appends nothing. */
  async configureSubscription(input: {
    name: string;
    target: ItxExpressionInput;
    consumes?: string[];
  }): Promise<void> {
    const event = subscriptionConfiguredEvent(this.#stream.coreReducedState.subscriptions, input);
    if (event) await this.append(event);
  }

  /** Remove a subscription. Idempotent. A cursor target's cursor goes with it — the delivery loop
   *  drops it when the removed event commits (so a hand-appended removal is honoured the same way). */
  async removeSubscription(name: string): Promise<void> {
    const event = subscriptionRemovedEvent(this.#stream.coreReducedState.subscriptions, name);
    if (event) await this.append(event);
  }

  /** The `itx.subscriptions` view: the reduced table joined with the delivery loop's cursors. */
  #subscriptionList(): SubscriptionListEntry[] {
    return Object.entries(this.#stream.coreReducedState.subscriptions).map(([name, s]) => {
      const cursor = this.#delivery.cursor(name);
      return {
        name,
        target: print(s.target),
        ...(s.consumes && { consumes: s.consumes }),
        configuredAtOffset: s.configuredAtOffset,
        ...(cursor && {
          cursor: {
            confirmedOffset: cursor.confirmedOffset,
            attempt: cursor.attempt,
            ...(cursor.nextAttemptAtMs !== undefined && {
              nextAttemptAtMs: cursor.nextAttemptAtMs,
            }),
          },
        }),
        ...(s.halted && { halted: s.halted }),
      };
    });
  }

  // ── the #6800 quiesce: idle facets un-pinned so this actor can hibernate ──

  #lastActivityMs = 0;
  #recordActivityForQuietClock(): void {
    this.#lastActivityMs = Date.now();
    // NOTHING TO QUIESCE, NO ALARM: the quiet clock exists to abort idle facets and give borrowed
    // stubs back (alarm()). With neither, arming it is one storage write plus one billed wake for
    // nothing — a bare probe (`itx.facets.get('core').snapshot()` rides invoke → here) must not pay
    // that. `#lastActivityMs` still updates, so the first facet materialization (#invokeFacet's
    // `finally` re-notes after `#liveFacets` grows) or borrow arms with an honest quiet-period start.
    if (this.#liveFacets.size === 0 && !this.#rpcStubs.hasBorrowedStubs()) return;
    this.#stream.armNoLaterThan(this.#lastActivityMs + 60_000);
  }

  /** EVERY facet materialized this incarnation, by name, with the source it was loaded from. The
   *  quiesce alarm aborts the whole set in one loop so no LIVE facet pins this actor awake. In memory
   *  on purpose: facets die with the incarnation, and a fresh call re-materializes from the durable
   *  startup memo (the facet's own storage having survived). The resolved source rides along so a
   *  commit re-fetches and re-hashes nothing (processor-facet-source-refetch.e2e). */
  readonly #liveFacets = new Map<
    string,
    { source: string; contentHash: string; modules: Record<string, string> }
  >();
  // The in-flight count the quiesce alarm respects (aborting a facet mid-REDUCE is exactly the
  // stall a reduce would have to repair from the log — never cause it).
  #facetWorkInFlight = 0;

  async alarm(): Promise<void> {
    this.#stream.noteAlarmFired();
    // The stream-kept cursors' due retries (and anything an eviction left behind mid-delivery) run
    // here, AWAITED so a re-arm for a later retry lands before this actor hibernates. A cursor delivery
    // pins nothing local (a facet it calls into is counted by #facetWorkInFlight for the call), so the
    // quiesce below needs no count of its own.
    await this.#delivery.deliverEveryCursorSubscription();
    if (Date.now() - this.#lastActivityMs >= 60_000 && this.#facetWorkInFlight === 0) {
      for (const facetName of this.#liveFacets.keys()) {
        try {
          this.ctx.facets.abort(facetName, "idle quiesce");
        } catch {
          /* facet not running — already quiesced */
        }
      }
      this.#liveFacets.clear(); // aborted facets re-materialize; their next load re-fetches
      // Same doctrine for the borrowed stubs: holding one pins this actor awake, and a page
      // always borrows it back — return them with the idle facets.
      this.#rpcStubs.returnBorrowedStubs();
    } else {
      // Not quiet yet — look again when the quiet period would end; but never in the PAST (work in
      // flight for over a minute would otherwise re-fire this alarm in a tight, billed loop).
      this.#stream.armNoLaterThan(Math.max(this.#lastActivityMs + 60_000, Date.now() + 10_000));
    }
  }

  // ── FACETS: loaded DurableObject classes hosted here (a processor is one whose
  // processEventBatch is subscribed) ──

  /** THE facet door — `itx.facets.get(name).m()` and `itx.load(src).getDurableObjectClass(C).get(name).m()`
   *  both land here. Facet stubs are non-transferable, so the walk happens where the stub lives. Top
   *  to bottom: the startup memo → the load → the racing-delete check → the class + version marker →
   *  the call under the watchdog → copy + dispose the answer. */
  async #invokeFacet(
    ref: string | { source: WorkerSource; className: string; name?: string },
    path: string[],
    args: unknown[],
  ): Promise<unknown> {
    if (path.length === 0) throw new Error(`facet: name a method`);
    // The core reduce answers at its facet-shaped address with a synthesized view — it is not a
    // facet, pins nothing, and needs no watchdog.
    if (ref === CORE_SLUG)
      return invokePath(
        {
          snapshot: () => this.#stream.coreReducedStateSnapshot(),
          liveSnapshot: () => this.#stream.coreLiveStateSnapshot(),
          waitUntilProcessed: () => ({ ok: true }),
        },
        path,
        args,
        `facet "${CORE_SLUG}"`,
      );
    // THE STARTUP MEMO `facet:<name>` = { source, className } in this DO's kv: a load spec writes it
    // (when it changed) BEFORE the load, so `itx.facets.get(name)` alone re-materializes the facet
    // after an eviction; a bare name reads it — an unknown name is NO_FACET.
    const name = typeof ref === "string" ? ref : (ref.name ?? ref.className);
    if (name === CORE_SLUG) throw new Error(`"${name}" is the core reduce — never a facet name`);
    let memo = this.ctx.storage.kv.get(`facet:${name}`) as
      | { source: string; className: string }
      | undefined;
    if (typeof ref !== "string") {
      const spec = {
        source: print(toItxExpression(ref.source as ItxExpressionInput)),
        className: ref.className,
      };
      if (!memo || memo.source !== spec.source || memo.className !== spec.className)
        this.ctx.storage.kv.put(`facet:${name}`, spec);
      memo = spec;
    }
    if (!memo) throw codedError("NO_FACET", `no facet "${name}" — load a class into it first`);
    // Counted so a CONCURRENT alarm's quiesce never aborts the facet mid-call.
    this.#facetWorkInFlight++;
    try {
      // THE LOAD, its source resolved once per materialization: a live facet's modules + contentHash
      // ride #liveFacets, so a commit re-fetches nothing.
      const live = this.#liveFacets.get(name);
      const { worker, contentHash, modules } = await loadConfinedWorker({
        env: this.env,
        invoke: (call) => this.invoke(call),
        host: this.#itxHost,
        kind: "facet",
        owner: facetLoaderOwner(this.#name.name, memo.className),
        source: parse(memo.source) as WorkerSource,
        where: `facet "${name}"`,
        ...(live?.source === memo.source && {
          resolved: { contentHash: live.contentHash, modules: live.modules },
        }),
      });
      // The load awaited: a `facets.delete(name)` (disableProcessor) may have landed meanwhile — its
      // memo is gone, and materializing now would resurrect the deleted facet as an orphan this
      // actor never quiesces. Refuse instead; the caller's row is gone too.
      if (!this.ctx.storage.kv.get(`facet:${name}`))
        throw codedError("NO_FACET", `no facet "${name}" — deleted while its source loaded`);
      // THE CLASS, minted with its identity (`ctx.props`), and THE VERSION MARKER: a content change
      // within a deploy restarts the facet in place, its storage surviving (the deploy id is already
      // in the loader's cacheKey).
      const klass = worker.getDurableObjectClass(memo.className, {
        props: { contextName: this.#name.name, name },
      });
      if (!klass) throw new Error(`loaded worker does not export class "${memo.className}"`);
      const previousContentHash = this.ctx.storage.kv.get(`facet:${name}:version`) as
        | string
        | undefined;
      if (previousContentHash !== undefined && previousContentHash !== contentHash) {
        try {
          this.ctx.facets.abort(name, "source changed");
        } catch {
          /* facet not running */
        }
      }
      if (previousContentHash !== contentHash)
        this.ctx.storage.kv.put(`facet:${name}:version`, contentHash);
      const facet = this.ctx.facets.get(name, () => ({ class: klass }));
      this.#liveFacets.set(name, { source: memo.source, contentHash, modules }); // live from here
      // THE CALL. A top-level `.fetch` rides the facet's own fetch — the one channel that carries a
      // 101 natively (fetch/fetch-capabilities.ts doctrine, points 1 & 4); a method walks
      // receiver-preservingly (invokePath). THE WATCHDOG: a call that never answers would hold
      // `#facetWorkInFlight` — and with it the quiesce, and with THAT this actor — forever; past 60 s
      // the facet is aborted (its pending call rejects, the counter drains, the next call
      // re-materializes it from its memo).
      const call =
        path.length === 1 && path[0] === "fetch"
          ? (facet as { fetch(r: Request): Promise<Response> }).fetch(args[0] as Request)
          : invokePath(facet, path, args, `facet "${name}"`);
      let result: unknown;
      try {
        result = await withTimeout(call, 60_000, `facet "${name}".${path.join(".")}`);
      } catch (error) {
        if (errorCode(error) === "TIMEOUT") {
          try {
            this.ctx.facets.abort(name, "call timed out");
          } catch {
            /* not running */
          }
          this.#liveFacets.delete(name);
        }
        throw error;
      }
      // A facet's answer arrives as a Workers-RPC RESULT: when it is an object, it carries a
      // disposer that holds the call's resources — a reference on the FACET — until disposed or
      // GC'd. GC is too late for the quiesce: every `snapshot()` left such a result behind, so an
      // aborted facet stayed referenced and this actor could not be evicted (pinned, billed) until
      // the garbage collector happened by. So copy the DATA out and release the result at once. An
      // answer that is not data (a stub, a stream, a Response from some other method) cannot be
      // cloned — it is handed through as is and is the caller's to dispose.
      if (typeof result === "object" && result !== null && Symbol.dispose in result) {
        let copy: unknown;
        try {
          copy = structuredClone(result);
        } catch {
          return result;
        }
        (result as Disposable)[Symbol.dispose]();
        return copy;
      }
      return result;
    } finally {
      this.#facetWorkInFlight--;
      this.#recordActivityForQuietClock(); // a finished call earns a fresh quiet period
    }
  }

  /** Delete a facet, storage included (`itx.facets.delete(name)`; `disableProcessor` ends here). A
   *  re-load into the same name is a clean rebuild, never a resume from orphaned state. */
  #deleteFacet(name: string): void {
    if (name === CORE_SLUG)
      throw new Error(`"${name}" is the core reduce — always on, never a facet`);
    this.ctx.facets.delete(name);
    this.ctx.storage.kv.delete(`facet:${name}`);
    this.ctx.storage.kv.delete(`facet:${name}:version`);
    this.#liveFacets.delete(name);
  }

  // ── dispatch (ONE path: the routing table — the core reduce's mounts, zero distance) ──

  /** Resolve + run one call against the current table. The ONE dispatch door — `IterateContext` builds the
   *  call ItxExpression client-side and hands it here (the ARRAY half can carry call args a dotted
   *  STRING never could — callbacks, Dates, bytes: `["itx","tools",["transform",21,cb]]`). */
  async invoke(call: ItxExpressionInput): Promise<unknown> {
    this.#recordActivityForQuietClock();
    return this.#capabilityResolver.resolve(call);
  }

  /** Mount a capability: `path ⇒ target` (an expression rooted at itx). That is the whole event.
   *  PROVIDING WHAT IS ALREADY PROVIDED IS IDEMPOTENT: if the current winner at this exact path is
   *  this same target (compared as canonical strings), answer with ITS identity and append nothing
   *  — what keeps a reconnect's re-provide at ZERO events and the table bounded under churn, with
   *  the reduce left a pure shadow stack. A door policy, best-effort by design: two CONCURRENT
   *  identical provides may both land, which is a harmless shadow. */
  async provideCapability(input: {
    path: string;
    target: ItxExpressionInput;
  }): Promise<{ providedAtOffset: number }> {
    const pathString = canonicalItxExpressionPrefix(input.path); // the reduce stores the canonical path
    const targetString = print(toItxExpression(input.target));
    const winner = this.#newestMountAt(pathString);
    if (winner && print(winner.target) === targetString)
      return { providedAtOffset: winner.providedAtOffset };
    const [committedEvent] = await this.append(
      capabilityProvidedEvent({ path: pathString, target: input.target }),
    );
    return { providedAtOffset: committedEvent.offset };
  }

  /** Revoke by the mount's identity — or by its capability path (pops the newest winner at that
   *  exact path; what it shadowed is restored). A mount and a lent stub are SEPARATE things:
   *  revoking a live capability's mount leaves its stub in the registry (the edge that lent it
   *  recalls it on `itx.revoke(path)`), and a stub that dies leaves its mount in the table (calls
   *  answer CONNECTION_OFFLINE until someone revokes it or the provider re-lends under the same
   *  key — reconnect appends nothing). */
  async revokeCapability(input: { providedAtOffset?: number; path?: string }): Promise<void> {
    if (input.providedAtOffset !== undefined) {
      // By identity: append the revoked event even for an already-gone row (idempotent through
      // the reduce — a benign double-revoke must stay silent).
      await this.append(capabilityRevokedEvent(input.providedAtOffset));
      return;
    }
    if (!input.path) throw new Error("revokeCapability: pass providedAtOffset or path");
    const pathString = canonicalItxExpressionPrefix(input.path);
    const winner = this.#newestMountAt(pathString);
    if (!winner) throw new Error(`no mount at path ${JSON.stringify(pathString)}`);
    await this.append(capabilityRevokedEvent(winner.providedAtOffset));
  }

  /** The mount answering at a canonical path right now — the newest of its shadow stack. */
  #newestMountAt(pathString: string) {
    return this.#stream.coreReducedState.mounts
      .filter((m) => print(m.path) === pathString)
      .sort((a, b) => b.providedAtOffset - a.providedAtOffset)[0];
  }

  // ── native fetch: the stub pager door, the fetch lane, observability, egress ──

  async fetch(request: Request): Promise<Response> {
    // The doors, in order — each answers or declines:
    //   1. the stub pager and the live-capability upgrade leg (the rpc-stub machinery);
    //   2. THE CAPABILITY FETCH LANE — `x-itx-cap` names an itx expression (JSON from a session's
    //      terminal `fetch(request)`, dotted text from the edge's `/cap?cap=`), resolved as a
    //      terminal-fetch call against the table with the live Request as its one runtime arg; a
    //      101 flows back untouched; errors map to statuses by CODE. The routing header itself is
    //      stripped so it never reaches the capability or, below, egress;
    //   3. everything else is EGRESS (secret substitution → the FALLBACK terminal).
    const pager = await this.#rpcStubs.fetch(request);
    if (pager) return pager;
    const upgradeLeg = await this.#liveCapabilityFetch.acceptFetchUpgradeLeg(request);
    if (upgradeLeg) return upgradeLeg;
    const capHeader = request.headers.get(CAPABILITY_FETCH_HEADER);
    if (capHeader !== null) {
      try {
        const expr = capHeader.trimStart().startsWith("[")
          ? (JSON.parse(capHeader) as ItxExpression)
          : parse(capHeader);
        const headers = new Headers(request.headers);
        headers.delete(CAPABILITY_FETCH_HEADER);
        const result = await this.#capabilityResolver.resolve(expressionEndingInFetch(expr), [
          new Request(request, { headers }),
        ]);
        return result instanceof Response
          ? result
          : new Response(`fetch lane: ${JSON.stringify(result)}\n`);
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        const status = errorCode(error) === "NO_CAPABILITY_MATCH" ? 404 : 500;
        return new Response(`fetch lane error: ${message}\n`, { status });
      }
    }
    return this.#egress(request);
  }

  // OBSERVABILITY has no dedicated verb: runtime state IS reduced state. Identity, incarnation,
  // pause, the mounts and the subscription rows are ONE snapshot — `itx.facets.get('core').snapshot()`;
  // subscriptions joined with their cursors are `itx.subscriptions.list()`. A snapshot reads the
  // core reduce only, and arms no alarm (the quiet clock arms only while a facet is live or a stub is
  // borrowed).
  // PRESENCE — which stubs have a transport RIGHT NOW — is physical, never event-derivable:
  // `itx.rpcStubs.list()` on the itx surface, and the socket census below for the probes.

  /** IN-MEMORY TRANSPORT FACTS ({stubs, borrowed, pagesPending, dormant}) — a DO-only Workers-RPC
   *  verb for the hibernation/quiesce probes, deliberately OFF the itx surface: these are socket
   *  facts, not event-derivable state (`itx.rpcStubs.list()` is the edge half — the keys
   *  with a transport). */
  transportState(): ReturnType<RpcStubDirectory["state"]> {
    return this.#rpcStubs.state();
  }

  /** EGRESS: substitute `{{secret:project:NAME}}` placeholders, then the FALLBACK terminal. A
   *  PROJECT-scope placeholder that survives substitution means no such secret is stored — and this
   *  is the LAST door that owns the project scope, so it must FAIL here, loudly: forwarding would
   *  leak the secret's NAME to the external destination and send a garbage credential in its place.
   *  (`platform`-scope tokens pass through untouched — the next door down owns those.) */
  async #egress(request: Request): Promise<Response> {
    const sub = await substituteHeaderSecrets(request, "project", (name) =>
      this.env.SECRETS_KV
        ? this.env.SECRETS_KV.get(`secret:${this.#name.projectId}:${name}`)
        : null,
    );
    const unresolvedProjectToken = (value: string) =>
      /\{\{secret:project:[a-zA-Z0-9._-]+\}\}/.exec(value)?.[0];
    const inUrl = unresolvedProjectToken(sub.url);
    if (inUrl)
      return new Response(`egress: no stored project secret for ${inUrl} in the request URL\n`, {
        status: 502,
      });
    for (const [header, value] of sub.headers) {
      const token = unresolvedProjectToken(value);
      if (token)
        return new Response(
          `egress: no stored project secret for ${token} in header "${header}"\n`,
          { status: 502 },
        );
    }
    return this.env.FALLBACK.fetch(sub);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Fetch-upgrade frames forwarded between their two DO-side sockets (eyeball ⇄ upgrade leg);
    // a plain pager socket's inbound payloads carry nothing we act on.
    this.#liveCapabilityFetch.handleWebSocketMessage(ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    if (this.#liveCapabilityFetch.handleWebSocketClose(ws, code, reason)) return;
    this.#rpcStubs.closed(ws);
  }
  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws, 1006, "transport error");
  }

  // ── the rpc-stub RPC verbs (the directory owns the lifecycle — see rpc-stub-directory.ts;
  // these are the relay-facing doors) ──

  /** Reserve a transport for the stub lent under `key` in the `itx.rpcStubs` registry — the
   *  relay calls this (with the CANONICAL key, asserted here so the registry key and the mount that
   *  names it can never drift), then opens the pager carrying the returned transportId. */
  rpcStubAttach(input: { key: string }): { transportId: string } {
    const canonical = canonicalItxExpressionPrefix(input.key);
    if (canonical !== input.key)
      throw new Error(
        `rpcStubAttach: key ${JSON.stringify(input.key)} is not canonical (expected ${JSON.stringify(canonical)}) — canonicalize at the edge with canonicalItxExpressionPrefix`,
      );
    return this.#rpcStubs.attach(input);
  }

  /** The page answer: the paged relay LENDS a fresh stub, which this DO keeps borrowed until the
   *  idle quiesce returns it (a page borrows it back). */
  rpcStubLend(input: {
    transportId: string;
    /** A Workers-RPC stub — a callable Proxy on the wire; structural validation is impossible
     *  by design, so it rides permissively and the directory types it at the seam. */
    invoker: unknown;
  }) {
    return this.#rpcStubs.lend({
      transportId: input.transportId,
      invoker: input.invoker as BorrowedStub,
    });
  }
}
