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
//     paused, the ITX-EXPRESSION REWRITE RULES every call goes through (itx-expression-rewriting.ts
//     reads them) and the SUBSCRIPTION rows every commit is sent to (subscriptions.ts builds their
//     events). Runtime
//     state IS reduced state — observability is its snapshot (`itx.facets.get('core')`);
//   • SUBSCRIPTION DELIVERY — ONE loop (subscription-delivery.ts) run from onCommit: evaluate each
//     subscription's target and look at the value — a facet or a live stub owns its progress and
//     is pushed; anything else gets a cursor the stream keeps, at-least-once, retries on this DO's
//     own alarm;
//   • the FACETS — every loaded `DurableObject` class hosted here through `ctx.facets` with its
//     identity in `ctx.props` (a processor is a facet whose `processEventBatch` is subscribed);
//   • the RPC STUBS — two layers (rpc-stub-directory.ts): a BORROWED table anyone can lend into
//     under an opaque key, returned at the idle quiesce; and PAGERS — one hibernatable WebSocket per
//     key from the stateless edge relay, a standing offer to lend the key back on demand — so ANY
//     number of connected clients leave this DO free to hibernate. PRESENCE is `itx.rpcStubs.list()`
//     plus two EPHEMERAL events as it changes (`rpc-stub/attached` / `rpc-stub/detached`) — the log
//     never claims a socket is open;
//   • the FETCH DOOR — the one place a 101 can enter: `x-itx-rpc-stub-pager` accepts a pager
//     WebSocket AND appends the events that name its key in the same turn (the edge's `provide(stub)`
//     is ONE round trip here), `x-itx-expression` resolves the fetch lane, anything else is EGRESS
//     (secret placeholder substitution → the FALLBACK terminal).
//
// PURE WORKERS-RPC: capnweb never terminates here (hard rule) — the stateless `/api` worker
// relays. Dispatch is ONE door: `invoke(call)` — parse → rewrite through the rules → evaluate →
// replay, all against the inline core state; this class only delegates. Every OTHER change to this
// context is an appended event: the edge's `provide`/`subscribe`/`enableProcessor` verbs build one
// and call `append` (a lent stub's rule or row rides its pager upgrade and is appended as the pager
// is accepted — same door, one round trip) — there are no configuration verbs here. The ONE event
// this class appends on its own initiative is the un-set of whatever named an rpc stub whose last
// pager closed (onPresence); the ONE effect it runs off a committed event is deleting the facet a
// removed subscription hosted.

import { DurableObject } from "cloudflare:workers";
import { substituteHeaderSecrets } from "@v3/shared/egress";
import { facetLoaderOwner, loadConfinedWorker, type FacetSpec } from "./context/worker-loader.ts";
import {
  CoreContract,
  facetSpecFromHostingTarget,
  type CoreState,
  type Subscription,
} from "./stream/core-processor.ts";
import { codedError, errorCode } from "./lib/errors.ts";
import { withTimeout } from "./lib/timeout.ts";
import type { StreamEvent, StreamEventInput } from "./stream/events.ts";
import { parse, print, type ItxExpression, type ItxExpressionInput } from "./context/expression.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  itxExpressionEndingInFetch,
  RpcStubFetchServer,
} from "./fetch/rpc-stub-fetch.ts";
import { walkSteps } from "./context/dispatch.ts";
import { FacetHandle, RpcStubHandle } from "./context/invoke-handle.ts";
import {
  localReachableContext,
  Stream,
  type StreamPage,
  type WaitForEventFilter,
} from "./stream/stream.ts";
import {
  RpcStubDirectory,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
  type BorrowedRpcStub,
} from "./context/rpc-stub-directory.ts";
import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import { itxEntrypointFor } from "./itx-entrypoint.ts";
import {
  ItxExpressionResolver,
  rewriteRuleRemovedEvent,
} from "./context/itx-expression-rewriting.ts";
import { BUILT_IN_ROOTS } from "./context/built-in-roots.ts";
import { subscriptionConfiguredEvent } from "./stream/subscriptions.ts";
import {
  buildBuiltIns,
  type RewriteRuleListEntry,
  type SubscriptionListEntry,
} from "./context/built-ins.ts";
import { SubscriptionDelivery } from "./stream/subscription-delivery.ts";

function parseIterateContextDurableObjectName(name: string | undefined) {
  if (!name)
    throw new Error(
      "IterateContextDurableObject must be addressed by name (reach it via getByName).",
    );
  return DurableObjectNameCodec.parse(name);
}

/** How long a context stays quiet — no call, no delivery, no borrow — before the alarm aborts its
 *  idle facets and returns its borrowed rpc stubs so the actor can hibernate. */
const IDLE_QUIESCE_AFTER_MS = 60_000;
/** How long one facet call may take before the facet is aborted (a call that never answers would
 *  hold the quiesce, and with it this actor, forever). */
