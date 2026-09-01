// iterate-context-durable-object.ts — `IterateContextDurableObject`: THE CONTEXT, one DO per
// `{projectId, path}` (codec-named `{projectId}.iterate{path}`). The DO is the parent —
// STREAM + INLINE REDUCES + SUBSCRIPTION DELIVERY + FACETS + TRANSPORT + DOORS:
//
//   • the STREAM — a `Stream` (stream/stream.ts), DI'd with this DO's storage: the whole commit
//     pipeline (validation + admission + idempotency + offsets + chunking + the stream/woken
//     wake record + waitForEvent + the alarm armer). The DO's append/read/waitForEvent are thin
//     wrappers; the stream's three injected callbacks (admit / reduceAtCommit / onCommit) close
//     over this class — nothing in stream/stream.ts reaches back;
//   • the INLINE REDUCES — three reduce-only processors reduced INSIDE the commit transaction,
//     always on, one per layer: the CORE reduce (pause/breaker/incarnation), the CAPABILITY TABLE
//     (capability-table.ts — the routing table) and the SUBSCRIPTIONS table
//     (subscriptions.ts — who is sent each batch). Runtime state IS reduced state — observability
//     is their snapshots (`itx.facets.get('core' | 'capability-table' | 'subscriptions')`);
//   • SUBSCRIPTION DELIVERY — ONE loop (subscription-delivery.ts) run from onCommit: evaluate each
//     subscription's target and look at the value — a facet or a live stub owns its progress and
//     is pushed; anything else gets a cursor the stream keeps, at-least-once, retries on this DO's
//     own alarm;
//   • the FACETS — every loaded `DurableObject` class hosted here through `ctx.facets` with its
//     identity in `ctx.props` (a processor is a facet whose `processEventBatch` is subscribed;
//     no separate processor machinery, no runner, no configure);
//   • the TRANSPORT — every hibernatable socket: each held rpc stub is a delivery WebSocket from
//     the stateless relay (rpc-stub-directory.ts), so ANY number of connected clients leave this
//     DO free to hibernate. OUT is one-directional fire-and-forget delivery; IN borrows a short
//     RetainedCallbackInvoker leg per wake burst. A stub is addressed by the registry key it was
//     parked under (`itx.rpcStubs`); PRESENCE is `itx.rpcStubs.list()` plus two EPHEMERAL events
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
  versionedFacet,
  type WorkerSource,
} from "./context/worker-loader.ts";
import { admit, CoreStreamProcessor, type CoreState } from "./stream/core-processor.ts";
import { codedError, reportIssue } from "./lib/errors.ts";
import type { StreamEvent, StreamEventInput } from "./stream/events.ts";
import {
  parse,
  parseCapabilityPath,
  print,
  toExpression,
  type ItxExpression,
} from "./context/expression.ts";
import {
  LiveCapabilityFetchServer,
  serveCapabilityFetchLane,
  type PartialFetch,
} from "./fetch/fetch-capabilities.ts";
import { InlineCore } from "./stream/inline-core.ts";
import { invokePath } from "./context/dispatch.ts";
import { FacetHandle, RpcStubHandle } from "./context/invoke-handle.ts";
import { localContext, Stream, type WaitForEventFilter } from "./stream/stream.ts";
import { RpcStubDirectory } from "./context/rpc-stub-directory.ts";
import {
  STUB_PAGER_KEEPALIVE_REQUEST,
  STUB_PAGER_KEEPALIVE_RESPONSE,
  type RetainedCallbackInvoker,
} from "./context/hibernatable-rpc-stub.ts";
import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import { itxEntrypointFor } from "./itx-entrypoint.ts";
import { CapabilityTableProcessor, type CapabilityTable } from "./context/capability-table.ts";
import type { ReduceOnlyProcessor } from "./stream/processor.ts";
import {
  buildBuiltIns,
  type BuiltInsEnv,
  type SubscriptionListEntry,
} from "./context/built-ins.ts";
import { SubscriptionsProcessor, type SubscriptionsState } from "./stream/subscriptions.ts";
import { SubscriptionDelivery } from "./stream/subscription-delivery.ts";

