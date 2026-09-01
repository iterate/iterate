// stream-durable-object.ts — THE STREAM: one DO per `{projectId, path}` (codec-named
// `{projectId}.iterate{path}`). The stream is the parent — LOG + SOCKETS + DOORS only; the
// CAPABILITY TABLE (capability-table-processor.ts) is an inline reduce-only processor at its
// PROCESSOR on it (processor-facet.ts), one among many:
//
//   • the EVENT LOG — SQLite append/read, monotonic offsets, idempotency at the commit point;
//   • the PROCESSORS — every enabled one a workerd FACET driven after each commit (built-ins by
//     slug, userspace classes via the Worker Loader); the capability host (whose reduced state
//     is the routing table) is the built-in first member, lazily enabled on first use;
//   • the TRANSPORT — every hibernatable socket: each held rpc stub is a delivery WebSocket from
//     the stateless relay (rpc-stub-directory.ts), so ANY number of connected clients leave this
//     DO free to hibernate. OUT is one-directional fire-and-forget delivery (event batches + state
//     changes); IN borrows a short RetainedCallbackInvoker leg per wake burst. A stub is addressed
//     by its caller-chosen key (`itx.rpcStubs.get(key)`); the registry is LIVE-ONLY (presence via
//     list(), no durable session history — that "connections view" returns later);
//   • the FETCH DOOR — the one place a 101 can enter: `x-itx-stub-pager` accepts a stub pager
//     WebSocket, `x-itx-cap` resolves the fetch lane, anything else is EGRESS (secret
//     placeholder substitution → the FALLBACK terminal).
//
// PURE WORKERS-RPC: capnweb never terminates here (hard rule) — the stateless `/api` worker
// relays. Dispatch is ONE door: `invoke(call)` — parse → route the table → substitute → evaluate
// → replay, all against the inline capability table; this class only delegates. (`Itx` builds the
// call Expression client-side; there is no separate dotted-string door on the DO.)

import { DurableObject } from "cloudflare:workers";
import { substituteHeaderSecrets } from "@v3/shared/egress";
import {
  facetLoaderOwner,
  loadConfinedWorker,
  versionedFacet,
  type WorkerSource,
} from "./core/worker-loader.ts";
import { createLogger } from "./core/logs.ts";
import { admit, breakerRemaining, CoreStreamProcessor, type CoreState } from "./core-processor.ts";
import { codedError, errorCode, reportIssue } from "./core/errors.ts";
import {
  type DeliveryPolicy,
  type StreamEvent,
  type StreamEventInput,
  type SubscriptionLane,
} from "./core/events.ts";
import {
  parse,
  print,
  toExpression,
  type Expression,
  type ItxExpression,
} from "./core/expression.ts";
import {
  LiveCapabilityFetchServer,
  serveCapabilityFetchLane,
  type PartialFetch,
} from "./core/fetch-capabilities.ts";
import { InlineCore } from "./core/inline-core.ts";
import { invokePath } from "./core/dispatch.ts";
import { InvokeHandle } from "./core/invoke-handle.ts";
import { hashSource } from "./core/hash.ts";
import { localContext, Stream, type WaitForEventFilter } from "./core/stream.ts";
import { RpcStubDirectory } from "./rpc-stub-directory.ts";
import {
  STUB_PAGER_KEEPALIVE_REQUEST,
  STUB_PAGER_KEEPALIVE_RESPONSE,
} from "./core/hibernatable-rpc-stub.ts";
import type { RetainedCallbackInvoker } from "./core/hibernatable-rpc-stub.ts";
import { DurableObjectNameCodec } from "./core/durable-object-names.ts";
import { itxEntrypointFor } from "./itx-entrypoint.ts";
import {
  CapabilityTableProcessor,
  type CapabilityTable,
  type ProcessorPolicy,
} from "./capability-table-processor.ts";
import { consumesEvent, type ReduceOnlyProcessor, type ScannedRange } from "./core/processor.ts";
import type { BuiltInsEnv } from "./built-ins.ts";
import { PROCESSOR_RUNNER_MODULE } from "./generated/processor-runner.ts";
import { buildBuiltIns } from "./built-ins.ts";
import { BUILT_IN_PROCESSOR_SLUGS, type FacetIdentity } from "./processor-facet.ts";

/** One enabled facet-hosted processor: a built-in slug, or — with `ref` — USERSPACE code (a
 *  source expression resolved to modules + which export is the StreamProcessor subclass). */
type FacetProcessorEntry = {
  slug: string;
  ref?: { source: Expression; className: string };
};

/** The duck-typed contract BOTH facet kinds satisfy (the built-in ProcessorFacet and the
 *  SDK-injected runner.js): identity in, pushed windows in, reduce + barrier out. */
type FacetProcessorHandle = {
  configure(identity: FacetIdentity): Promise<unknown> | unknown;
  processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<unknown> | unknown;
  snapshot(): Promise<{ offset: number; state: unknown }>;
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<unknown>;
};

/** ONE DERIVED subscription-mount row — a PROJECTION of the capability-provided/-revoked events
 *  at capability path `itx.subscribers.<name>` (subscription config is EVENT-SOURCED; this index
 *  exists only because the post-commit fan-out is the hot path and must not RPC anywhere to
 *  learn who to notify). CONNECTED targets are served right here (fire-and-forget batches down
 *  the paged-in stub); ABSENT targets are served by the subscription-forwarder facet, which
 *  keeps its own projection of the same events. */
type SubscriptionMount = DeliveryPolicy & {
  name: string;
  providedAtOffset: number; // the row's identity
  target?: Expression;
  /** The delivery lane (see `SubscriptionLane`) — the ONE fact every fan-out reader switches on,
   *  stamped at the provide door and projected here verbatim. `facet` = pump-driven facet,
   *  `connected` = live stub, `durable` = forwarder. */
  lane: SubscriptionLane;
  /** Present iff the lane is `facet` AND userspace code — the class that facet loads. A processor
   *  is a `facet`-lane subscriber; this is its code. */
  processor?: ProcessorPolicy;
};

// ── deriving a subscriber's LANE from its target shape — done ONCE, at the provide door ──
// These two matchers used to be consulted at ~7 read sites to re-classify a mount on every commit;
// now `laneOf` calls them ONCE when a mount is born and STORES the result as `lane` on the event
// (see `SubscriptionLane`). `rpcStubTarget` also survives as the auto-revoke KEY extractor
// (identity, not classification — no drift hazard). Every reader reads `row.lane`.