const FACET_CALL_WATCHDOG_MS = 60_000;

/** The core reduce's facet-shaped address (`itx.facets.get('core')`) — always on, never deletable,
 *  and reserved as a subscription name. */
const CORE_SLUG = CoreContract.slug;

/** The context worker's bindings (wrangler.jsonc): the DO namespace, the Worker Loader, the two kv
 *  namespaces, the deploy id, and the egress terminal. */
export interface Env {
  ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
  LOADER: WorkerLoader;
  ITX_KV: KVNamespace;
  /** Workers AI — the built-in root `itx.ai`, the binding verbatim (context/built-ins.ts). */
  AI: Ai;
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
  readonly #durableObjectAddress = parseIterateContextDurableObjectName(this.ctx.id.name);
  /** The `env.ITX` / `globalOutbound` stub every worker this context loads receives — a loopback onto
   *  this worker's own ItxEntrypoint with this context's name as its one prop. Minted once: it names
   *  the context, not an incarnation, and a warm loader never re-reads it anyway. */
  readonly #itxEntrypoint = itxEntrypointFor(this.ctx, this.#durableObjectAddress.name);
  /** The rpc-stub fetch subsystem (fetch/rpc-stub-fetch.ts) — the DO wires its three halves
   *  directly: the upgrade-leg door (fetch), frame forwarding (webSocketMessage), and peer close
   *  (webSocketClose); the rpc-stub directory borrows it for serve(). */
  readonly #rpcStubFetch = new RpcStubFetchServer(this.ctx);
  readonly #rpcStubs = new RpcStubDirectory({
    rpcStubFetch: this.#rpcStubFetch,
    ctx: this.ctx,
    // THE SET HALF of "the DO owns both ends of a lent stub's rule": the events a pager attach
    // carries (the edge's `provide(stub)` / `subscribe(fn)` hand over the rule / the row it built)
    // land through the same door as any append, in the turn the pager is accepted. The un-set half
    // is `#unsetWhatNamesRpcStub` below.
    appendEvents: (events) => void this.#appendAndRunCommittedEffects(events),
    // PRESENCE, as it changes: an EPHEMERAL fact a live watcher can subscribe to (`consumes:
    // ["events.iterate.com/rpc-stub/attached", …]`), never a durable row — presence is physical
    // (`itx.rpcStubs.list()`), and the log must never claim a socket is open. A refusal (a paused
    // stream) is nothing to report: the watcher re-seeds from list().
    onPresence: (kind, rpcStubKey) => {
      void this.append({
        type: `events.iterate.com/rpc-stub/${kind}`,
        ephemeral: true,
        payload: { rpcStubKey },
      }).catch(() => undefined);
      // THE STUB IS GONE, SO IS WHAT NAMED IT: when a key's LAST pager closes, every rewrite rule and
      // every subscription whose target is `itx.rpcStubs.get('<key>')` is un-set — the durable half
      // of "a provided stub's rule dies with the stub". Decided HERE and not in the lender's session
      // teardown because only this side knows the truth: a reconnect REPLACES the pager (never a
      // detach), so the reconnected session's rule survives a late-dying old session, while a
      // genuine last close un-sets it exactly once.
      if (kind === "detached") this.#unsetWhatNamesRpcStub(rpcStubKey);
    },
  });

  #unsetWhatNamesRpcStub(rpcStubKey: string): void {
    // Compared RESOLVED: a caller's short spelling (`itx.rpcStubs.get('k')`, or a rule of their own
    // naming the registry) names the key exactly as the platform's `itx.builtins.rpcStubs.get('k')`.
    // A rule is REMOVED (back to the platform row beneath, if any — a dead fake `itx.ai` restores the
    // real one), never masked: `null` is the caller's deliberate deny.
    const physical = print(["itx", "builtins", "rpcStubs", ["get", rpcStubKey]]);
    const namesTheKey = (target: ItxExpression | null): boolean => {
      if (target === null) return false;
      try {
        return print(this.#itxExpressionResolver.resolve(target).at(-1)!) === physical;
      } catch {
        return false;
      }
    };
    const { itxExpressionRewriteRules, subscriptions } = this.#stream.coreReducedState;
    for (const rule of Object.values(itxExpressionRewriteRules))
      if (namesTheKey(rule.target))
        void this.append(rewriteRuleRemovedEvent(rule.match)).catch(() => undefined);
    for (const [name, subscription] of Object.entries(subscriptions))
      if (namesTheKey(subscription.target))
        void this.append(subscriptionConfiguredEvent({ name, target: null })).catch(
          () => undefined,
        );
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Auto-answer the edge relay's 30s keepalive at the RUNTIME level — the message never reaches a
    // handler, so it keeps the pager sockets warm (defeats the ~100s idle-close) WITHOUT waking
    // this DO, leaving hibernation intact. Set ONCE here: it is DO-wide and persisted (it also
    // covers fetch-upgrade EYEBALL sockets, which is why the literal is deliberately distinctive —
    // a plain "ping" would silently hijack any client frame that equals it; ws-fetch-live-101
    // caught exactly that).
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        RPC_STUB_PAGER_KEEPALIVE_REQUEST,
        RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
      ),
    );
    // THE WAKE RECORD, synchronously, before any door opens (the apps/os shape): the first
    // incarnation appends `stream/created { projectId, path }`, every incarnation `stream/woken` —
    // so the core reduce knows who it is and which incarnation runs before the first append, read
    // or facet call, and the wake fan-out re-establishes deliveries after hibernation.
    this.#stream.appendCreatedAndWokenEvents();
  }

  /** THE STREAM — the commit point AND the core reduce (stream/stream.ts: `append` is the pipeline
   *  top to bottom — may-this-land, offsets, reduce + commit, after — and `coreReducedState` is the stream's own
   *  reduced state, reduced inside every commit). The name check already happened above (`#durableObjectAddress`).
   *  Its one callback, `onCommit`, is the post-commit fan-out: the ONE delivery loop. */
  readonly #stream = new Stream({
    storage: this.ctx.storage,
    path: this.#durableObjectAddress.path,
    projectId: this.#durableObjectAddress.projectId,
    onCommit: (freshEvents, afterOffset, throughOffset) =>
      this.#subscriptionDelivery.onCommit(freshEvents, afterOffset, throughOffset),
  });

  /** Commit events: idempotency-checked, offsets assigned from ONE shared sequence (ephemeral
   *  events consume offsets but never touch the log — their bodies exist only in this batch and
   *  in whatever pushes deliver them; after a reboot their offsets survive as valid gaps), then
   *  every subscription is served (the delivery loop). A thin wrapper: the whole pipeline lives in
   *  Stream.append; the tail runs #recordActivityForQuietClock on every LANDED append regardless of offset growth
   *  (a REFUSED one doesn't: arming the quiet-clock alarm is a storage write a rejected probe must
   *  not pay). */
  async append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    return this.#appendAndRunCommittedEffects(events);
  }

  /** The append door's body, SYNCHRONOUS end to end (Stream.append is): the commit, the activity
   *  note, the one committed-event effect. Two callers: `append` above, and the pager attach
   *  (rpc-stub-directory.ts), which needs the refusal in the same turn it accepted the socket. */
  #appendAndRunCommittedEffects(events: StreamEventInput[]): StreamEvent[] {
    const subscriptionsBeforeCommit = this.#stream.coreReducedState.subscriptions;
    const committedEvents = this.#stream.append(...events);
    this.#recordActivityForQuietClock();
    this.#deleteFacetsWhoseHostingSubscriptionWasRemoved(
      committedEvents,
      subscriptionsBeforeCommit,
    );
    return committedEvents;
  }

  /** THE ONE EFFECT of a subscription removal: a row whose target HOSTED a facet —
   *  `itx.facets.get(name, { source, className })…`, the shape `enableProcessor` writes — takes the
   *  facet with it, storage included, so `subscription-configured { name, target: null }` IS the
   *  disablement (raw event or verb alike) and a re-enable rebuilds from the log. A row that only
   *  ADDRESSED a running facet (`itx.facets.get(name)…`, no spec) deletes nothing: it never owned it.
   *  Done here, after the commit and before the append returns, because only the pre-commit state
   *  knows what the removed row targeted. */
  #deleteFacetsWhoseHostingSubscriptionWasRemoved(
    committedEvents: StreamEvent[],
    subscriptionsBeforeCommit: CoreState["subscriptions"],
  ): void {
    // The facet a row HOSTS: a row with `hostedFacet` set (M1 — the source is elided from the target,
    // so the marker, read off the RESOLVED target at configure time, is what says "hosts" and names
    // the facet). An address-only row has no `hostedFacet`.
    const hostedFacetName = (row: Subscription): string | undefined => row.hostedFacet?.name;
    for (const event of committedEvents) {
      if (event.type !== "events.iterate.com/stream/subscription-configured") continue;
      const { name, target } = event.payload as { name: string; target: string | null };
      const removedRow = target === null ? subscriptionsBeforeCommit[name] : undefined;
      const facetName = removedRow && hostedFacetName(removedRow);
      if (!facetName) continue;
      // Another row still hosts it (a mirror, an audit): the facet is theirs now, not gone.
      const stillHosted = Object.values(this.#stream.coreReducedState.subscriptions).some(
        (row) => hostedFacetName(row) === facetName,
      );
      if (!stillHosted) this.#deleteFacet(facetName);
    }
  }

  /** Wait for the next event matching `filter` (or the first committed durable match already in
   *  the log after an explicit `afterOffset`) — see Stream.waitForEvent for the whole contract.
   *  Deliberately not counted as activity: the caller's own open RPC keeps this DO awake for the
   *  wait's duration, and a wait quiesces nothing. */
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent> {
    return this.#stream.waitForEvent(filter);
  }

  /** One BUDGETED page of the log (Stream.read: at most `limit` rows and at most the server's byte
   *  budget of bodies; the page says whether it was cut). */
  read(afterOffset = 0, limit = 500): StreamPage {
    return this.#stream.read(afterOffset, limit);
  }

  /** THE EFFECTIVE rule table, read: the context's own rows (masks as `target: null`) plus the
   *  implicit platform row for every built-in root the context has not re-set. */
  #rewriteRuleList(): RewriteRuleListEntry[] {
    const contextRows = Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules).map(
      (rule): RewriteRuleListEntry => ({
        match: print(rule.match),
        target: rule.target && print(rule.target),
        origin: "context",
      }),
    );
    const reset = new Set(contextRows.map((row) => row.match));
    const platformRows = BUILT_IN_ROOTS.filter((root) => !reset.has(`itx.${root}`)).map(
      (root): RewriteRuleListEntry => ({
        match: `itx.${root}`,
        target: `itx.builtins.${root}`,
        origin: "platform",
      }),
    );
    return [...contextRows, ...platformRows];
  }

  /** `itx.builtins` — the physical scope this context resolves against (context/built-ins.ts). */
  readonly #builtIns: Record<string, unknown> = buildBuiltIns({
    projectId: this.#durableObjectAddress.projectId,
    path: this.#durableObjectAddress.path,
    iterateContextName: this.#durableObjectAddress.name,
    env: this.env,
    invoke: (call) => this.invoke(call),
    // a sibling context by path; the own path is this DO as a uniform-async ReachableContext (stream.ts)
    context: (p) =>
      p === this.#durableObjectAddress.path
        ? localReachableContext(this)
        : this.env.ITERATE_CONTEXT.getByName(
            DurableObjectNameCodec.stringify({
              projectId: this.#durableObjectAddress.projectId,
              path: p,
            }),
          ),
    egress: (request) => this.#egress(request),
    // THE LIVE-STUB REGISTRY, DO half: `get(key)` is the transport's pipelinable handle (a GENUINE
    // RpcTarget so `itx.rpcStubs.get('k').hello()` pipelines the mid-chain `.hello()` on every lane
    // — workerd's classifier rejects a Proxy, #6873), branded RpcStubHandle for the delivery loop.
    rpcStubs: {
      // Re-note AFTER the call: this invoke may have borrowed the stub, and a borrowed stub is
      // exactly what the quiet clock exists to return — the arm must not wait for the next call.
      get: (rpcStubKey) =>
        new RpcStubHandle(async (itxExpressionSteps) => {
          try {
            return await this.#rpcStubs.invokeRpcStub(rpcStubKey, itxExpressionSteps);
          } finally {
            this.#recordActivityForQuietClock();
          }
        }),
      list: () => this.#rpcStubs.listRpcStubKeys(),
    },
    // The facets view is PARENT-LOCAL — the facets live here and can never move (workerd#6702:
    // sockets never leave the parent). Branded FacetHandle for the delivery loop.
    facets: {
      get: (name, spec) =>
        new FacetHandle((itxExpressionSteps) => this.#invokeFacet(name, spec, itxExpressionSteps)),
    },
    subscriptions: {
      list: () => this.#subscriptionList(),
      get: (name) => this.#subscriptionList().find((s) => s.name === name) ?? null,
    },
    rewriteRules: {
      list: () => this.#rewriteRuleList(),
      get: (match) => this.#rewriteRuleList().find((row) => row.match === match) ?? null,
      // PURE: the chain of rewrites, printed — nothing dispatched, nothing noted as activity.
      resolve: (call) => this.#itxExpressionResolver.resolve(call).map(print),
    },
    waitForEvent: (filter) => this.#stream.waitForEvent(filter),
    itxEntrypoint: this.#itxEntrypoint,
  });

  /** THE DISPATCHER (context/itx-expression-rewriting.ts), built once over the physical built-ins —
   *  `itx.builtins`, the reserved root (declared ABOVE: a class field initializes in order); every
   *  entry closes over this context's identity, so cross-project access is unspellable. */
  readonly #itxExpressionResolver = new ItxExpressionResolver({
    rewriteRules: () => Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules),
    builtIns: this.#builtIns,
  });

  // ── SUBSCRIPTION DELIVERY: the one loop (subscription-delivery.ts), wired to this DO ──

  readonly #subscriptionDelivery = new SubscriptionDelivery({
    stream: this.#stream,
    // A target is evaluated through the ONE resolver — through every rewrite rule, one naming another
    // included — so what comes back is exactly what a caller would get: a FacetHandle, an RpcStubHandle,
    // an entrypoint handle, a value. The RESOLVER's run door, not this class's `invoke`: the loop's
    // own evaluation is not activity (a finished delivery is — the loop records it), so the alarm's
    // row-driven pass, which classifies every row's target once, can never postpone its own quiesce.
    evaluateItxExpression: (itxExpression) => this.#itxExpressionResolver.invoke(itxExpression),
    recordActivityForQuietClock: () => this.#recordActivityForQuietClock(),
  });

  /** The `itx.subscriptions` view: the reduced table joined with the delivery loop's cursors. */
  #subscriptionList(): SubscriptionListEntry[] {
    return Object.entries(this.#stream.coreReducedState.subscriptions).map(([name, s]) => {
      const cursor = this.#subscriptionDelivery.cursor(name);
      return {
        name,
        target: print(s.target),
        ...(s.consumes && { consumes: s.consumes }),
        configuredAtOffset: s.configuredAtOffset,
        ...(s.hostedFacet && { hostedFacet: s.hostedFacet }),
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
    // `finally` re-notes after `#liveFacetNames` grows) or borrow arms with an honest quiet-period start.
    if (this.#liveFacetNames.size === 0 && !this.#rpcStubs.hasBorrowedRpcStubs()) return;
    this.#stream.armAlarmNoLaterThan(this.#lastActivityMs + IDLE_QUIESCE_AFTER_MS);
  }

  /** EVERY facet materialized this incarnation, by name. The quiesce alarm aborts the whole set in
   *  one loop so no LIVE facet pins this actor awake. In memory on purpose: facets die with the
   *  incarnation, and a fresh call re-materializes from the durable startup memo (the facet's own
   *  storage having survived). */
  readonly #liveFacetNames = new Set<string>();
  // The in-flight count the quiesce alarm respects (aborting a facet mid-REDUCE is exactly the
  // stall a reduce would have to repair from the log — never cause it).
  #facetWorkInFlight = 0;

  async alarm(): Promise<void> {
    this.#stream.noteAlarmFired();
    // The stream-kept cursors' due retries — and anything an eviction left behind mid-delivery, the
    // pass re-deriving its obligations from the ROWS, never from what memory or kv happened to hold —
    // run here, AWAITED so a re-arm for a later retry lands before this actor hibernates. A cursor
    // delivery pins nothing local (a facet it calls into is counted by #facetWorkInFlight for the
    // call), so the quiesce below needs no count of its own. The cursor lane arms this alarm itself
    // while a delivery is owed (subscription-delivery.ts); the quiet clock below arms it for facets
    // and borrowed stubs.
    await this.#subscriptionDelivery.deliverEveryCursorSubscription();
    if (
      Date.now() - this.#lastActivityMs >= IDLE_QUIESCE_AFTER_MS &&
      this.#facetWorkInFlight === 0
    ) {
      for (const facetName of this.#liveFacetNames) {
        try {
          this.ctx.facets.abort(facetName, "idle quiesce");
        } catch {
          /* facet not running — already quiesced */
        }
      }
      this.#liveFacetNames.clear(); // aborted facets re-materialize on their next call
      // Same doctrine for the borrowed stubs: holding one pins this actor awake, and a page
      // always borrows it back — return them with the idle facets.
      this.#rpcStubs.returnBorrowedRpcStubs();
    } else {
      // Not quiet yet — look again when the quiet period would end; but never in the PAST (work in
      // flight for over a minute would otherwise re-fire this alarm in a tight, billed loop).
      this.#stream.armAlarmNoLaterThan(
        Math.max(this.#lastActivityMs + IDLE_QUIESCE_AFTER_MS, Date.now() + 10_000),
      );
    }
  }

  // ── FACETS: loaded DurableObject classes hosted here (a processor is one whose
  // processEventBatch is subscribed) ──

  /** THE facet door — `itx.facets.get(name).m()` (address a running facet) and
   *  `itx.facets.get(name, { source, className }).m()` (load and host) both land here. Facet stubs are non-transferable, so the walk happens where the stub lives. Top
   *  to bottom: the startup memo → the load → the racing-delete check → the class + version marker →
   *  the call under the watchdog → copy + dispose the answer. */
  async #invokeFacet(
    name: string,
    spec: FacetSpec | undefined,
    itxExpressionSteps: ItxExpression,
  ): Promise<unknown> {
    if (itxExpressionSteps.length === 0) throw new Error(`facet: name a method`);
    // The core reduce answers at its facet-shaped address with a synthesized view — it is not a
    // facet, pins nothing, needs no watchdog, and can never be hosted.
    if (name === CORE_SLUG) {
      if (spec) throw new Error(`"${name}" is the core reduce — never a facet name`);
      return (
        await walkSteps(
          {
            value: {
              snapshot: () => this.#stream.coreReducedStateSnapshot(),
              liveSnapshot: () => this.#stream.coreLiveStateSnapshot(),
              waitUntilProcessed: () => ({ ok: true }),
            },
            receiver: undefined,
          },
          itxExpressionSteps,
        )
      ).value;
    }
    // THE STARTUP MEMO `facet:<name>` = the FacetSpec in this DO's kv (the source is its modules,
    // literally, or the producer expression — stored as given): a hosting spec writes it (when it
    // changed) BEFORE the load, so `itx.facets.get(name)` alone re-materializes the facet after an
    // eviction; a bare name reads it — an unknown name is NO_FACET.
    let facetStartupMemo = this.ctx.storage.kv.get(`facet:${name}`) as FacetSpec | undefined;
    if (spec) {
      const storedSpec: FacetSpec = {
        source: spec.source,
        ...(spec.cacheKey !== undefined && { cacheKey: spec.cacheKey }),
        className: spec.className,
      };
      if (!facetStartupMemo || JSON.stringify(facetStartupMemo) !== JSON.stringify(storedSpec))
        this.ctx.storage.kv.put(`facet:${name}`, storedSpec);
      facetStartupMemo = storedSpec;
    }
    if (!facetStartupMemo) {
      // M1: a hosting row keeps NO source in core state — recover it from the DURABLE log event that
      // configured it (its `configuredAtOffset`), write the memo once, and proceed. The memo survives
      // eviction (kv), so this log read happens at most once per facet per deployment, never per push.
      // The row that HOSTS this facet (its marker names it — the subscription's own name may differ).
      const row = Object.values(this.#stream.coreReducedState.subscriptions).find(
        (candidate) => candidate.hostedFacet?.name === name,
      );
      if (row?.hostedFacet) {
        const [configuredEvent] = this.#stream.read(row.configuredAtOffset - 1, 1).events;
        const configuredTarget = (configuredEvent?.payload as { target?: string } | undefined)
          ?.target;
        // RESOLVED before reading the spec off it, as the reduce did when it marked the row.
        const spec = configuredTarget
          ? facetSpecFromHostingTarget(
              this.#itxExpressionResolver.resolve(parse(configuredTarget)).at(-1)!,
            )
          : undefined;
        if (spec) {
          const recovered: FacetSpec = {
            source: spec.source as FacetSpec["source"],
            ...(spec.cacheKey !== undefined && { cacheKey: spec.cacheKey }),
            className: spec.className,
          };
          this.ctx.storage.kv.put(`facet:${name}`, recovered);
          facetStartupMemo = recovered;
        }
      }
    }
    if (!facetStartupMemo)
      throw codedError("NO_FACET", `no facet "${name}" — load a class into it first`);
    // Counted so a CONCURRENT alarm's quiesce never aborts the facet mid-call.
    this.#facetWorkInFlight++;
    try {
      // THE LOAD — the loader caches by the key (cacheKey | content hash), so a warm facet's isolate
      // is reused and a producer expression runs only on a cold one.
      const { worker, loaderId } = await loadConfinedWorker({
        env: this.env,
        itxEntrypoint: this.#itxEntrypoint,
        kind: "facet",
        owner: facetLoaderOwner(this.#durableObjectAddress.name, facetStartupMemo.className),
        source: facetStartupMemo.source,
        cacheKey: facetStartupMemo.cacheKey,
        invoke: (call) => this.invoke(call),
        where: `facet "${name}"`,
      });
      // The load awaited: a removal (`disableProcessor`'s null row) may have deleted this facet meanwhile — its
      // facetStartupMemo is gone, and materializing now would resurrect the deleted facet as an orphan this
      // actor never quiesces. Refuse instead; the caller's row is gone too.
      if (!this.ctx.storage.kv.get(`facet:${name}`))
        throw codedError("NO_FACET", `no facet "${name}" — deleted while its source loaded`);
      // THE CLASS, minted with its identity (`ctx.props`), and THE LOADED IDENTITY (`facet:<name>:
      // loader-id`, the loader id the class came from): when it moves — a source change within a
      // deploy (new content hash, a new cacheKey), a deploy, a workaround generation after a dead load
      // (worker-loader.ts) — the facet restarts in place, its storage surviving. The abort matters for
      // the dead-load case too: workerd hands back the SAME facet container on every `facets.get`,
      // even one whose class never started, and only an abort clears it.
      const klass = worker.getDurableObjectClass(facetStartupMemo.className, {
        props: { iterateContextName: this.#durableObjectAddress.name, name },
      });
      if (!klass)
        throw new Error(`loaded worker does not export class "${facetStartupMemo.className}"`);
      const previousLoaderId = this.ctx.storage.kv.get(`facet:${name}:loader-id`) as
        | string
        | undefined;
      if (previousLoaderId !== undefined && previousLoaderId !== loaderId) {
        try {
          this.ctx.facets.abort(name, "loaded identity changed");
        } catch {
          /* facet not running */
        }
      }
      if (previousLoaderId !== loaderId)
        this.ctx.storage.kv.put(`facet:${name}:loader-id`, loaderId);
      const facet = this.ctx.facets.get(name, () => ({ class: klass }));
      this.#liveFacetNames.add(name); // live from here
      // THE CALL. A top-level `.fetch` rides the facet's own fetch — the one channel that carries a
      // 101 natively (fetch/rpc-stub-fetch.ts doctrine, points 1 & 4); a method walks
      // receiver-preservingly (walkSteps). THE WATCHDOG: a call that never answers would hold
      // `#facetWorkInFlight` — and with it the quiesce, and with THAT this actor — forever; past 60 s
      // the facet is aborted (its pending call rejects, the counter drains, the next call
      // re-materializes it from its facetStartupMemo).
      const [first] = itxExpressionSteps;
      const call =
        itxExpressionSteps.length === 1 && Array.isArray(first) && first[0] === "fetch"
          ? (facet as { fetch(r: Request): Promise<Response> }).fetch(first[1] as Request)
          : walkSteps({ value: facet, receiver: undefined }, itxExpressionSteps).then(
              (walked) => walked.value,
            );
      let result: unknown;
      try {
        // The label PRINTS the whole pushed batch (JSON5 + key-sort) — built lazily, so a facet
        // push pays it only if the watchdog actually fires, never on the green path.
        result = await withTimeout(
          call,
          FACET_CALL_WATCHDOG_MS,
          () => `facet "${name}" ${print(itxExpressionSteps)}`,
        );
      } catch (error) {
        if (errorCode(error) === "TIMEOUT") {
          try {
            this.ctx.facets.abort(name, "call timed out");
          } catch {
            /* not running */
          }
          this.#liveFacetNames.delete(name);
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

  /** Delete a facet, storage included — the removal effect of `subscription-configured { target: null }`
   *  (`disableProcessor` ends here; there is no delete verb). A
   *  re-load into the same name is a clean rebuild, never a resume from orphaned state. */
  #deleteFacet(name: string): void {
    if (name === CORE_SLUG)
      throw new Error(`"${name}" is the core reduce — always on, never a facet`);
    this.ctx.facets.delete(name);
    this.ctx.storage.kv.delete(`facet:${name}`);
    this.ctx.storage.kv.delete(`facet:${name}:loader-id`);
    this.#liveFacetNames.delete(name);
  }

  // ── dispatch (ONE path: the rewrite rules — the core reduce's own state, zero distance) ──

  /** Resolve + run one call through the current rewrite rules. The ONE dispatch door — `IterateContext`
   *  builds the call client-side and hands it here (the ARRAY half can carry call args a dotted STRING
   *  never could — callbacks, Dates, bytes: `["itx","tools",["transform",21,cb]]`). `args`, when
   *  given, are LIVE args applied to the value the expression denotes — the string is the pure part,
   *  the args the live part (`invoke("itx.kv.get", "k")` ≡ `itx.kv.get("k")`; the fetch lane's
   *  Request is the same door). */
  async invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown> {
    this.#recordActivityForQuietClock();
    return this.#itxExpressionResolver.invoke(call, args.length > 0 ? args : undefined);
  }

  // ── native fetch: the rpc-stub pager door, the fetch lane, egress ──

  async fetch(request: Request): Promise<Response> {
    // The doors, in order — each answers or declines:
    //   1. the rpc-stub pager and the rpc-stub fetch upgrade leg (the rpc-stub machinery);
    //   2. THE ITX-EXPRESSION FETCH LANE — `x-itx-expression` names an itx expression (JSON from a
    //      session's terminal `fetch(request)`, dotted text from the edge's `/expression?itx=`),
    //      resolved as a terminal-fetch call through the rules with the live Request as its one
    //      runtime arg; a
    //      101 flows back untouched; errors map to statuses by CODE. The routing header itself is
    //      stripped so it never reaches the capability or, below, egress;
    //   3. everything else is EGRESS (secret substitution → the FALLBACK terminal).
    const pager = this.#rpcStubs.acceptRpcStubPagerWebSocket(request);
    if (pager) return pager;
    const upgradeLeg = this.#rpcStubFetch.acceptFetchUpgradeLeg(request);
    if (upgradeLeg) return upgradeLeg;
    const itxExpressionHeader = request.headers.get(ITX_EXPRESSION_FETCH_HEADER);
    if (itxExpressionHeader !== null) {
      try {
        const itxExpression = itxExpressionHeader.trimStart().startsWith("[")
          ? (JSON.parse(itxExpressionHeader) as ItxExpression)
          : parse(itxExpressionHeader);
        const headers = new Headers(request.headers);
        headers.delete(ITX_EXPRESSION_FETCH_HEADER);
        const result = await this.#itxExpressionResolver.invoke(
          itxExpressionEndingInFetch(itxExpression),
          [new Request(request, { headers })],
        );
        return result instanceof Response
          ? result
          : new Response(`fetch lane: ${JSON.stringify(result)}\n`);
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        const status = errorCode(error) === "NO_ITX_EXPRESSION_MATCH" ? 404 : 500;
        return new Response(`fetch lane error: ${message}\n`, { status });
      }
    }
    return this.#egress(request);
  }

  // OBSERVABILITY has no dedicated verb: runtime state IS reduced state. Identity, incarnation,
  // pause, the rewrite rules and the subscription rows are ONE snapshot — `itx.facets.get('core').snapshot()`;
  // subscriptions joined with their cursors are `itx.subscriptions.list()`. A snapshot reads the
  // core reduce only, and arms no alarm (the quiet clock arms only while a facet is live or a stub is
  // borrowed).
  // PRESENCE — which stubs have a transport RIGHT NOW — is physical, never event-derivable:
  // `itx.rpcStubs.list()` on the itx surface, and the socket census below for the probes.

  /** IN-MEMORY TRANSPORT FACTS ({rpcStubPagers, borrowedRpcStubs, rpcStubPagesInFlight, dormant}) —
   *  a DO-only Workers-RPC verb for the hibernation/quiesce probes, deliberately OFF the itx surface:
   *  socket facts, not event-derivable state (`itx.rpcStubs.list()` is the presence half). */
  rpcStubTransportState(): ReturnType<RpcStubDirectory["rpcStubTransportState"]> {
    return this.#rpcStubs.rpcStubTransportState();
  }

  /** EGRESS: substitute `{{secret:project:NAME}}` placeholders, then the FALLBACK terminal. A
   *  PROJECT-scope placeholder that survives substitution means no such secret is stored — and this
   *  is the LAST door that owns the project scope, so it must FAIL here, loudly: forwarding would
   *  leak the secret's NAME to the external destination and send a garbage credential in its place.
   *  (`platform`-scope tokens pass through untouched — the next door down owns those.) */
  async #egress(request: Request): Promise<Response> {
    const substitutedRequest = await substituteHeaderSecrets(request, "project", (name) =>
      this.env.SECRETS_KV
        ? this.env.SECRETS_KV.get(`secret:${this.#durableObjectAddress.projectId}:${name}`)
        : null,
    );
    const unresolvedProjectToken = (value: string) =>
      /\{\{secret:project:[a-zA-Z0-9._-]+\}\}/.exec(value)?.[0];
    const inUrl = unresolvedProjectToken(substitutedRequest.url);
    if (inUrl)
      return new Response(`egress: no stored project secret for ${inUrl} in the request URL\n`, {
        status: 502,
      });
    for (const [header, value] of substitutedRequest.headers) {
      const token = unresolvedProjectToken(value);
      if (token)
        return new Response(
          `egress: no stored project secret for ${token} in header "${header}"\n`,
          { status: 502 },
        );
    }
    return this.env.FALLBACK.fetch(substitutedRequest);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Fetch-upgrade frames forwarded between their two DO-side sockets (eyeball ⇄ upgrade leg);
    // a plain pager socket's inbound payloads carry nothing we act on.
    this.#rpcStubFetch.handleWebSocketMessage(ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    if (this.#rpcStubFetch.handleWebSocketClose(ws, code, reason)) return;
    this.#rpcStubs.rpcStubPagerClosed(ws);
  }
  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws, 1006, "transport error");
  }

  // ── the rpc-stub Workers-RPC verbs — transport plumbing, OFF the itx surface (the directory owns
  // the lifecycle — see rpc-stub-directory.ts) ──

  /** LAYER 1: lend a stub under an opaque key — anyone with a route to this DO may (the edge's page
   *  answer lands here too). `stub` is a Workers-RPC stub — a callable Proxy on the wire; structural
   *  validation is impossible by design, so it rides permissively and the directory types it.
   *  (LAYER 2, the pager, has no verb: it is the `x-itx-rpc-stub-pager` upgrade at `fetch` — key and
   *  the events that name it in one request, rpc-stub-directory.ts.) */
  lendRpcStub(input: { rpcStubKey: string; stub: unknown }): void {
    this.#rpcStubs.lendRpcStub({
      rpcStubKey: input.rpcStubKey,
      stub: input.stub as BorrowedRpcStub,
    });
  }
}