function parseIterateContextDurableObjectName(name: string | undefined) {
  if (!name)
    throw new Error(
      "IterateContextDurableObject must be addressed by name (reach it via getByName).",
    );
  return DurableObjectNameCodec.parse(name);
}

/** The three INLINE reduce-only processors: reduced at the commit point, never real facets — always
 *  on, un-deletable, addressed by name like any facet. */
const CORE_SLUG = "core";
const CAPABILITY_TABLE_SLUG = "capability-table";
const SUBSCRIPTIONS_SLUG = "subscriptions";
const isInlineSlug = (slug: string): boolean =>
  slug === CORE_SLUG || slug === CAPABILITY_TABLE_SLUG || slug === SUBSCRIPTIONS_SLUG;
/** The core processor is stateless (pure reduce) — one module-level instance serves every DO. */
const CORE_PROCESSOR = new CoreStreamProcessor();

/** The startup memo of a hosted facet — `facet:<name>` in this DO's kv: which loaded class it is.
 *  A CACHE, not truth (the truth is the expression that first named it —
 *  `itx.load(src).getDurableObjectClass(C).get(name)`): `ctx.facets.get` wants a startup callback on
 *  every incarnation, and `itx.facets.get(name)` must re-materialize after an eviction without the
 *  expression in hand. */
type FacetMemo = { source: string; className: string };