/** Match an RPC-STUB target: `itx.rpcStubs.get('<key>')`, optionally followed by a trailing dotted
 *  path (the callable on the retained callback that receives the delivery — `apply()` walks the raw
 *  target for that). Yields the `key` (lane derivation + auto-revoke identity); a trailing CALL step
 *  means the stub is a method receiver, not a delivery callable → NOT a connected lane. */
const rpcStubTarget = (t?: Expression): { key: string } | undefined => {
  if (!t || t.length < 3 || t[0] !== "itx" || t[1] !== "rpcStubs") return undefined;
  const call = t[2];
  if (!Array.isArray(call) || call.length !== 2 || call[0] !== "get" || typeof call[1] !== "string")
    return undefined;
  if (t.slice(3).some((step) => typeof step !== "string")) return undefined;
  return { key: call[1] };
};

/** Match a FACET target: `itx.facets.get('<slug>')` — a subscriber whose target is a co-located
 *  facet the commit pump drives (a processor). Used only by `laneOf`. */
const facetTarget = (t?: Expression): { slug: string } | undefined => {
  if (!t || t.length !== 3 || t[0] !== "itx" || t[1] !== "facets") return undefined;
  const call = t[2];
  if (!Array.isArray(call) || call.length !== 2 || call[0] !== "get" || typeof call[1] !== "string")
    return undefined;
  return { slug: call[1] };
};

/** THE lane classifier, called once per mount at the provide door — `itx.facets.get('slug')` ⇒
 *  facet (pump-driven), `itx.rpcStubs.get('key')` ⇒ connected (live stub), anything else ⇒
 *  durable (the forwarder facet's cursored lane). The result is stored on the mount so no reader
 *  ever re-derives it. */
const laneOf = (target: Expression): SubscriptionLane =>
  facetTarget(target) ? "facet" : rpcStubTarget(target) ? "connected" : "durable";

/** The subscription-forwarder facet's slug (auto-enabled when an absent-target subscription
 *  mount first appears). */
const SUBSCRIPTION_FORWARDER_SLUG = "subscription-forwarder";

function parseStreamDurableObjectName(name: string | undefined) {
  if (!name)
    throw new Error("StreamDurableObject must be addressed by name (reach it via getByName).");
  return DurableObjectNameCodec.parse(name);
}

/** The capability host's slug — hosted INLINE (see the inline-core section below). */
const CAPABILITY_TABLE_SLUG = "capability-table";
const CORE_SLUG = "core";
/** The two INLINE reduce-only processors: reduced at the commit point, never real facets — always
 *  on, un-disableable, addressed by name like any facet. The one predicate for "is this slug an
 *  inline core?" (was open-coded at four sites). */
const isInlineSlug = (slug: string): boolean =>
  slug === CAPABILITY_TABLE_SLUG || slug === CORE_SLUG;
/** The core processor is stateless (pure reduce) — one module-level instance serves every DO. */
const CORE_PROCESSOR = new CoreStreamProcessor();
const streamLog = createLogger("stream-do");

// The parent hosts the INLINE CORE (host scope + routing table + core reduce), so it needs the
// full roots env the facet used to inherit.
export class StreamDurableObject extends DurableObject<BuiltInsEnv> {
  /** WHO THIS DO IS — parsed ONCE from the unforgeable codec name; carries projectId, path
   *  AND its canonical string form (`.name`). A stream is only ever reached `getByName`; an
   *  id-addressed instance fails right here in the constructor, before it can touch anything. */
  readonly #address = parseStreamDurableObjectName(this.ctx.id.name);
  /** The live rpc-stub registry — the domain layer over the hibernatable RPC stubs (see
   *  rpc-stub-directory.ts). Live-only: presence via list(), no durable session history. */
  /** The live-capability fetch subsystem (core/fetch-capabilities.ts) — the DO wires its three
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
    // AUTO-REVOKE: when the LAST transport for a key is gone, a mount naming it can never deliver
    // again — pop it. A transport SWAP (keyFinal false) leaves the mount serving the survivor.
    onFinalClose: async ({ key, keyFinal }) => {
      if (!keyFinal) return;
      const table = this.#table();
      for (const m of table.mounts)
        if (rpcStubTarget(m.target)?.key === key)
          await this.revokeCapability({ providedAtOffset: m.providedAtOffset }).catch((e) =>
            reportIssue("stream-do.auto-revoke", e, { providedAtOffset: m.providedAtOffset }),
          );
    },
  });
  /** THE STREAM — the commit point (see core/stream.ts: validation + admission + idempotency +
   *  offsets + the wake record + waitForEvent + the alarm armer, one DI'd class). The name check
   *  already happened in the constructor (`#address`); the stream itself is storage-lazy. Its
   *  three host deps close over this DO: `admit` reads the core reduce (all pause/breaker
   *  reasoning lives in core-processor.ts), `reduceAtCommit` runs the INLINE REDUCES inside the
   *  commit transaction (the routing table and the core state are atomically exact as of the last
   *  committed event, always — the pump-races-the-provide class is unspellable, not carefully
   *  avoided; reduce errors are caught per event, a bad event skips, it never aborts the commit),
   *  and `onCommit` is the post-commit fan-out below. */
  readonly #stream = new Stream({
    storage: this.ctx.storage,
    path: this.#address.path,
    admit: (inputs) =>
      admit(this.#coreState(), inputs, Date.now(), (k) => this.#stream.hasIdempotencyKey(k)),
    reduceAtCommit: (justCommitted, after, next) =>
      this.#inlineCore.reduceAtCommit(justCommitted, after, next),
    // THE PUMP, fed `fresh` (the full in-range distinct batch, live-state/changed included):
    // drive every facet, then push the batch to connected subscribers, then publish the inline
    // reduces' own live-state deltas. Live-state changes never ride a drive — every reduce is
    // unconsumable to them (the platform rule) — so this callback derives `drivable` itself and
    // a live-state-only batch skips the drives (the next real range covers the skipped span).
    onCommit: (fresh, scannedAfterOffset, nextOffset) => {
      const drivable = fresh.filter((e) => e.type !== "events.iterate.com/live-state/changed");
      if (drivable.length > 0) this.#driveFacets(drivable, scannedAfterOffset, nextOffset);
      // CONNECTED subscription mounts get the batch pushed one-directionally, right now, from the
      // commit path — a synchronous fire-and-forget WebSocket send. (DURABLE targets ride the
      // subscription-forwarder facet, which is one of the drives above.)
      this.#deliverToConnectedSubscriptions(fresh, scannedAfterOffset, nextOffset);
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
   *  every enabled facet processor is PUSHED the batch with its scanned-offset-range proof.
   *  A thin wrapper: the whole pipeline lives in Stream.append; the tail runs #noteActivity on
   *  every LANDED append regardless of offset growth — a fully-deduped batch still refreshes the
   *  quiet clock (a REFUSED one doesn't, same as ever: arming the quiet-clock alarm is a storage
   *  write a rejected probe must not pay). */
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

  /** Per-facet drive state: `chain` serializes this facet's batches (a slow materialization must
   *  not let a later batch overtake an earlier one and get its ephemerals judged a stale
   *  redelivery); `deliveredThrough` is the last range end, so a facet whose consumes SKIPPED a
   *  batch still receives the skipped span inside its next range (a skip is an ephemeral hole to a
   *  reduce). One record per facet — merged from the two parallel maps this used to keep in sync. */
  readonly #facetDrives = new Map<string, { chain: Promise<unknown>; deliveredThrough: number }>();
  /** Per-facet resolved-source memo (keyed by facetName): the printed source expression it was
   *  resolved from, plus the fetched modules + their contentHash. The commit pump loads the same
   *  facet on every commit — without this, `#durableFacet` re-fetched + re-hashed the userspace
   *  source on EVERY commit (prove_source_refetch). Kept ONLY while the facet is live: dropped on
   *  disable and cleared at idle-quiesce, so a source edit is picked up at the next materialization
   *  (never mid-incarnation per-commit — which the deploy-keyed loader was never meant to do). */
  readonly #resolvedFacetSource = new Map<
    string,
    { srcPrint: string; version: string; modules: Record<string, string> }
  >();
  // The in-flight count the quiesce alarm respects (aborting a facet mid-REDUCE is exactly the
  // stall the resurrection pass exists to heal — never cause it).
  #facetWorkInFlight = 0;

  /** Push a batch + its scanned range into every facet, SERIALIZED PER FACET. Fire-and-forget from
   *  append's view — an awaited drive would deadlock when a facet appends during its own batch (the
   *  capability host does, on provide/revoke). The push is what wakes an aborted facet; reads stay
   *  correct regardless because every snapshot/invoke gap-repairs from the log. */
  #driveFacets(drivable: StreamEvent[], scannedAfterOffset: number, nextOffset: number): void {
    for (const { slug } of this.#facetEntries()) {
      this.#facetWorkInFlight++;
      const prev = this.#facetDrives.get(slug);
      const after = prev?.deliveredThrough ?? scannedAfterOffset;
      const chain = (prev?.chain ?? Promise.resolve())
        .then(() => this.#facet(slug))
        .then((f) => f.processEventBatch(drivable, { after, through: nextOffset }))
        .catch((e) => reportIssue("stream-do.facet-drive", e, { slug }))
        .finally(() => {
          this.#facetWorkInFlight--;
          this.#noteActivity(); // a finished reduce earns a fresh quiet period
        });
      this.#facetDrives.set(slug, { chain, deliveredThrough: nextOffset });
    }
  }

  // ── THE INLINE CORE: reduce-only processors reduced at the stream's commit point. The engine —
  // rehydrate / catch up / reduce-at-commit / checkpoint / publish-live-state — lives in
  // core/inline-core.ts; this DO owns only the DEFS (which processors are inline), because
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

  /** The two inline-core reduced states, typed in ONE place. `#table()` = the capability mount
   *  table; `#coreState()` = the core reduce (pause/breaker). */
  #table(): CapabilityTable {
    return this.#inlineCore.entry(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
  }
  #coreState(): CoreState {
    return this.#inlineCore.entry(CORE_SLUG).state as CoreState;
  }

  /** THE capability host, parent-constructed: same class, same contract, zero distance. */
  #capabilityTableProcessor(): CapabilityTableProcessor {
    if (this.#capabilityTableInstance) return this.#capabilityTableInstance;
    const { projectId, path } = this.#address;
    const ownContext = localContext(this); // the own DO as a uniform-async Context (core/stream.ts)
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
      // The rpcStubs + facets views are PARENT-LOCAL — the pager sockets and facets
      // live here and can never move (workerd#6702: sockets never leave the parent).
      rpcStubs: {
        // A GENUINE RpcTarget (not a bare pathProxy) so `itx.rpcStubs.get('b').hello()`
        // pipelines the mid-chain `.hello()` on every lane — workerd's classifier rejects a
        // Proxy (#6873). The fold is identical: `.hello()` → invoke(key, ['hello'], []).
        get: (key) => new InvokeHandle((path, args) => this.#rpcStubs.invoke(key, path, args)),
        list: () => this.#rpcStubs.list(),
        close: (key) => this.#rpcStubs.close(key),
      },
      facets: {
        get: (ref) => new InvokeHandle((path, args) => this.facetInvoke(ref, path, args)),
      },
      hostCtx: this.ctx,
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

  #inlineDefs(): { slug: string; proc: ReduceOnlyProcessor<unknown> }[] {
    return [
      { slug: CORE_SLUG, proc: CORE_PROCESSOR as ReduceOnlyProcessor<unknown> },
      {
        slug: CAPABILITY_TABLE_SLUG,
        proc: this.#capabilityTableProcessor() as ReduceOnlyProcessor<unknown>,
      },
    ];
  }

  read(afterOffset = 0, limit = 500): { events: StreamEvent[]; scannedThroughOffset: number } {
    return this.#stream.read(afterOffset, limit);
  }

  // ── the #6800 quiesce: idle facets un-pinned so this actor can hibernate ──

  #lastActivityMs = 0;
  #noteActivity(): void {
    this.#lastActivityMs = Date.now();
    this.#stream.armNoLaterThan(this.#lastActivityMs + 60_000);
  }
  // In-memory on purpose: a fresh incarnation always runs one resurrection pass, and losing
  // the flag with an eviction is exactly the point.
  #facetsResurrected = false;

  /** EVERY facet name materialized this incarnation — processors (`proc:<slug>`) AND stateful
   *  instances (`named:<name>` / `stateful:<class>:<hash>`), in ONE set. The quiesce alarm aborts
   *  the whole set in one loop so no LIVE facet (of either kind) pins this actor awake. In memory
   *  on purpose: facets die with the incarnation, and a fresh call re-materializes from durable
   *  storage. (Only processors are also RESURRECTED — `#facetEntries`, the durable driven registry;
   *  a stateful facet re-materializes on its next call, so it needs no catch-up pass.) */
  readonly #liveFacets = new Set<string>();