// The parent hosts the INLINE CORE (built-in scope + routing table + subscriptions + core reduce),
// so it needs the full roots env.
export class IterateContextDurableObject extends DurableObject<BuiltInsEnv> {
  /** WHO THIS DO IS — parsed ONCE from the unforgeable codec name; carries projectId, path
   *  AND its canonical string form (`.name`). A stream is only ever reached `getByName`; an
   *  id-addressed instance fails right here in the constructor, before it can touch anything. */
  readonly #address = parseIterateContextDurableObjectName(this.ctx.id.name);
  /** The live-capability fetch subsystem (fetch/fetch-capabilities.ts) — the DO wires its three
   *  halves directly: the upgrade-leg door (fetch), frame forwarding (webSocketMessage), and
   *  peer close (webSocketClose); the rpc-stub directory borrows it for serve(). */
  readonly #liveCapabilityFetch = new LiveCapabilityFetchServer({
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
  });
  readonly #rpcStubs = new RpcStubDirectory({
    liveCapabilityFetch: this.#liveCapabilityFetch,
    hooks: {
      acceptWebSocket: (ws, tags) => {
        this.ctx.acceptWebSocket(ws, tags);
        // Auto-answer the edge relay's 30s keepalive at the RUNTIME level — the message never
        // reaches a handler, so it keeps the pager socket warm (defeats the ~100s idle-close)
        // WITHOUT waking the DO, leaving hibernation intact. Reconnect still backs a hard drop.
        // The literal is DELIBERATELY distinctive: setWebSocketAutoResponse is DO-WIDE (it also
        // covers fetch-upgrade EYEBALL sockets), so a plain "ping" would silently hijack any client
        // frame that happens to equal it — the ws-fetch-live-101 test caught exactly that.
        this.ctx.setWebSocketAutoResponse(
          new WebSocketRequestResponsePair(
            STUB_PAGER_KEEPALIVE_REQUEST,
            STUB_PAGER_KEEPALIVE_RESPONSE,
          ),
        );
      },
      getWebSockets: (tag) => this.ctx.getWebSockets(tag),
    },
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

  /** THE STREAM — the commit point (see stream/stream.ts: validation + admission + idempotency +
   *  offsets + the wake record + waitForEvent + the alarm armer, one DI'd class). The name check
   *  already happened in the constructor (`#address`); the stream itself is storage-lazy. Its
   *  three deps close over this DO: `admit` reads the core reduce (all pause/breaker
   *  reasoning lives in core-processor.ts), `reduceAtCommit` runs the INLINE REDUCES inside the
   *  commit transaction (the routing table, the subscriptions and the core state are atomically
   *  exact as of the last committed event, always), and `onCommit` is the post-commit fan-out:
   *  the ONE delivery loop, then the inline reduces' own live-state deltas. */
  readonly #stream = new Stream({
    storage: this.ctx.storage,
    path: this.#address.path,
    admit: (inputs) =>
      admit(this.#coreState(), inputs, Date.now(), (k) => this.#stream.hasIdempotencyKey(k)),
    reduceAtCommit: (justCommitted, after, next) =>
      this.#inlineCore.reduceAtCommit(justCommitted, after, next),
    onCommit: (fresh, scannedAfterOffset, nextOffset) => {
      this.#delivery.onCommit(fresh, scannedAfterOffset, nextOffset);
      // INLINE LIVE STATE, post-commit (the InlineCore seam — the stream stays ignorant of which
      // reduces are inline): each commit-changed entry `set`s its state, appending the standard
      // ephemeral live-state/changed delta back through this DO's own append door (a nested
      // commit — terminating, because the delta changes no inline state).
      this.#inlineCore.publishLiveStateChanges();
    },
  });

  /** Commit events: idempotency-checked, offsets assigned from ONE shared sequence (ephemeral
   *  events consume offsets but never touch the log — their bodies exist only in this batch and
   *  in whatever pushes deliver them; after a reboot their offsets survive as valid gaps), then
   *  every subscription is served (the delivery loop). A thin wrapper: the whole pipeline lives in
   *  Stream.append; the tail runs #noteActivity on every LANDED append regardless of offset growth
   *  (a REFUSED one doesn't: arming the quiet-clock alarm is a storage write a rejected probe must
   *  not pay). */
  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    const committed = this.#stream.append(...inputs);
    this.#noteActivity();
    return committed;
  }

  /** Wait for the next event matching `filter` (or the first committed durable match already in
   *  the log after an explicit `afterOffset`) — see Stream.waitForEvent for the whole contract.
   *  Deliberately NOT #noteActivity'd: like read(), a wait is a non-minting probe (the caller's
   *  own open RPC keeps this DO awake for the wait's duration; a timed-out wait on a virgin
   *  stream must leave it virgin — no alarm write either). */
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent> {
    return this.#stream.waitForEvent(filter);
  }

  read(afterOffset = 0, limit = 500): { events: StreamEvent[]; scannedThroughOffset: number } {
    return this.#stream.read(afterOffset, limit);
  }

  // ── THE INLINE CORE: reduce-only processors reduced at the stream's commit point. The engine —
  // rehydrate / catch up / reduce-at-commit / checkpoint / publish-live-state — lives in
  // stream/inline-core.ts; this DO owns only the DEFS (which processors are inline), because
  // BUILDING them is its wiring below. ──
  readonly #inlineCore = new InlineCore({
    kv: this.ctx.storage.kv,
    read: (after, limit) => this.read(after, limit),
    head: () => this.#stream.highestAssignedOffset(),
    defs: () => this.#inlineDefs(),
    // The live-state deltas ride this DO's OWN append door, so they are admitted, committed, and
    // fanned out like any other ephemeral event (and a paused stream refuses them — the
    // lossy-by-contract gap LiveState.set contains).
    sink: { append: (event) => this.append(event) },
  });
  #capabilityTableInstance?: CapabilityTableProcessor;
  #subscriptionsInstance?: SubscriptionsProcessor;

  /** The three inline-core reduced states, typed in ONE place. */
  #table(): CapabilityTable {
    return this.#inlineCore.entry(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
  }
  #coreState(): CoreState {
    return this.#inlineCore.entry(CORE_SLUG).state as CoreState;
  }
  #subscriptions(): SubscriptionsState {
    return this.#inlineCore.entry(SUBSCRIPTIONS_SLUG).state as SubscriptionsState;
  }

  /** THE capability host, parent-constructed: same class, same contract, zero distance. */
  #capabilityTableProcessor(): CapabilityTableProcessor {
    if (this.#capabilityTableInstance) return this.#capabilityTableInstance;
    const { projectId, path } = this.#address;
    const ownContext = localContext(this); // the own DO as a uniform-async Context (stream/stream.ts)
    const builtIns = buildBuiltIns({
      projectId,
      path,
      contextName: this.#address.name,
      env: this.env,
      invoke: (call) => this.invoke(call),
      context: (p) =>
        p === path
          ? ownContext
          : this.env.CONTEXT.getByName(DurableObjectNameCodec.stringify({ projectId, path: p })),
      egress: (request) => this.#egress(request),
      // THE LIVE-STUB REGISTRY, DO half: `get(key)` is the transport's pipelinable handle (a GENUINE
      // RpcTarget so `itx.rpcStubs.get('k').hello()` pipelines the mid-chain `.hello()` on every lane
      // — workerd's classifier rejects a Proxy, #6873), branded RpcStubHandle for the delivery loop.
      rpcStubs: {
        get: (key) =>
          new RpcStubHandle((segments, args) => this.#rpcStubs.invoke(key, segments, args)),
        list: () => this.#rpcStubs.list(),
      },
      // The facets view is PARENT-LOCAL — the facets live here and can never move (workerd#6702:
      // sockets never leave the parent). Branded FacetHandle for the delivery loop.
      facets: {
        get: (ref) => new FacetHandle((path, args) => this.facetInvoke(ref, path, args)),
        delete: (name) => this.deleteFacet(name),
      },
      subscriptions: {
        list: () => this.#subscriptionList(),
        get: (name) => this.#subscriptionList().find((s) => s.name === name) ?? null,
      },
      exportsCtx: this.ctx,
    });
    const proc = new CapabilityTableProcessor({
      stream: {
        append: (...events) => this.append(...events),
        read: (after, limit) => Promise.resolve(this.read(after, limit)),
      },
      builtIns,
      // Resolve one call against the CURRENT table (the `itx` recursion symbol re-enters here).
      resolveCurrent: (call, depth) => this.invoke(call, depth),
    });
    this.#capabilityTableInstance = proc;
    return proc;
  }

  #subscriptionsProcessor(): SubscriptionsProcessor {
    return (this.#subscriptionsInstance ??= new SubscriptionsProcessor(
      {
        append: (...events) => this.append(...events),
        read: (after, limit) => Promise.resolve(this.read(after, limit)),
      },
      [CORE_SLUG, CAPABILITY_TABLE_SLUG, SUBSCRIPTIONS_SLUG],
    ));
  }

  #inlineDefs(): { slug: string; proc: ReduceOnlyProcessor<unknown> }[] {
    return [
      { slug: CORE_SLUG, proc: CORE_PROCESSOR as ReduceOnlyProcessor<unknown> },
      {
        slug: CAPABILITY_TABLE_SLUG,
        proc: this.#capabilityTableProcessor() as ReduceOnlyProcessor<unknown>,
      },
      {
        slug: SUBSCRIPTIONS_SLUG,
        proc: this.#subscriptionsProcessor() as ReduceOnlyProcessor<unknown>,
      },
    ];
  }

  // ── SUBSCRIPTION DELIVERY: the one loop (subscription-delivery.ts), wired to this DO ──

  readonly #delivery = new SubscriptionDelivery({
    kv: this.ctx.storage.kv,
    subscriptions: () => this.#subscriptions(),
    read: (after, limit) => this.read(after, limit),
    head: () => this.#stream.highestAssignedOffset(),
    append: (event) => this.append(event),
    // A target is evaluated through the ONE dispatch door — mounts and aliases included — so what
    // comes back is exactly what a caller would get: a FacetHandle, an RpcStubHandle, an entrypoint
    // handle, a value.
    evaluate: (expression) => this.invoke(expression),
    armNoLaterThan: (atMs) => this.#stream.armNoLaterThan(atMs),
    onActivity: () => this.#noteActivity(),
    now: () => Date.now(),
  });

  /** Configure (or replace) a subscription — the layer's one door (edge `subscribe` is sugar over
   *  it). Idempotent against the current table: an identical subscribe appends nothing. */
  async configureSubscription(input: {
    name: string;
    target: ItxExpression;
    consumes?: string[];
  }): Promise<{ name: string; configuredAtOffset: number }> {
    this.#stream.touch();
    return this.#subscriptionsProcessor().configure(this.#subscriptions(), input);
  }

  /** Remove a subscription; a cursor target's cursor goes with it. Idempotent. */
  async removeSubscription(name: string): Promise<void> {
    await this.#subscriptionsProcessor().remove(this.#subscriptions(), name);
    this.#delivery.forget(name);
  }

  /** The `itx.subscriptions` view: the reduced table joined with the delivery loop's cursors. */
  #subscriptionList(): SubscriptionListEntry[] {
    return Object.entries(this.#subscriptions().subscriptions).map(([name, s]) => {
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
  #noteActivity(): void {
    this.#lastActivityMs = Date.now();
    // VIRGIN-PROBE GUARD (the storage-lazy doctrine, stream/stream.ts header): skip the quiet-clock
    // arm when there is NOTHING the quiet clock exists for — no live facet to quiesce and a stream
    // that never wrote (`currentIncarnation()` is a non-minting kv read). Without this, a bare
    // probe (`itx.facets.get('core').snapshot()` rides invoke → here) wrote a durable alarm on a
    // NEVER-TOUCHED context: one storage write + one billed wake, and workerd defers auto-deleting
    // the empty object until the pointless alarm fires. `#lastActivityMs` still updates, so the
    // first real write (or facet materialization — facetInvoke's `finally` re-notes after
    // `#liveFacets` grows) arms with an honest quiet-period start.
    if (this.#liveFacets.size === 0 && this.#stream.currentIncarnation() === 0) return;
    this.#stream.armNoLaterThan(this.#lastActivityMs + 60_000);
  }

  /** EVERY facet materialized this incarnation, by name. The quiesce alarm aborts the whole set in
   *  one loop so no LIVE facet pins this actor awake. In memory on purpose: facets die with the
   *  incarnation, and a fresh call re-materializes from the durable startup memo (the facet's own
   *  storage having survived). */
  readonly #liveFacets = new Set<string>();
  // The in-flight count the quiesce alarm respects (aborting a facet mid-REDUCE is exactly the
  // stall a reduce would have to repair from the log — never cause it).
  #facetWorkInFlight = 0;

  async alarm(): Promise<void> {
    this.#stream.markFired();
    // The cursor lane's due retries (and anything an eviction left behind mid-delivery) pump here,
    // AWAITED so the quiesce below never aborts a facet mid-delivery and a re-arm for a later retry
    // lands before this actor hibernates.
    await this.#delivery.pumpAll().catch((e) => reportIssue("stream-do.delivery-pump", e));
    if (
      Date.now() - this.#lastActivityMs >= 60_000 &&
      this.#facetWorkInFlight === 0 &&
      this.#delivery.inFlight === 0
    ) {
      for (const facetName of this.#liveFacets) {
        try {
          this.ctx.facets.abort(facetName, "idle quiesce");
        } catch {
          /* facet not running — already quiesced */
        }
      }
      this.#liveFacets.clear();
      this.#resolvedFacetSource.clear(); // aborted facets re-materialize; their next load re-fetches
      // Same doctrine for the paged-in RetainedCallbackInvoker stubs: retaining one pins this
      // actor awake, and a page always gets it back — dispose them with the idle facets.
      this.#rpcStubs.disposeRetainedStubs();
    } else {
      this.#stream.armNoLaterThan(this.#lastActivityMs + 60_000);
    }
  }

  // ── FACETS: loaded DurableObject classes hosted here (a processor is one whose
  // processEventBatch is subscribed) ──

  /** THE generic facet door: resolve the facet LOCALLY (facet stubs are non-transferable — the
   *  walk happens where the stub lives), walk the dotted path with the exposure guard, apply
   *  the terminal. `itx.facets.get(name)` and `load(...).getDurableObjectClass(C).get(name)` both
   *  ride this to reach ANY method the facet's durable object exposes. */
  async facetInvoke(
    ref: string | { source?: unknown; className?: string; name?: string },
    path: string[],
    args: unknown[],
  ): Promise<unknown> {
    this.#noteActivity();
    if (path.length === 0) throw new Error(`facet: name a method`);
    // Counted like a delivery: a CONCURRENT alarm's quiesce must never abort the facet mid-call
    // (#noteActivity above only guards the first 60s; a long invoke outlives it).
    this.#facetWorkInFlight++;
    try {
      const facet = await this.#resolveFacet(ref);
      // A top-level `.fetch` forwards to the facet's own fetch — the one channel that carries a
      // 101 natively (fetch/fetch-capabilities.ts doctrine, points 1 & 4) — never through
      // invokePath's await-walk. A method walks receiver-preservingly (invokePath).
      if (path.length === 1 && path[0] === "fetch")
        return await (facet as { fetch(r: Request): Promise<Response> }).fetch(args[0] as Request);
      const what =
        typeof ref === "string" ? `facet "${ref}"` : `facet "${ref.name ?? ref.className}"`;
      return await invokePath(facet, path, args, what);
    } finally {
      this.#facetWorkInFlight--;
      this.#noteActivity(); // a finished invoke earns a fresh quiet period
    }
  }

  /** THE one facet resolver: turn ANY ref into a live facet handle. A NAME (string) resolves an
   *  inline core (always at head, a synthesized snapshot view) or a hosted facet (its startup memo
   *  names the class). A LOAD SPEC (`{ source, className, name? }` — `itx.load(...)`) materializes
   *  the class as the facet `name ?? className`, remembering the spec as its startup memo so a
   *  later `itx.facets.get(name)` re-materializes it after an eviction. Throws NO_FACET for an
   *  unknown name. */
  async #resolveFacet(
    ref: string | { source?: unknown; className?: string; name?: string },
  ): Promise<unknown> {
    if (typeof ref !== "string") {
      if (ref.source !== undefined && ref.className) {
        const memo: FacetMemo = {
          source: print(toExpression(ref.source as ItxExpression)),
          className: ref.className,
        };
        return this.#facet(ref.name ?? ref.className, memo);
      }
      if (ref.name) return this.#resolveFacet(ref.name); // { name } ⇒ address by name (below)
      throw new Error(
        `load: pass { source, className } to run a facet, or { name } to address one`,
      );
    }
    if (isInlineSlug(ref)) {
      const entry = this.#inlineCore.entry(ref);
      return {
        snapshot: () => ({ offset: entry.throughOffset, state: entry.state }),
        waitUntilProcessed: () => ({ ok: true }),
      };
    }
    const memo = this.ctx.storage.kv.get(`facet:${ref}`) as FacetMemo | undefined;
    if (memo) return this.#facet(ref, memo);
    throw codedError("NO_FACET", `no facet "${ref}" — load a class into it first`);
  }

  /** Per-facet resolved-source memo (in memory, keyed by facet name): the printed source
   *  expression it was resolved from, plus the fetched modules + their contentHash. Every commit
   *  reaches a processor's facet through the same load chain — without this the source would be
   *  re-fetched and re-hashed on EVERY commit (prove_source_refetch). Kept ONLY while the facet is
   *  live: dropped on delete and cleared at idle-quiesce, so a source edit is picked up at the
   *  next materialization. */
  readonly #resolvedFacetSource = new Map<
    string,
    { srcPrint: string; version: string; modules: Record<string, string> }
  >();

  /** Materialize (or reuse) the facet `name` hosting `memo.className` from `memo.source`: load the
   *  class through the shared `loadConfinedWorker` (the SDK `processor.js` rides every load), mint
   *  it with `props: { contextName, name }` — its identity, read back as `ctx.props` — and hand it
   *  to `versionedFacet` (a source change restarts it in place; storage survives). The startup memo
   *  is written once (when it changes), so a facet named by `itx.facets.get(name)` alone still
   *  materializes after an eviction. NEVER retain the returned handle (#6800: re-`get` per burst;
   *  the quiesce alarm aborts). */
  async #facet(name: string, memo: FacetMemo): Promise<unknown> {
    this.#noteActivity();
    const stored = this.ctx.storage.kv.get(`facet:${name}`) as FacetMemo | undefined;
    if (!stored || stored.source !== memo.source || stored.className !== memo.className)
      this.ctx.storage.kv.put(`facet:${name}`, memo);
    this.#liveFacets.add(name);
    // Resolve the source ONCE per materialization, not once per commit (the memo above).
    const cached = this.#resolvedFacetSource.get(name);
    const resolved =
      cached?.srcPrint === memo.source
        ? { version: cached.version, modules: cached.modules }
        : undefined;
    const { worker, version, modules } = await loadConfinedWorker({
      env: this.env,
      invoke: (e) => this.invoke(e),
      host: itxEntrypointFor(this.ctx, this.#address.name),
      kind: "facet",
      owner: facetLoaderOwner(this.#address.name, memo.className),
      source: parse(memo.source) as WorkerSource,
      mainModule: "cap.js",
      what: `facet "${name}"`,
      ...(resolved && { resolved }),
    });
    if (!resolved) this.#resolvedFacetSource.set(name, { srcPrint: memo.source, version, modules });
    return versionedFacet(this.ctx, {
      worker,
      className: memo.className,
      facetName: name,
      markerKey: `facet:${name}:version`,
      version,
      props: { contextName: this.#address.name, name },
    });
  }

  /** Delete a facet, storage included (`itx.facets.delete(name)`; `disableProcessor` ends here). A
   *  re-load into the same name is a clean rebuild, never a resume from orphaned state. */
  deleteFacet(name: string): void {
    if (isInlineSlug(name))
      throw new Error(`"${name}" is an inline core reduce — it is always on, never a facet`);
    // facets.delete exists unconditionally on every runtime we run (production workerd,
    // wrangler-local, the vitest-plugin pool lane).
    this.ctx.facets.delete(name);
    this.ctx.storage.kv.delete(`facet:${name}`);
    this.ctx.storage.kv.delete(`facet:${name}:version`);
    this.#liveFacets.delete(name);
    this.#resolvedFacetSource.delete(name);
  }

  // ── dispatch (ONE path: the routing table — the INLINE core reduce, zero distance) ──

  /** Resolve + run one call against the current table. The ONE dispatch door — `IterateContext` builds the
   *  call Expression client-side and hands it here (the ARRAY half can carry call args a dotted
   *  STRING never could — callbacks, Dates, bytes: `["itx","tools",["transform",21,cb]]`). */
  async invoke(call: ItxExpression, depth = 0): Promise<unknown> {
    this.#noteActivity();
    const state = this.#table();
    return this.#capabilityTableProcessor().resolve(state, toExpression(call), undefined, depth);
  }

  /** Mount a capability: `path ⇒ target` (an expression rooted at itx). That is the whole event.
   *  PROVIDING WHAT IS ALREADY PROVIDED IS IDEMPOTENT: if the current winner at this exact path is
   *  this same target (compared as canonical strings), answer with ITS identity and append nothing
   *  — what keeps a reconnect's re-provide at ZERO events and the table bounded under churn, with
   *  the reduce left a pure shadow stack. A door policy, best-effort by design: two CONCURRENT
   *  identical provides may both land, which is a harmless shadow. */
  async provideCapability(input: {
    path: string;
    target: ItxExpression;
  }): Promise<{ providedAtOffset: number }> {
    this.#stream.touch();
    // CANONICALIZE ONCE, at the top (the one-canonicalizer rule, same spelling as rpcStubAttach):
    // the reduce stores the CANONICAL path.
    const pathString = parseCapabilityPath(input.path).join(".");
    const targetString = print(toExpression(input.target));
    const winner = this.#table()
      .mounts.filter((m) => m.path.join(".") === pathString)
      .sort((a, b) => b.providedAtOffset - a.providedAtOffset)[0];
    if (winner && print(winner.target) === targetString)
      return { providedAtOffset: winner.providedAtOffset };
    return this.#capabilityTableProcessor().provide({ path: pathString, target: input.target });
  }

  /** Revoke by the mount's identity — or by its capability path (pops the newest winner at that
   *  exact path; what it shadowed is restored). A mount and a parked stub are SEPARATE things:
   *  revoking a live capability's mount leaves its stub in the registry (the edge that parked it
   *  disposes its own relay on `itx.revoke(path)`), and a stub that dies leaves its mount in the
   *  table (calls answer CONNECTION_OFFLINE until someone revokes it or the provider re-parks under
   *  the same key — reconnect appends nothing). */
  async revokeCapability(input: { providedAtOffset?: number; path?: string }): Promise<void> {
    if (input.providedAtOffset !== undefined) {
      // By identity: append the revoked event even for an already-gone row (idempotent through
      // the reduce — a benign double-revoke must stay silent).
      await this.#capabilityTableProcessor().revoke({ providedAtOffset: input.providedAtOffset });
      return;
    }
    if (!input.path) throw new Error("revokeCapability: pass providedAtOffset or path");
    const pathString = parseCapabilityPath(input.path).join(".");
    const winner = this.#table()
      .mounts.filter((m) => m.path.join(".") === pathString)
      .sort((a, b) => b.providedAtOffset - a.providedAtOffset)[0];
    if (!winner) throw new Error(`no mount at path ${JSON.stringify(pathString)}`);
    await this.#capabilityTableProcessor().revoke({ providedAtOffset: winner.providedAtOffset });
  }

  // ── native fetch: the stub pager door, the fetch lane, observability, egress ──

  async fetch(request: Request): Promise<Response> {
    // AN ORDERED WALK OVER PARTIAL FETCHES (the fetch/fetch-capabilities.ts convention: each door
    // answers or returns null — middleware without a framework), ending in the egress terminal:
    //   1. the stub pager + live-capability upgrade-leg doors (rpc-stub machinery);
    //   2. the capability fetch lane (`x-itx-cap` — a fetch-shaped capability, 101s included);
    //   3. everything else is EGRESS (secret substitution → the FALLBACK terminal).
    const doors: PartialFetch[] = [
      (r) => this.#rpcStubs.fetch(r),
      (r) => this.#liveCapabilityFetch.acceptFetchUpgradeLeg(r),
      (r) =>
        serveCapabilityFetchLane(r, (expr, req) =>
          this.#capabilityTableProcessor().resolveFetch(this.#table(), expr, req),
        ),
    ];
    for (const door of doors) {
      const response = await door(request);
      if (response) return response;
    }
    return this.#egress(request);
  }

  // OBSERVABILITY has no dedicated verb: runtime state IS reduced state. Incarnation, pause, and
  // the breaker are the core reduce (`itx.facets.get('core').snapshot()`); mounts are the
  // capability table (`itx.facets.get('capability-table').snapshot()`); subscriptions and their
  // cursors are `itx.subscriptions.list()`. The snapshots read the inline reduces only — on a
  // VIRGIN context a probe mints nothing, the quiet-clock alarm included (#noteActivity skips the
  // arm when no facet is live and the stream never wrote; pinned in __workers-tests__/do-doors).
  // PRESENCE — which stubs have a transport RIGHT NOW — is physical, never event-derivable:
  // `itx.rpcStubs.list()` on the itx surface, and the socket census below for the probes.

  /** IN-MEMORY TRANSPORT FACTS ({stubs, pagedIn, pagesPending, dormant}) — a DO-only Workers-RPC
   *  verb for the hibernation/quiesce probes, deliberately OFF the itx surface: these are socket
   *  facts, not event-derivable state (`itx.rpcStubs.list()` is the edge half — the keys
   *  with a transport). */
  transportState(): Record<string, unknown> {
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
        ? this.env.SECRETS_KV.get(`secret:${this.#address.projectId}:${name}`)
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
    if (this.#liveCapabilityFetch.handleWebSocketClose(ws, 1006, "transport error")) return;
    this.#rpcStubs.closed(ws);
  }

  // ── the rpc-stub RPC verbs (the directory owns the lifecycle — see rpc-stub-directory.ts;
  // these are the relay-facing doors) ──

  /** Reserve a transport for the stub parked under `path` in the `itx.rpcStubs` registry — the
   *  relay calls this (with the CANONICALIZED path string, asserted here: one canonicalizer, no
   *  drift between the registry key and the mount that names it), then opens the pager carrying
   *  the returned transportId. */
  rpcStubAttach(input: { path: string }): { transportId: string } {
    const canonical = parseCapabilityPath(input.path).join(".");
    if (canonical !== input.path)
      throw new Error(
        `rpcStubAttach: path ${JSON.stringify(input.path)} is not canonical (expected ${JSON.stringify(canonical)}) — canonicalize at the edge with parseCapabilityPath(...).join(".")`,
      );
    return this.#rpcStubs.attach(input);
  }

  /** The page answer: the paged relay hands back a fresh RetainedCallbackInvoker stub, which
   *  stays warm until the idle quiesce disposes it (a page gets it back). */
  rpcStubActivate(input: {
    transportId: string;
    /** A Workers-RPC stub — a callable Proxy on the wire; structural validation is impossible
     *  by design, so it rides permissively and the directory types it at the seam. */
    invoker: unknown;
  }) {
    return this.#rpcStubs.activate({
      transportId: input.transportId,
      invoker: input.invoker as RetainedCallbackInvoker,
    });
  }
}