  async alarm(): Promise<void> {
    this.#stream.markFired();
    // Facets have no alarms (workerd#6810) — the parent proxies. The subscription-forwarder's
    // due retries pump here; it re-arms itself through armSubscriptionRetry when work remains.
    // AWAITED, deliberately, so the pump completes BEFORE the quiesce check below: (a) the abort
    // can never land mid-pump (aborting mid-delivery is the stall the resurrection pass exists to
    // heal, and an aborted pump never re-arms), and (b) a pump that finds only FUTURE retries
    // re-arms the alarm for the earliest one — that re-arm must land before quiesce hibernates
    // this actor, or the retry is lost until the next append. (No deadlock: append never awaits
    // its facet drives, so a delivery that appends its own halt event returns promptly.)
    if (this.#facetEntries().some((e) => e.slug === SUBSCRIPTION_FORWARDER_SLUG))
      await this.#facet(SUBSCRIPTION_FORWARDER_SLUG)
        .then((f) =>
          (
            f as unknown as { pumpSubscriptionDeliveries(): Promise<unknown> }
          ).pumpSubscriptionDeliveries(),
        )
        .catch((e) => reportIssue("stream-do.forwarder-pump", e));
    if (!this.#facetsResurrected) {
      // THE RESURRECTION PASS: a reduce interrupted by eviction, with no follow-up traffic,
      // would otherwise stall until the next append (the pump only fires on commits). The
      // first alarm of each incarnation asks every facet for a snapshot — which IS its
      // catch-up: a behind facet gap-repairs from its own durable cursor, a caught-up one
      // no-ops. The pass is idle-neutral by construction: #facet no longer calls #noteActivity
      // (it was moved to facetInvoke), so materializing every facet here does NOT refresh the
      // quiet clock — and a genuine append that DID land during this await must keep its
      // #noteActivity, so we must NOT capture-and-restore #lastActivityMs (that erased real
      // traffic → wrongful abort + an immediate-fire alarm loop on a fresh incarnation).
      // (State rows need no resurrection: the stream holds no live-state delivery state — a
      // dropped forward surfaces as a chain gap at the client, which re-reads the door.)
      this.#facetsResurrected = true;
      await Promise.allSettled(
        this.#facetEntries().map(({ slug }) =>
          this.#facet(slug)
            .then((f) => f.snapshot())
            .catch((e) => reportIssue("stream-do.facet-resurrection", e, { slug })),
        ),
      );
    }
    if (Date.now() - this.#lastActivityMs >= 60_000 && this.#facetWorkInFlight === 0) {
      // workerd #6800: a live facet client holds this actor idle-but-non-hibernatable,
      // converting quiet time into billed duration. Abort every facet once the stream has been
      // quiet — their cursors are durable in their OWN storage and delivery is cursor-driven,
      // so nothing is lost (replies are output-gated; abort keeps storage; rebuild ~50-700ms).
      // Never while a drive/reduce is in flight: aborting mid-reduce is the stall the resurrection
      // pass exists to heal. ONE loop over every live facet — processors and stateful instances
      // alike, since they pin the actor the same way.
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

  // ── SUBSCRIPTION DELIVERY, connected lane: one-directional, from the commit path ──
  // A CONNECTED subscription mount (target itx.rpcStubs.get(…)) is served by raw
  // fire-and-forget invokes on the connection's paged-in stub: the filtered batch plus the
  // GLOBAL ScannedRange. No acks, no server cursor, no retry ladder, no watchdogs, no
  // outbound coalescing (owner decision — the socket buffer is the only queue; overflow closes
  // the socket and the close IS the heal signal). The CLIENT owns its offset: delivered ranges
  // chain (each `after` === the last `through`), so a gap is one
  // comparison and heals with read(afterOffset). ABSENT targets are the subscription-forwarder
  // facet's lane (cursor + the one bounded-retry-then-halt policy) — see
  // subscription-forwarder-processor.ts.

  /** DERIVED from the capability table (the one reduce): subscriber mounts ARE the rows. */
  #subscriptionMounts(): SubscriptionMount[] {
    const state = this.#table();
    const rows: SubscriptionMount[] = [];
    for (const m of state.mounts) {
      if (m.path.length === 3 && m.path[0] === "itx" && m.path[1] === "subscribers")
        rows.push({
          name: m.path[2],
          providedAtOffset: m.providedAtOffset,
          ...((m.delivery ?? {}) as DeliveryPolicy),
          target: m.target,
          // Read the stamped lane verbatim — every `itx.subscribers.*` mount is laned at the provide
          // door (provideCapability / enableProcessor), so there is nothing to re-derive.
          lane: m.lane as SubscriptionLane,
          ...(m.processor && { processor: m.processor as ProcessorPolicy }),
        });
    }
    return rows;
  }
  /** The served rows: per name, the NEWEST provide wins (the shadow stack, projected). */
  #activeSubscriptionMounts(): SubscriptionMount[] {
    const byName = new Map<string, SubscriptionMount>();
    for (const r of this.#subscriptionMounts()) {
      const cur = byName.get(r.name);
      if (!cur || r.providedAtOffset > cur.providedAtOffset) byName.set(r.name, r);
    }
    return [...byName.values()];
  }

  /** Per-row deliveredThroughOffset, IN MEMORY only: lets a row whose consumes filter skipped
   *  whole batches receive the skipped span inside its next delivered ScannedRange (so the
   *  client's contiguity check holds without empty-batch sends). Losing it (eviction) just makes
   *  one delivered range start late — the client sees a gap once and pulls once. */
  readonly #subscriptionDeliveredThrough = new Map<number, number>();

  #deliverToConnectedSubscriptions(
    committed: StreamEvent[],
    scannedAfterOffset: number,
    nextOffset: number,
  ): void {
    const state = this.#table();
    // Deliver by EVALUATING the row's itx-expression target and applying the delivery args — the
    // SAME door the forwarder uses (deliverTo → apply → the dotted call chain on an rpc stub). No
    // parallel invoke-by-key path: connected vs forwarder differ ONLY in POLICY (this lane is
    // fire-and-forget from the commit path; the forwarder facet owns cursor + bounded retry), never
    // in HOW the target is reached. A CONNECTION_OFFLINE on a closing race is the benign heal-by-pull
    // case — swallow it; anything else is a real drop worth a line.
    const fire = (row: SubscriptionMount, args: unknown[], onDrop: (err: unknown) => void) =>
      void this.#capabilityTableProcessor()
        .deliverTo(state, row.providedAtOffset, args)
        .catch((err) => {
          if (errorCode(err) !== "CONNECTION_OFFLINE") onDrop(err);
        });
    for (const row of this.#activeSubscriptionMounts()) {
      if (row.lane !== "connected") continue; // facet (pump) / durable (forwarder) — not this lane
      if (row.liveState) {
        // State mode: forward each committed change payload for the watched key, raw (no
        // in-flight tracking, no latest-wins queue — the owner's no-coalescing decision; a
        // dropped or reordered payload is a revision-chain mismatch the client door-heals).
        for (const e of committed) {
          if (e.type !== "events.iterate.com/live-state/changed") continue;
          if ((e.payload as { key?: string } | undefined)?.key !== row.liveState.key) continue;
          fire(row, [e.payload], (err) =>
            console.error(`live-state "${row.name}" delivery failed (client re-seeds on gap)`, err),
          );
        }
        continue;
      }
      // Event mode: the consumes filter, applied statelessly outbound. Default = every durable
      // event; naming types opts into ephemerals too (the processor consumes rule, mirrored).
      // The live-state/changed type never rides the event lane (the platform rule).
      const events = committed.filter((e) => consumesEvent(row.consumes, e));
      if (events.length === 0) continue; // the skipped span rides the next delivered range
      const deliveredAfter =
        this.#subscriptionDeliveredThrough.get(row.providedAtOffset) ?? scannedAfterOffset;
      this.#subscriptionDeliveredThrough.set(row.providedAtOffset, nextOffset);
      fire(
        row,
        [
          events,
          {
            after: Math.min(deliveredAfter, scannedAfterOffset),
            through: nextOffset,
          } satisfies ScannedRange,
        ],
        // Survivable by design — the client sees the range gap and heals by pull.
        (err) =>
          streamLog.warn("event-batch delivery dropped", {
            event: "delivery.event-batch.dropped",
            subscriptionName: row.name,
            error: err,
          }),
      );
    }
  }

  // ── the forwarder's parent doors (absent-target delivery lives in the facet) ──

  /** Deliver BY ROW IDENTITY — never by name through the table (a broad default route must not
   *  intercept deliveries). The subscription-forwarder calls this per batch; substitution +
   *  apply run against the inline reduce. */
  deliverToSubscriptionMount(input: {
    providedAtOffset: number;
    args: unknown[];
  }): Promise<unknown> {
    const state = this.#table();
    return this.#capabilityTableProcessor().deliverTo(state, input.providedAtOffset, input.args);
  }

  /** The alarm proxy (facets have no alarms — workerd#6810): the forwarder reports its earliest
   *  nextAttemptAtMs and the parent's alarm pumps it when due. */
  armSubscriptionRetry(input: { atMs: number }): { ok: true } {
    this.#stream.armNoLaterThan(input.atMs);
    return { ok: true };
  }

  /** Recovery from a forwarder HALT (or an operator cursor seek) — proxied to the facet, which
   *  owns every absent-target cursor. Connected targets have no server cursor to move. */
  async resumeSubscription(input: { name: string; afterOffset?: number }): Promise<{ ok: true }> {
    const row = this.#activeSubscriptionMounts().find((r) => r.name === input.name);
    if (!row) throw new Error(`no subscription "${input.name}"`);
    if (row.lane === "connected")
      throw new Error(
        `"${input.name}" delivers one-directionally to a connected client — there is no server cursor; the client heals itself with read(afterOffset)`,
      );
    if (!this.#facetEntries().some((e) => e.slug === SUBSCRIPTION_FORWARDER_SLUG))
      throw new Error("no subscription-forwarder enabled (nothing to resume)");
    // Recovery RIDES THE LOG: a durable subscription-resumed fact, consumed by the forwarder
    // like any other event (auditable, ordered by the drive chain — no side-channel verb). A
    // beyond-head afterOffset is CLAMPED to the head so an operator fat-finger can't park the
    // cursor past reality and wedge the row forever.
    const head = this.#stream.highestAssignedOffset();
    await this.append({
      type: "events.iterate.com/stream/subscription-resumed",
      payload: {
        name: input.name,
        ...(input.afterOffset !== undefined && {
          afterOffset: Math.min(input.afterOffset, head),
        }),
      },
    });
    return { ok: true };
  }

  // ── facet-hosted processors (built-ins via processor-facet.ts; userspace via the LOADER) ──

  /** DERIVED from the capability table: the PROCESSORS are exactly the subscriber mounts whose
   *  target is a co-located facet (`itx.subscribers.<slug> → itx.facets.get('<slug>')`). A
   *  processor IS a subscription to a facet — one namespace, no separate `itx.processors.*`.
   *  Enablement is event-sourced like every other attachment; newest same-name mount wins
   *  (`#activeSubscriptionMounts` already projects the shadow stack). */
  #facetEntries(): FacetProcessorEntry[] {
    const entries: FacetProcessorEntry[] = [];
    for (const row of this.#activeSubscriptionMounts()) {
      if (row.lane !== "facet") continue; // connected/durable subscriber, not a pump-driven facet
      const policy = (row.processor ?? {}) as ProcessorPolicy;
      entries.push({
        slug: row.name,
        ...(policy.source && {
          ref: { source: parse(policy.source), className: policy.className ?? "default" },
        }),
      });
    }
    return entries;
  }

  /** Materialize (or reuse) the facet hosting `slug`. A stored `ref` means USERSPACE: the
   *  user's modules ride the Worker Loader beside the injected SDK (`processor.js` — base class
   *  + contract helper + zod) and the generic runner DO (`runner.js`); the user exports
   *  `class X extends StreamProcessor` and never writes a DurableObject. Both facet kinds speak
   *  the same duck contract: configure / processEventBatch / snapshot / waitUntilProcessed.
   *  NEVER retain the returned handle (#6800: re-`get` per burst; the quiesce alarm aborts). */
  async #facet(slug: string): Promise<FacetProcessorHandle> {
    // A facet exists iff its mount does — no silent resurrection of a disabled slug, and the
    // half-enabled-provide door is closed: a slug with no entry throws instead of materializing
    // an unconfigured facet that storms every drive.
    const entry = this.#facetEntries().find((e) => e.slug === slug);
    if (!entry) throw codedError("NO_FACET", `no facet processor "${slug}" enabled`);
    this.#liveFacets.add(`proc:${slug}`); // tracked for the one quiesce loop, beside stateful facets
    let handle: FacetProcessorHandle;
    if (!entry.ref) {
      const exports = (this.ctx as unknown as { exports: Record<string, unknown> }).exports;
      handle = this.ctx.facets.get(`proc:${slug}`, () => ({
        class: exports.ProcessorFacet as DurableObjectClass,
      })) as unknown as FacetProcessorHandle;
    } else {
      handle = (await this.#durableFacet({
        source: entry.ref.source,
        discriminator: slug,
        loadedClassName: "ProcessorFacetRunner",
        mainModule: "runner.js",
        extraModules: { "runner.js": PROCESSOR_RUNNER_MODULE },
        facetName: `proc:${slug}`,
        markerKey: `procfacet:${slug}:version`,
        what: `processor "${slug}"`,
      })) as FacetProcessorHandle;
    }
    // CONFIGURE AT MATERIALIZATION — identity is derived ENTIRELY from the mount + this DO's
    // address, so enablement is ONE event-sourced fact. No configure-after-provide side-channel
    // that a raw provide or a log replay could skip; idempotent, so steady drives don't write.
    await handle.configure({
      parentName: this.#address.name,
      projectId: this.#address.projectId,
      path: this.#address.path,
      slug,
      ...(entry.ref?.className && { className: entry.ref.className }),
    });
    return handle;
  }

  /** Load a class as a FACET of this stream — the ONE loader for both a userspace `StreamProcessor`
   *  (behind the `runner.js` adapter + SDK, commit-driven) and a raw stateful `DurableObject` class
   *  (loaded directly and called). Shared: `loadConfinedWorker` (kind "facet") → `versionedFacet`;
   *  the SDK (`processor.js`) rides every load. The caller passes the `mainModule`/`extraModules` it
   *  wants (a processor its `runner.js` adapter; a raw class nothing) — no role re-branch here. The
   *  loader `owner` is composed collision-free (`facetLoaderOwner`). */
  async #durableFacet(opts: {
    source: WorkerSource;
    /** The owner's second half — a processor slug or a stateful className. */
    discriminator: string;
    /** The class `versionedFacet` instantiates (the runner for a processor). */
    loadedClassName: string;
    /** The loaded module that exports the class (`runner.js` for a processor, `cap.js` for a
     *  raw stateful class), and any adapter modules to layer over the source + SDK. */
    mainModule: string;
    extraModules?: Record<string, string>;
    facetName: string;
    markerKey: string;
    what: string;
  }): Promise<unknown> {
    // Resolve the source ONCE per materialization, not once per commit: a memo keyed by the printed
    // source expression skips the fetch+hash on a warm facet (agent-C fix; prove_source_refetch).
    const srcPrint =
      typeof opts.source === "string"
        ? opts.source
        : Array.isArray(opts.source)
          ? print(opts.source)
          : JSON.stringify(opts.source);
    const memo = this.#resolvedFacetSource.get(opts.facetName);
    const resolved =
      memo?.srcPrint === srcPrint ? { version: memo.version, modules: memo.modules } : undefined;
    const { worker, version, modules } = await loadConfinedWorker({
      env: this.env,
      invoke: (e) => this.invoke(e),
      host: itxEntrypointFor(this.ctx, this.#address.name),
      kind: "facet",
      owner: facetLoaderOwner(this.#address.name, opts.discriminator),
      source: opts.source,
      mainModule: opts.mainModule,
      extraModules: opts.extraModules,
      what: opts.what,
      ...(resolved && { resolved }),
    });
    if (!resolved) this.#resolvedFacetSource.set(opts.facetName, { srcPrint, version, modules });
    return versionedFacet(this.ctx, {
      worker,
      className: opts.loadedClassName,
      facetName: opts.facetName,
      markerKey: opts.markerKey,
      version,
    });
  }

  /** Enable a facet-hosted processor on this stream (idempotent; identity configured durably).
   *
   *  SUGAR, deliberately: enabling a processor is just LOADING A CLASS AS A FACET (the same
   *  `source` + `className` that `itx.load(src).getDurableObjectClass(className)` takes — `source`
   *  an expression resolved to modules, `className` the exported StreamProcessor subclass) PLUS one
   *  appended fact — a SUBSCRIPTION mount `itx.subscribers.<slug> → itx.facets.get('<slug>')`. A
   *  processor is just a subscription whose target is a co-located facet: the commit pump drives
   *  every facet-target subscriber. The only difference from a stateful
   *  `itx.load(src).getDurableObjectClass(className).get()`: a processor's class extends
   *  `StreamProcessor` (loaded behind the `runner.js` adapter, so the author writes a reduce, never
   *  a DurableObject). So `enableProcessor` == subscribe a facet; there is no separate
   *  `itx.processors.*` namespace and no second "enablement" concept. */
  async enableProcessor(
    slug: string,
    ref?: { source: string | Expression; className: string },
  ): Promise<{ ok: true }> {
    this.#stream.touch();
    if (isInlineSlug(slug))
      throw new Error(`"${slug}" is an inline core processor — it is always on, never a facet`);
    if (!/^[A-Za-z0-9_-]+$/.test(slug))
      throw new Error(`invalid processor slug ${JSON.stringify(slug)}: one segment, [A-Za-z0-9_-]`);
    if (!ref && !BUILT_IN_PROCESSOR_SLUGS.has(slug))
      throw new Error(
        `no built-in processor ${JSON.stringify(slug)} (pass a ref for userspace code)`,
      );
    // Enablement IS a subscription mount at itx.subscribers.<slug> targeting the facet: the
    // processor policy rides the capability-provided event (event-sourced, auditable, shadowable).
    // #facet configures at materialization from that mount alone — the warm-up here just makes an
    // immediate snapshot ready.
    await this.#capabilityTableProcessor().provide({
      path: `itx.subscribers.${slug}`,
      target: `itx.facets.get('${slug}')`,
      lane: "facet", // a processor IS a facet-lane subscriber — declared, not sniffed
      processor: {
        ...(ref && { source: print(toExpression(ref.source)), className: ref.className }),
      },
    });
    await this.#facet(slug); // not for correctness (the mount's own drive configures) — makes an
    // immediate post-enable snapshot synchronously ready (the drive is fire-and-forget).
    return { ok: true };
  }

  /** Disable a facet processor: remove its row and DELETE its facet — storage included (the
   *  reduce is derived state, rebuildable from the log by re-enabling; the missing off-switch
   *  the hunt flagged: before this, a misbehaving userspace processor burned a loader
   *  materialization + error log on EVERY commit with no remedy but hand-editing kv). */
  async disableProcessor(slug: string): Promise<{ ok: true }> {
    if (isInlineSlug(slug))
      throw new Error(`"${slug}" is an inline core processor — it cannot be disabled`);
    this.#facetDrives.delete(slug); // a re-enable must not inherit a chain or a scanned range it never saw
    this.#liveFacets.delete(`proc:${slug}`);
    this.#resolvedFacetSource.delete(`proc:${slug}`); // a re-enable re-fetches the (possibly new) source
    // Clear the WHOLE enablement stack (a double-enable leaves >1 mount) — else an older shadowed
    // mount is re-elected and the "disabled" processor keeps running with deleted storage.
    await this.revokeCapability({ path: `itx.subscribers.${slug}`, all: true });
    // DELETE, storage included — a disable→re-enable is a clean rebuild, never a resume from
    // orphaned cursor/state. (facets.delete exists unconditionally on every runtime we run —
    // production workerd, wrangler-local, and the vitest-plugin pool lane; the abort() fallback
    // that kept storage was dead code and is gone.)
    this.ctx.facets.delete(`proc:${slug}`);
    return { ok: true };
  }

  /** THE generic facet door: resolve the facet LOCALLY (facet stubs are non-transferable — the
   *  walk happens where the stub lives), walk the dotted path with the exposure guard, apply
   *  the terminal. `roots.facets` (and via one seed, `itx.facets`) rides this to reach ANY
   *  method a facet's durable object exposes — a facet hosts an object; processor is a role. */
  async facetInvoke(
    ref: string | { source?: unknown; className?: string; name?: string },
    path: string[],
    args: unknown[],
  ): Promise<unknown> {
    this.#noteActivity(); // (was in #facet — moved out so the resurrection pass stays idle-neutral)
    if (path.length === 0) throw new Error(`facet: name a method`);
    // Counted like a drive: a CONCURRENT alarm's quiesce must never abort the facet mid-call
    // (#noteActivity above only guards the first 60s; a long invoke outlives it).
    this.#facetWorkInFlight++;
    try {
      const facet = await this.#resolveFacet(ref);
      // A top-level `.fetch` forwards to the facet's own fetch — the one channel that carries a
      // 101 natively (core/fetch-capabilities.ts doctrine, points 1 & 4) — never through
      // invokePath's await-walk. A method walks receiver-preservingly (invokePath).
      if (path.length === 1 && path[0] === "fetch")
        return await (facet as Fetcher).fetch(args[0] as Request);
      const what =
        typeof ref === "string"
          ? `facet "${ref}"`
          : ref.name
            ? `named "${ref.name}"`
            : `worker "${ref.className}"`;
      return await invokePath(facet, path, args, what);
    } finally {
      this.#facetWorkInFlight--;
      this.#noteActivity(); // a finished invoke earns a fresh quiet period (mirrors #driveFacets)
    }
  }

  /** THE one facet resolver: turn ANY ref into a live facet handle. A NAME (string) resolves an
   *  inline core (always at head, a synthesized snapshot view), an enabled processor (its mount
   *  names the source), or a named durable instance (its registration does). A LOAD SPEC
   *  (`{ source, className, name? }` — `itx.load(...)`) materializes the class as a facet, first
   *  registering a NAMED instance durably (parent kv) so a later `load({ name })` re-materializes it
   *  after an eviction — its own DO storage having survived. Throws NO_FACET for an unknown name. */
  async #resolveFacet(
    ref: string | { source?: unknown; className?: string; name?: string },
  ): Promise<unknown> {
    if (typeof ref !== "string") {
      if (ref.source !== undefined && ref.className) {
        const source = toExpression(ref.source as ItxExpression);
        if (ref.name)
          this.ctx.storage.kv.put(`named-facet:${ref.name}`, {
            source: print(source),
            className: ref.className,
          });
        return this.#statefulFacet({ source, className: ref.className }, ref.name);
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
    if (this.#facetEntries().some((e) => e.slug === ref)) return this.#facet(ref);
    const reg = this.ctx.storage.kv.get(`named-facet:${ref}`) as
      | { source: string; className: string }
      | undefined;
    if (reg)
      return this.#statefulFacet({ source: parse(reg.source), className: reg.className }, ref);
    throw codedError("NO_FACET", `no facet "${ref}" enabled or registered`);
  }

  // ── stateful loaded classes: FACETS of this stream (the dedicated runner DO died in 57) ──

  /** Materialize (or reuse) the facet hosting a loaded `className`. Same confinedWorker +
   *  versionedFacet as userspace processors. A NAMED instance (`itx.load({source, className, name})`)
   *  keys its DO storage on the NAME — two names are two independent states of the same class; an
   *  unnamed one is CONTENT-keyed (`stateful:<class>:<hash>`), the anonymous run-a-class case. The
   *  loader isolate is keyed by className either way (same code, one isolate; distinct DO storage). */
  async #statefulFacet(
    ref: { source: Expression; className: string },
    name?: string,
  ): Promise<unknown> {
    this.#noteActivity();
    const facetName = name
      ? `named:${name}`
      : `stateful:${ref.className}:${hashSource(JSON.stringify(ref.source))}`;
    this.#liveFacets.add(facetName);
    return this.#durableFacet({
      source: ref.source,
      discriminator: ref.className,
      loadedClassName: ref.className,
      mainModule: "cap.js", // a raw stateful class is loaded as-is (no runner adapter)
      facetName,
      markerKey: `${facetName}:version`,
      what: name ? `named worker "${name}"` : `stateful worker "${ref.className}"`,
    });
  }

  // ── dispatch (ONE path: the routing table — the INLINE core reduce, zero distance) ──

  /** Resolve + run one call against the current table. The ONE dispatch door — `Itx` builds the
   *  call Expression client-side and hands it here (a full expression can spell mid-path call args
   *  a dotted string never could: `itx.streams.get('/').append({...})`). */
  async invoke(call: ItxExpression, depth = 0): Promise<unknown> {
    this.#noteActivity();
    const state = this.#table();
    return this.#capabilityTableProcessor().resolve(state, toExpression(call), undefined, depth);
  }

  /** Mount a userspace capability (its target recurses through itx; built-ins resolve directly). A
   *  subscription mount with an ABSENT target auto-enables the subscription-forwarder facet
   *  FIRST, so the mount's own commit already drives the forwarder. liveState demands a
   *  CONNECTED target: an absent target holds no revision chain, so a dropped payload could
   *  never be noticed — reject at the door, not at delivery time. */
  async provideCapability(input: {
    path: string | string[];
    target: ItxExpression;
    delivery?: DeliveryPolicy;
    processor?: ProcessorPolicy;
  }): Promise<{ providedAtOffset: number }> {
    this.#stream.touch();
    const pathString = typeof input.path === "string" ? input.path : input.path.join(".");
    const targetExpr = toExpression(input.target);
    // Classify the delivery lane ONCE, here at the provide door — it is stamped on the mount event
    // and every commit-time reader reads it back (no per-commit target re-sniff). Non-subscriber
    // mounts (plain aliases) carry no lane. `durable` is the absent target — the forwarder's lane.
    const isSubscriber = pathString.startsWith("itx.subscribers.");
    const lane = isSubscriber ? laneOf(targetExpr) : undefined;
    if (lane === "durable") {
      if (input.delivery?.liveState)
        throw new Error(
          "a live-state subscription needs a live rpc-stub target (itx.rpcStubs.get(…)) — an absent target has no revision chain to keep",
        );
      if (!this.#facetEntries().some((e) => e.slug === SUBSCRIPTION_FORWARDER_SLUG))
        await this.enableProcessor(SUBSCRIPTION_FORWARDER_SLUG);
    }
    return this.#capabilityTableProcessor().provide({ ...input, ...(lane && { lane }) });
  }

  /** Revoke by the mount's identity — or by its capability path (pops the newest winner at
   *  that exact path; what it shadowed is restored). */
  async revokeCapability(input: {
    providedAtOffset?: number;
    path?: string | string[];
    /** Clear EVERY mount at `path` — the subscription/processor OFF-SWITCH. The default (and
     *  `itx.revoke({path})`) pops only the NEWEST winner and restores what it shadowed; an
     *  off-switch must remove the whole enablement shadow stack, or an older shadowed mount is
     *  re-elected and the "disabled" thing keeps running (prove_disable_shadow.mjs /
     *  probe_resub_zombie.mjs). */
    all?: boolean;
  }): Promise<void> {
    if (input.all) {
      if (!input.path) throw new Error("revokeCapability: `all` needs a path");
      const pathString = typeof input.path === "string" ? input.path : input.path.join(".");
      const offsets = this.#table()
        .mounts.filter((m) => m.path.join(".") === pathString)
        .map((m) => m.providedAtOffset);
      for (const providedAtOffset of offsets) {
        await this.#capabilityTableProcessor().revoke({ providedAtOffset });
        this.#subscriptionDeliveredThrough.delete(providedAtOffset);
      }
      return;
    }
    let providedAtOffset = input.providedAtOffset;
    if (providedAtOffset === undefined) {
      if (!input.path) throw new Error("revokeCapability: pass providedAtOffset or path");
      const pathString = typeof input.path === "string" ? input.path : input.path.join(".");
      const table = this.#table();
      const winner = table.mounts
        .filter((m) => m.path.join(".") === pathString)
        .sort((a, b) => b.providedAtOffset - a.providedAtOffset)[0];
      if (!winner) throw new Error(`no mount at path ${JSON.stringify(pathString)}`);
      providedAtOffset = winner.providedAtOffset;
    }
    await this.#capabilityTableProcessor().revoke({ providedAtOffset });
    // Revoke doubles as GC for the delivered-through watermark keyed by the mount's identity.
    // (The forwarder GCs its own SubscriptionDeliveryProgress on the revoked event.)
    this.#subscriptionDeliveredThrough.delete(providedAtOffset);
    // NOTE: a mount naming an rpc stub is NOT reaped here — the stub's lifecycle is owned by its
    // ProvidedStub handle (dispose it ⇒ the transport closes ⇒ onFinalClose auto-revokes its
    // mounts). Revoking a mount just drops the alias; the stub stays until its holder disposes it.
  }

  // ── native fetch: the stub pager door, the fetch lane, observability, egress ──

  async fetch(request: Request): Promise<Response> {
    // AN ORDERED WALK OVER PARTIAL FETCHES (the core/fetch-capabilities.ts convention: each door
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

  /** OBSERVABILITY, over the one door: incarnation (the hibernation tell) + the core fold + the
   *  mount/stub registries, reached as `itx.hostState()` over capnweb (there is no second HTTP
   *  transport). Read-only on purpose — reading it must never be the write that mints storage
   *  (a probe of a never-touched context stays a 404-less no-op; workerd auto-deletes empty DOs). */
  hostState(): Record<string, unknown> {
    const cs = this.#coreState();
    return {
      incarnation: this.#stream.currentIncarnation(),
      facetProcessors: this.#facetEntries().map((e) => e.slug),
      core: {
        paused: cs.paused,
        breaker: cs.breaker && {
          capacity: cs.breaker.capacity,
          refillPerSecond: cs.breaker.refillPerSecond,
          remaining: Math.floor(breakerRemaining(cs, Date.now())),
        },
      },
      subscriptionMounts: this.#activeSubscriptionMounts().map((r) => ({
        name: r.name,
        providedAtOffset: r.providedAtOffset,
        // The stamped lane, verbatim (with the live-state refinement of the connected lane).
        lane: r.lane === "connected" && r.liveState ? "connected-live-state" : r.lane,
      })),
      ...this.#rpcStubs.state(),
    };
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
    this.#rpcStubs.closed(ws, reason);
  }
  webSocketError(ws: WebSocket): void {
    if (this.#liveCapabilityFetch.handleWebSocketClose(ws, 1006, "transport error")) return;
    this.#rpcStubs.closed(ws, "transport error");
  }

  // ── the rpc-stub RPC verbs (the directory owns the lifecycle — see rpc-stub-directory.ts;
  // these are the relay-facing doors) ──

  /** Reserve a transport for `key` — the relay calls this, then opens the pager carrying the
   *  returned transportId. */
  rpcStubAttach(input: { key: string }): { transportId: string } {
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
