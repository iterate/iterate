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
// relays. Dispatch is ONE path: parse → route the table → substitute → evaluate → replay — all
// of it against the inline capability table; this class only delegates. The dotted
// `invokeCapability(callPath, args)` door remains as the degenerate string half of the codec
// (loaded workers + the stateful runner speak it).

import { DurableObject } from "cloudflare:workers";
import { substituteHeaderSecrets } from "@v3/shared/egress";
import {
  confinedWorker,
  facetLoaderOwner,
  resolveSource,
  versionedFacet,
  type WorkerSource,
} from "./core/agent-runtime.ts";
import { createLogger } from "./core/logs.ts";
import {
  breakerRemaining,
  CoreStreamProcessor,
  isCoreControl,
  type CoreState,
} from "./core-processor.ts";
import { codedError, errorCode, reportIssue } from "./core/errors.ts";
import { type DeliveryPolicy, type StreamEvent, type StreamEventInput } from "./core/events.ts";
import { parse, print, toExpression, type Expression } from "./core/expression.ts";
import { invokePath } from "./core/dispatch.ts";
import { InvokeHandle } from "./core/invoke-handle.ts";
import { StreamAlarmArmer, StreamEventLog } from "./core/event-log.ts";
import { hashSource } from "./core/hash.ts";
import { localContext } from "./core/stream.ts";
import { RpcStubDirectory } from "./rpc-stub-directory.ts";
import type { RetainedCallbackInvoker } from "./core/hibernatable-rpc-stub.ts";
import { DurableObjectNameCodec } from "./core/durable-object-names.ts";
import { itxEntrypointFor } from "./itx-entrypoint.ts";
import {
  CapabilityTableProcessor,
  type CapabilityTable,
  type ProcessorPolicy,
} from "./capability-table-processor.ts";
import {
  consumesEvent,
  LIVE_STATE_CHANGED,
  type ReduceOnlyProcessor,
  type ScannedOffsetRange,
} from "./core/processor.ts";
import type { BuiltInsEnv } from "./built-ins.ts";
import { PROCESSOR_RUNNER_MODULE } from "./generated/processor-runner.ts";
import { PROCESSOR_SDK_MODULE } from "./generated/processor-sdk.ts";
import { buildBuiltIns } from "./built-ins.ts";
import { BUILT_IN_PROCESSOR_SLUGS, type FacetIdentity } from "./processor-facet.ts";

// The parent hosts the INLINE CORE (host scope + routing table + core reduce), so it needs the
// full roots env the facet used to inherit.
type Env = BuiltInsEnv;

/** One enabled facet-hosted processor: a built-in slug, or — with `ref` — USERSPACE code (a
 *  source expression resolved to modules + which export is the StreamProcessor subclass). */
type FacetProcessorEntry = {
  slug: string;
  ref?: { source: Expression; className: string };
  /** Per-instance configuration from the enablement mount, handed to the constructor. */
  props?: Record<string, unknown>;
};

/** The duck-typed contract BOTH facet kinds satisfy (the built-in ProcessorFacet and the
 *  SDK-injected runner.js): identity in, pushed windows in, reduce + barrier out. */
type FacetProcessorHandle = {
  configure(identity: FacetIdentity): Promise<unknown> | unknown;
  processEventBatch(
    events: StreamEvent[],
    scannedOffsetRange: ScannedOffsetRange,
  ): Promise<unknown> | unknown;
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
  /** Present iff the target is a co-located facet (`facetTarget`) AND userspace code — the class
   *  that facet loads. A processor is a facet-target subscriber; this is its code. */
  processor?: ProcessorPolicy;
};

/** Match an RPC-STUB target: `itx.rpcStubs.get('<key>')`, optionally followed by a trailing dotted
 *  path (which callable on the retained callback receives the delivery — `apply()` walks the raw
 *  target expression for that). Only the `key` is needed here (routing + auto-revoke identity); a
 *  trailing CALL step means an ABSENT target — the forwarder's lane. */
const rpcStubTarget = (t?: Expression): { key: string } | undefined => {
  if (!t || t.length < 3 || t[0] !== "itx" || t[1] !== "rpcStubs") return undefined;
  const call = t[2];
  if (!Array.isArray(call) || call.length !== 2 || call[0] !== "get" || typeof call[1] !== "string")
    return undefined;
  // A trailing CALL step (non-string) names a method, not a delivery callable → an absent target.
  if (t.slice(3).some((step) => typeof step !== "string")) return undefined;
  return { key: call[1] };
};

/** Match a FACET target: `itx.facets.get('<slug>')` — a subscriber whose target is a co-located
 *  facet on THIS stream. These ARE the processors: the commit pump drives them (a reduce over the
 *  log). Because they are pump-driven, not delivered, BOTH the connected lane and the forwarder
 *  skip a facet-target mount. Target-shape dispatch, one namespace: a processor is just a
 *  subscription whose target is a facet. */
const facetTarget = (t?: Expression): { slug: string } | undefined => {
  if (!t || t.length !== 3 || t[0] !== "itx" || t[1] !== "facets") return undefined;
  const call = t[2];
  if (!Array.isArray(call) || call.length !== 2 || call[0] !== "get" || typeof call[1] !== "string")
    return undefined;
  return { slug: call[1] };
};

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
/** The core processor is stateless (pure reduce) — one module-level instance serves every DO. */
const CORE_PROCESSOR = new CoreStreamProcessor();
const streamLog = createLogger("stream-do");

export class StreamDurableObject extends DurableObject<Env> {
  /** WHO THIS DO IS — parsed ONCE from the unforgeable codec name; carries projectId, path
   *  AND its canonical string form (`.name`). A stream is only ever reached `getByName`; an
   *  id-addressed instance fails right here in the constructor, before it can touch anything. */
  readonly #address = parseStreamDurableObjectName(this.ctx.id.name);
  /** The live rpc-stub registry — the domain layer over the hibernatable RPC stubs (see
   *  rpc-stub-directory.ts). Live-only: presence via list(), no durable session history. */
  readonly #rpcStubs = new RpcStubDirectory({
    hooks: {
      acceptWebSocket: (ws, tags) => {
        this.ctx.acceptWebSocket(ws, tags);
        // Auto-"pong" the edge relay's 30s keepalive "ping" at the RUNTIME level — the message
        // never reaches a handler, so it keeps the pager socket warm (defeats the ~100s idle-close)
        // WITHOUT waking the DO, leaving hibernation intact. Reconnect still backs a hard drop.
        this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
      },
      getWebSockets: (tag) => this.ctx.getWebSockets(tag),
    },
    // AUTO-REVOKE: when the LAST transport for a key is gone, a mount naming it can never deliver
    // again — pop it. A transport SWAP (keyFinal false) leaves the mount serving the survivor.
    onFinalClose: async ({ key, keyFinal }) => {
      if (!keyFinal) return;
      const table = this.#inline(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
      for (const m of table.mounts)
        if (rpcStubTarget(m.target)?.key === key)
          await this.revokeCapability({ providedAtOffset: m.providedAtOffset }).catch((e) =>
            reportIssue("stream-do.auto-revoke", e, { providedAtOffset: m.providedAtOffset }),
          );
    },
  });
  readonly #alarmArmer = new StreamAlarmArmer(this.ctx.storage);
  /** THE COMMIT POINT — see StreamEventLog above. The name check already happened in the
   *  constructor (`#address`); the log itself is storage-lazy. */
  readonly #eventLog = new StreamEventLog(this.ctx.storage, this.#address.path);

  /** Commit events: idempotency-checked, offsets assigned from ONE shared sequence (ephemeral
   *  events consume offsets but never touch the log — their bodies exist only in this batch and
   *  in whatever pushes deliver them; after a reboot their offsets survive as valid gaps), then
   *  every enabled facet processor is PUSHED the batch with its scanned-offset-range proof. */
  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    // THE commit door every path funnels through (public stream/contexts/env.ITX + internal):
    // an event must carry a non-blank type. This runtime guard is now the SOLE enforcement (no
    // capnweb-validate boundary) — it covers both the missing/non-string case and the contract's
    // trim().min(1), so a "" or "   " type is rejected loudly instead of committing typeless.
    for (const input of inputs)
      if (typeof input.type !== "string" || input.type.trim() === "")
        throw new Error("append: every event needs a non-empty type");
    // THE CORE PROCESSOR SPEAKS FIRST (the apps/os shape): pause refuses every non-control
    // append; the token-bucket breaker meters durable growth. Control events always pass — a
    // paused or tripped stream must accept its own resume.
    const nonControl = inputs.filter((i) => !isCoreControl(i.type));
    if (nonControl.length > 0) {
      const core = this.#inline("core").state as CoreState;
      if (core.paused) throw codedError("STREAM_PAUSED", `stream paused: ${core.paused.reason}`);
      let counted = nonControl.filter((i) => !i.ephemeral).length;
      if (counted > 0 && breakerRemaining(core, Date.now()) < counted) {
        // Before refusing: a retry of an ALREADY-COMMITTED idempotencyKey will dedupe to zero
        // durable growth, and the breaker meters GROWTH — don't tax the reconciling retry (retry
        // storms are exactly when the bucket is tight). Re-count excluding sure dedupe hits; the
        // probe runs only on the about-to-trip path, so the common case pays no extra SELECT.
        counted = nonControl.filter(
          (i) =>
            !i.ephemeral &&
            !(i.idempotencyKey && this.#eventLog.hasIdempotencyKey(i.idempotencyKey)),
        ).length;
        if (counted > 0 && breakerRemaining(core, Date.now()) < counted)
          throw codedError(
            "STREAM_BREAKER_OPEN",
            `stream circuit breaker open — ${counted} durable event(s) exceed the bucket`,
          );
      }
    }
    // THE INLINE REDUCES run INSIDE the log's transaction: the routing table and the core
    // state are atomically exact as of the last committed event, always — the pump-races-the-
    // provide class is unspellable, not carefully avoided. (Reduce errors are caught per
    // event; a bad event skips, it never aborts the commit.)
    const { committed, distinct, scannedAfterOffset, nextOffset } = this.#eventLog.append(
      inputs,
      (justCommitted, after, next) => this.#reduceInlineAtCommit(justCommitted, after, next),
    );
    if (nextOffset > scannedAfterOffset) {
      // THE PUMP: push the batch + its scanned offset range into every facet processor (each an isolated
      // workerd facet with its own storage).
      // Fire-and-forget from append's view — an awaited drive would deadlock if a facet
      // processor APPENDS during its batch (append → this method → await the same facet's busy
      // chain), and the capability host DOES append (provide/revoke) — but SERIALIZED PER FACET:
      // without the chain, a slow loader materialization lets a later batch overtake an earlier
      // one, and the earlier range is then judged a stale redelivery and its EPHEMERAL events
      // (undeliverable by repair, by design) are silently dropped. Reads stay correct because
      // every snapshot/invoke gap-repairs from the log. The push is what wakes an aborted facet.
      // Live-state change events never ride a drive: the platform rule makes them unconsumable
      // by every reduce, so delivering them is pure RPC waste (the voice flood). A batch that is
      // ONLY live-state skips the drives; the next real drive's range then COVERS the skipped
      // span (per-facet lastDeliveredThrough) so the facet's contiguity fast path holds — to a
      // reduce, a skipped live-state offset is exactly an ephemeral hole, which ranges already
      // express. Without the widened range, the skip broke contiguity and gap repair silently
      // dropped deliverable named ephemerals between two live-state changes (proof-caught).
      const drivable = distinct.filter((e) => e.type !== "events.iterate.com/live-state/changed");
      if (drivable.length > 0)
        for (const { slug } of this.#facetEntries()) {
          this.#facetWorkInFlight++;
          const after = this.#driveDeliveredThrough.get(slug) ?? scannedAfterOffset;
          this.#driveDeliveredThrough.set(slug, nextOffset);
          const prev = this.#driveChains.get(slug) ?? Promise.resolve();
          this.#driveChains.set(
            slug,
            prev
              .then(() => this.#facet(slug))
              .then((f) =>
                f.processEventBatch(drivable, {
                  scannedAfterOffset: after,
                  scannedThroughOffset: nextOffset,
                }),
              )
              .catch((e) => reportIssue("stream-do.facet-drive", e, { slug }))
              .finally(() => {
                this.#facetWorkInFlight--;
                this.#noteActivity(); // a finished reduce earns a fresh quiet period
              }),
          );
        }
      // CONNECTED subscription mounts get the batch pushed one-directionally, right now, from
      // the commit path — a synchronous fire-and-forget WebSocket send, no RPC, no await.
      // (ABSENT targets ride the subscription-forwarder facet, which is one of the drives above.)
      this.#deliverToConnectedSubscriptions(distinct, scannedAfterOffset, nextOffset);
    }
    this.#noteActivity();
    return committed;
  }

  // Per-facet drive serialization + the in-flight count the quiesce alarm respects (aborting a
  // facet mid-REDUCE is exactly the stall the resurrection pass exists to heal — never cause it).
  readonly #driveChains = new Map<string, Promise<unknown>>();
  readonly #driveDeliveredThrough = new Map<string, number>(); // per-facet lastDeliveredThrough (skipped spans ride the next range)
  #facetWorkInFlight = 0;

  // ── THE INLINE CORE: reduce-only processors reduced synchronously at the commit point ──
  // The runner apparatus (chain, cursors, gap repair, resurrection) is the price of being AWAY
  // from the commit point; these reduces run AT it and pay none of it. Checkpoint = one versioned
  // kv value per slug, committed atomically with the batch; rebuild = replay the durable log
  // (version skew, eviction, first contact — all the same path). Inline reduces see DURABLE
  // events only, so the checkpoint always rebuilds bit-identically.
  readonly #inlineCache = new Map<
    string,
    { proc: ReduceOnlyProcessor<unknown>; state: unknown; throughOffset: number }
  >();
  #capabilityTableInstance?: CapabilityTableProcessor;

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
    });
    proc.resolveCurrent = (call, depth) => this.invoke(call, depth);
    this.#capabilityTableInstance = proc;
    return proc;
  }

  #inlineDefs(): { slug: string; proc: ReduceOnlyProcessor<unknown> }[] {
    return [
      { slug: "core", proc: CORE_PROCESSOR as ReduceOnlyProcessor<unknown> },
      {
        slug: CAPABILITY_TABLE_SLUG,
        proc: this.#capabilityTableProcessor() as ReduceOnlyProcessor<unknown>,
      },
    ];
  }

  /** Rehydrate (checkpoint, else initial) and catch up to the durable head — all synchronous. */
  #inline(slug: string): {
    proc: ReduceOnlyProcessor<unknown>;
    state: unknown;
    throughOffset: number;
  } {
    let entry = this.#inlineCache.get(slug);
    if (!entry) {
      const def = this.#inlineDefs().find((d) => d.slug === slug);
      if (!def) throw new Error(`no inline processor "${slug}"`);
      const cp = this.ctx.storage.kv.get(`inline:${slug}`) as
        | { reducerVersion: string; reducedThroughOffset: number; state: unknown }
        | undefined;
      entry =
        cp && cp.reducerVersion === def.proc.contract.version
          ? { proc: def.proc, state: cp.state, throughOffset: cp.reducedThroughOffset }
          : { proc: def.proc, state: def.proc.contract.initialState(), throughOffset: 0 };
      this.#inlineCache.set(slug, entry);
    }
    const head = this.#eventLog.highestAssignedOffset();
    while (entry.throughOffset < head) {
      const page = this.read(entry.throughOffset, 500);
      for (const e of page.events) if (e.offset <= head) this.#reduceInline(entry, e);
      entry.throughOffset = Math.min(page.scannedThroughOffset, head);
      if (page.events.length < 500) break;
    }
    return entry;
  }

  #reduceInline(
    entry: { proc: ReduceOnlyProcessor<unknown>; state: unknown },
    e: StreamEvent,
  ): void {
    if (!consumesEvent(entry.proc.contract.consumes, e)) return;
    try {
      entry.state = entry.proc.reduce({ event: e, state: entry.state }) ?? entry.state;
    } catch (err) {
      reportIssue("stream-do.inline-reduce", err, {
        slug: entry.proc.contract.slug,
        offset: e.offset,
      });
    }
  }

  /** Called INSIDE append's transaction: reduce every fresh durable event through each inline
   *  processor, checkpoint on change. */
  #reduceInlineAtCommit(
    committed: StreamEvent[],
    scannedAfterOffset: number,
    nextOffset: number,
  ): void {
    for (const def of this.#inlineDefs()) {
      const entry = this.#inline(def.slug); // caught up to the PRE-batch head (cache is old)
      const before = entry.state;
      for (const e of committed) {
        if (e.offset <= scannedAfterOffset || e.ephemeral) continue;
        this.#reduceInline(entry, e);
      }
      entry.throughOffset = nextOffset;
      if (entry.state !== before)
        this.ctx.storage.kv.put(`inline:${def.slug}`, {
          reducerVersion: def.proc.contract.version,
          reducedThroughOffset: nextOffset,
          state: entry.state,
        });
    }
  }

  read(afterOffset = 0, limit = 500): { events: StreamEvent[]; scannedThroughOffset: number } {
    return this.#eventLog.read(afterOffset, limit);
  }

  // ── the #6800 quiesce: idle facets un-pinned so this actor can hibernate ──

  #lastActivityMs = 0;
  #noteActivity(): void {
    this.#lastActivityMs = Date.now();
    this.#alarmArmer.armNoLaterThan(this.#lastActivityMs + 60_000);
  }
  // In-memory on purpose: a fresh incarnation always runs one resurrection pass, and losing
  // the flag with an eviction is exactly the point.
  #facetsResurrected = false;

  async alarm(): Promise<void> {
    this.#alarmArmer.markFired();
    // Facets have no alarms (workerd#6810) — the parent proxies. The subscription-forwarder's
    // due retries pump here; it re-arms itself through armSubscriptionRetry when work remains.
    if (this.#facetEntries().some((e) => e.slug === SUBSCRIPTION_FORWARDER_SLUG))
      void this.#facet(SUBSCRIPTION_FORWARDER_SLUG)
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
      // pass exists to heal.
      for (const { slug } of this.#facetEntries()) {
        try {
          this.ctx.facets.abort(`proc:${slug}`, "idle quiesce");
        } catch {
          /* facet not running — already quiesced */
        }
      }
      for (const facetName of this.#statefulFacetNames) {
        try {
          this.ctx.facets.abort(facetName, "idle quiesce");
        } catch {
          /* facet not running — already quiesced */
        }
      }
      this.#statefulFacetNames.clear();
      // Same doctrine for the paged-in RetainedCallbackInvoker stubs: retaining one pins this
      // actor awake, and a page always gets it back — dispose them with the idle facets.
      this.#rpcStubs.disposeRetainedStubs();
    } else {
      this.#alarmArmer.armNoLaterThan(this.#lastActivityMs + 60_000);
    }
  }

  // ── SUBSCRIPTION DELIVERY, connected lane: one-directional, from the commit path ──
  // A CONNECTED subscription mount (target itx.rpcStubs.get(…)) is served by raw
  // fire-and-forget invokes on the connection's paged-in stub: the filtered batch plus the
  // GLOBAL ScannedOffsetRange. No acks, no server cursor, no retry ladder, no watchdogs, no
  // outbound coalescing (owner decision — the socket buffer is the only queue; overflow closes
  // the socket and the close IS the heal signal). The CLIENT owns its offset: delivered ranges
  // chain (each scannedAfterOffset === the last scannedThroughOffset), so a gap is one
  // comparison and heals with read(afterOffset). ABSENT targets are the subscription-forwarder
  // facet's lane (cursor + the one bounded-retry-then-halt policy) — see
  // subscription-forwarder-processor.ts.

  /** DERIVED from the capability table (the one reduce): subscriber mounts ARE the rows. */
  #subscriptionMounts(): SubscriptionMount[] {
    const state = this.#inline(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
    const rows: SubscriptionMount[] = [];
    for (const m of state.mounts) {
      if (m.path.length === 3 && m.path[0] === "itx" && m.path[1] === "subscribers")
        rows.push({
          name: m.path[2],
          providedAtOffset: m.providedAtOffset,
          ...((m.delivery ?? {}) as DeliveryPolicy),
          target: m.target,
          ...(m.processor ? { processor: m.processor as ProcessorPolicy } : {}),
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
   *  whole batches receive the skipped span inside its next delivered ScannedOffsetRange (so the
   *  client's contiguity check holds without empty-batch sends). Losing it (eviction) just makes
   *  one delivered range start late — the client sees a gap once and pulls once. */
  readonly #subscriptionDeliveredThrough = new Map<number, number>();

  #deliverToConnectedSubscriptions(
    committed: StreamEvent[],
    scannedAfterOffset: number,
    nextOffset: number,
  ): void {
    const state = this.#inline(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
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
      if (!rpcStubTarget(row.target)) continue; // absent target — the forwarder facet's lane
      if (row.liveState) {
        // State mode: forward each committed change payload for the watched key, raw (no
        // in-flight tracking, no latest-wins queue — the owner's no-coalescing decision; a
        // dropped or reordered payload is a revision-chain mismatch the client door-heals).
        for (const e of committed) {
          if (e.type !== LIVE_STATE_CHANGED) continue;
          if ((e.payload as { key?: string } | undefined)?.key !== row.liveState.key) continue;
          fire(row, [e.payload], (err) =>
            console.error(`live-state "${row.name}" delivery failed (client re-seeds on gap)`, err),
          );
        }
        continue;
      }
      // Event mode: the consumes filter, applied statelessly outbound. Default = every durable
      // event; naming types opts into ephemerals too (the processor consumes rule, mirrored).
      // LIVE_STATE_CHANGED never rides the event lane (the platform rule).
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
            scannedAfterOffset: Math.min(deliveredAfter, scannedAfterOffset),
            scannedThroughOffset: nextOffset,
          } satisfies ScannedOffsetRange,
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
    const state = this.#inline(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
    return this.#capabilityTableProcessor().deliverTo(state, input.providedAtOffset, input.args);
  }

  /** The alarm proxy (facets have no alarms — workerd#6810): the forwarder reports its earliest
   *  nextAttemptAtMs and the parent's alarm pumps it when due. */
  armSubscriptionRetry(input: { atMs: number }): { ok: true } {
    this.#alarmArmer.armNoLaterThan(input.atMs);
    return { ok: true };
  }

  /** Recovery from a forwarder HALT (or an operator cursor seek) — proxied to the facet, which
   *  owns every absent-target cursor. Connected targets have no server cursor to move. */
  async resumeSubscription(input: { name: string; afterOffset?: number }): Promise<{ ok: true }> {
    const row = this.#activeSubscriptionMounts().find((r) => r.name === input.name);
    if (!row) throw new Error(`no subscription "${input.name}"`);
    if (rpcStubTarget(row.target))
      throw new Error(
        `"${input.name}" delivers one-directionally to a connected client — there is no server cursor; the client heals itself with read(afterOffset)`,
      );
    if (!this.#facetEntries().some((e) => e.slug === SUBSCRIPTION_FORWARDER_SLUG))
      throw new Error("no subscription-forwarder enabled (nothing to resume)");
    // Recovery RIDES THE LOG: a durable subscription-resumed fact, consumed by the forwarder
    // like any other event (auditable, ordered by the drive chain — no side-channel verb). A
    // beyond-head afterOffset is CLAMPED to the head so an operator fat-finger can't park the
    // cursor past reality and wedge the row forever.
    const head = this.#eventLog.highestAssignedOffset();
    await this.append({
      type: "events.iterate.com/stream/subscription-resumed",
      payload: {
        name: input.name,
        ...(input.afterOffset !== undefined
          ? { afterOffset: Math.min(input.afterOffset, head) }
          : {}),
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
      if (!facetTarget(row.target)) continue; // a connected/absent subscriber, not a facet reduce
      const policy = (row.processor ?? {}) as ProcessorPolicy;
      entries.push({
        slug: row.name,
        ...(policy.source
          ? { ref: { source: parse(policy.source), className: policy.className ?? "default" } }
          : {}),
        ...(policy.props ? { props: policy.props } : {}),
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
    let handle: FacetProcessorHandle;
    if (!entry.ref) {
      const exports = (this.ctx as unknown as { exports: Record<string, unknown> }).exports;
      handle = this.ctx.facets.get(`proc:${slug}`, () => ({
        class: exports.ProcessorFacet as DurableObjectClass,
      })) as unknown as FacetProcessorHandle;
    } else {
      handle = (await this.#durableFacet({
        source: entry.ref.source,
        role: "processor",
        discriminator: slug,
        loadedClassName: "ProcessorFacetRunner",
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
      ...(entry.ref?.className ? { className: entry.ref.className } : {}),
      ...(entry.props ? { props: entry.props } : {}),
    });
    return handle;
  }

  /** Load a class as a FACET of this stream — the ONE loader for both roles: a userspace
   *  `StreamProcessor` (role "processor", behind the `runner.js` adapter + SDK, commit-driven) and
   *  a raw stateful `DurableObject` class (role "stateful", loaded directly and called). Shared:
   *  `resolveSource` → contentHash → `confinedWorker` (kind "facet") → `versionedFacet`; the SDK
   *  (`processor.js`) rides BOTH roles (every userspace load may `import "./processor.js"`), so the
   *  two roles differ ONLY in whether the `runner.js` adapter (and its mainModule) rides. The loader
   *  `owner` is composed collision-free (`facetLoaderOwner`). */
  async #durableFacet(opts: {
    source: WorkerSource;
    role: "processor" | "stateful";
    /** The owner's second half — a processor slug or a stateful className. */
    discriminator: string;
    /** The class `confinedWorker`/`versionedFacet` instantiate (the runner for a processor). */
    loadedClassName: string;
    facetName: string;
    markerKey: string;
    what: string;
  }): Promise<unknown> {
    const userModules = await resolveSource((e) => this.invoke(e), opts.source, opts.what);
    const version = hashSource(JSON.stringify(userModules));
    const worker = confinedWorker(
      this.env,
      {
        kind: "facet",
        owner: facetLoaderOwner(this.#address.name, opts.discriminator),
        contentHash: version,
      },
      opts.role === "processor" ? "runner.js" : "cap.js",
      opts.role === "processor"
        ? {
            ...userModules,
            "processor.js": PROCESSOR_SDK_MODULE,
            "runner.js": PROCESSOR_RUNNER_MODULE,
          }
        : { ...userModules, "processor.js": PROCESSOR_SDK_MODULE },
      itxEntrypointFor(this.ctx, this.#address.name),
    );
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
   *  SUGAR, deliberately: enabling a processor is just LOADING A CLASS AS A FACET (the exact
   *  `{ source, className }` ref `itx.workers.get` takes — `source` an expression resolved to
   *  modules, `className` the exported StreamProcessor subclass) PLUS one appended fact — a
   *  SUBSCRIPTION mount `itx.subscribers.<slug> → itx.facets.get('<slug>')`. A processor is just a
   *  subscription whose target is a co-located facet: the commit pump drives every facet-target
   *  subscriber. The only difference from a stateful `facets.get({ source, className })`: a
   *  processor's class extends `StreamProcessor` (loaded behind the `runner.js` adapter, so the
   *  author writes a reduce, never a DurableObject). So `enableProcessor` == subscribe a facet;
   *  there is no separate `itx.processors.*` namespace and no second "enablement" concept. */
  async enableProcessor(
    slug: string,
    ref?: { source: string | Expression; className: string },
    props?: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    this.#eventLog.touch();
    if (slug === CAPABILITY_TABLE_SLUG || slug === "core")
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
      processor: {
        ...(ref ? { source: print(toExpression(ref.source)), className: ref.className } : {}),
        ...(props ? { props } : {}),
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
    if (slug === CAPABILITY_TABLE_SLUG || slug === "core")
      throw new Error(`"${slug}" is an inline core processor — it cannot be disabled`);
    this.#driveChains.delete(slug);
    this.#driveDeliveredThrough.delete(slug); // a re-enable must not inherit a scanned range it never saw
    await this.revokeCapability({ path: `itx.subscribers.${slug}` });
    const facets = this.ctx.facets as unknown as { delete?: (name: string) => void };
    if (typeof facets.delete === "function") facets.delete(`proc:${slug}`);
    else this.ctx.facets.abort(`proc:${slug}`, "disabled");
    return { ok: true };
  }

  /** THE generic facet door: resolve the facet LOCALLY (facet stubs are non-transferable — the
   *  walk happens where the stub lives), walk the dotted path with the exposure guard, apply
   *  the terminal. `roots.facets` (and via one seed, `itx.facets`) rides this to reach ANY
   *  method a facet's durable object exposes — a facet hosts an object; processor is a role. */
  async facetInvoke(
    ref: string | { source: unknown; className: string },
    path: string[],
    args: unknown[],
  ): Promise<unknown> {
    this.#noteActivity(); // (was in #facet — moved out so the resurrection pass stays idle-neutral)
    if (path.length === 0) throw new Error(`facet: name a method`);
    // A loaded STATEFUL class hosted as a facet: materialize (or reuse) it, then call — a method
    // walks receiver-preservingly (invokePath), a top-level `.fetch` forwards to the facet's own
    // fetch (a 101 flows DO→facet natively). This is the mirror of a stateless workers.get(ref).
    if (typeof ref !== "string") {
      const facet = await this.#statefulFacet({
        source: toExpression(ref.source as string | Expression),
        className: ref.className,
      });
      if (path.length === 1 && path[0] === "fetch")
        return (facet as Fetcher).fetch(args[0] as Request);
      return invokePath(facet, path, args, `worker "${ref.className}"`);
    }
    const slug = ref;
    // INLINE processors answer at the same address — always at head, so the barrier verb is
    // trivially satisfied and snapshot needs no catch-up.
    if (slug === CAPABILITY_TABLE_SLUG || slug === "core") {
      const entry = this.#inline(slug);
      const view = {
        snapshot: () => ({ offset: entry.throughOffset, state: entry.state }),
        waitUntilProcessed: () => ({ ok: true }),
      };
      return invokePath(view, path, args, `inline "${slug}"`);
    }
    if (!this.#facetEntries().some((e) => e.slug === slug))
      throw codedError("NO_FACET", `no facet "${slug}" enabled`);
    // invokePath = stepGet + Reflect.apply with the receiver carried (the DataCloneError
    // learning lives on the helper — see core/expression.ts).
    return invokePath(await this.#facet(slug), path, args, `facet "${slug}"`);
  }

  // ── stateful loaded classes: FACETS of this stream (the dedicated runner DO died in 57) ──

  /** Names of stateful facets materialized THIS incarnation — the quiesce alarm aborts them
   *  beside the idle processor facets (an IDLE stateful facet must never pin the stream; a
   *  BUSY one does — the accepted trade of hosting them here). In memory on purpose: facets
   *  die with the incarnation, and a fresh call re-materializes from durable facet storage. */
  readonly #statefulFacetNames = new Set<string>();

  /** Materialize (or reuse) the facet hosting a loaded `className`. Same confinedWorker +
   *  versionedFacet as userspace processors; facet identity keys on the SOURCE EXPRESSION
   *  (stable name), while versionedFacet restarts it when the resolved CONTENT changes. */
  async #statefulFacet(ref: { source: Expression; className: string }): Promise<unknown> {
    this.#noteActivity();
    const facetName = `stateful:${ref.className}:${hashSource(JSON.stringify(ref.source))}`;
    this.#statefulFacetNames.add(facetName);
    return this.#durableFacet({
      source: ref.source,
      role: "stateful",
      discriminator: ref.className,
      loadedClassName: ref.className,
      facetName,
      markerKey: `${facetName}:version`,
      what: `stateful worker "${ref.className}"`,
    });
  }

  // ── dispatch (ONE path: the routing table — the INLINE core reduce, zero distance) ──

  /** Resolve + run one call (either codec half) against the current table. */
  async invoke(call: string | Expression, depth = 0): Promise<unknown> {
    this.#noteActivity();
    const state = this.#inline(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
    return this.#capabilityTableProcessor().resolve(state, toExpression(call), undefined, depth);
  }

  /** The dotted door — the degenerate string half. Loaded workers' `itx.js` + the runner speak
   *  this (`itx.a.b(args)` ⇒ ["itx","a",["b",...args]]). */
  invokeCapability(callPath: string, args: unknown[] = []): Promise<unknown> {
    const segments = callPath.split(".");
    const last = segments.at(-1)!;
    return this.invoke([...segments.slice(0, -1), [last, ...args]] as Expression);
  }

  /** Mount a userspace capability (its target recurses through itx; built-ins resolve directly). A
   *  subscription mount with an ABSENT target auto-enables the subscription-forwarder facet
   *  FIRST, so the mount's own commit already drives the forwarder. liveState demands a
   *  CONNECTED target: an absent target holds no revision chain, so a dropped payload could
   *  never be noticed — reject at the door, not at delivery time. */
  async provideCapability(input: {
    path: string | string[];
    target: string | Expression;
    delivery?: DeliveryPolicy;
    processor?: ProcessorPolicy;
  }): Promise<{ providedAtOffset: number }> {
    this.#eventLog.touch();
    const pathString = typeof input.path === "string" ? input.path : input.path.join(".");
    // ABSENT = an itx.subscribers.* mount that is neither CONNECTED (client lane) nor a FACET
    // (the pump's lane — a processor). Only an absent target needs the forwarder.
    const targetExpr = toExpression(input.target);
    if (
      pathString.startsWith("itx.subscribers.") &&
      !rpcStubTarget(targetExpr) &&
      !facetTarget(targetExpr)
    ) {
      if (input.delivery?.liveState)
        throw new Error(
          "a live-state subscription needs a live rpc-stub target (itx.rpcStubs.get(…)) — an absent target has no revision chain to keep",
        );
      if (!this.#facetEntries().some((e) => e.slug === SUBSCRIPTION_FORWARDER_SLUG))
        await this.enableProcessor(SUBSCRIPTION_FORWARDER_SLUG);
    }
    return this.#capabilityTableProcessor().provide(input);
  }

  /** Revoke by the mount's identity — or by its capability path (pops the newest winner at
   *  that exact path; what it shadowed is restored). */
  async revokeCapability(input: {
    providedAtOffset?: number;
    path?: string | string[];
  }): Promise<void> {
    let providedAtOffset = input.providedAtOffset;
    if (providedAtOffset === undefined) {
      if (!input.path) throw new Error("revokeCapability: pass providedAtOffset or path");
      const pathString = typeof input.path === "string" ? input.path : input.path.join(".");
      const table = this.#inline(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
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
    const url = new URL(request.url);

    // A relay opens an ItxConnection's stub pager WebSocket (partial fetch — the directory
    // owns the attach gate; undefined means "not this door's request").
    const pagerResponse = this.#rpcStubs.fetch(request);
    if (pagerResponse) return pagerResponse;

    // THE FETCH LANE: `x-itx-cap` resolves against the inline reduce right here — a 101 flows
    // back out natively (no facet tunnel needed at all).
    const capHeader = request.headers.get("x-itx-cap");
    if (capHeader) {
      try {
        const expr = capHeader.trimStart().startsWith("[")
          ? (JSON.parse(capHeader) as Expression)
          : parse(capHeader.startsWith("itx") ? capHeader : `itx.${capHeader}`);
        const state = this.#inline(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
        const result = await this.#capabilityTableProcessor().resolveFetch(state, expr, request);
        if (result instanceof Response) return result;
        return new Response(`fetch lane: ${JSON.stringify(result)}\n`);
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        // Classification by CODE, never message text — the code survives every hop.
        const status = errorCode(error) === "NO_CAPABILITY_MATCH" ? 404 : 500;
        return new Response(`fetch lane error: ${message}\n`, { status });
      }
    }

    // Observability: incarnation (the hibernation tell) + the connection registry's live state.
    // Read-only on purpose — probing /state must never be the write that mints storage.
    if (url.pathname === "/state")
      return Response.json({
        incarnation: this.#eventLog.currentIncarnation(),
        facetProcessors: this.#facetEntries().map((e) => e.slug),
        core: (() => {
          const cs = this.#inline("core").state as CoreState;
          return {
            paused: cs.paused,
            breaker: cs.breaker && {
              capacity: cs.breaker.capacity,
              refillPerSecond: cs.breaker.refillPerSecond,
              remaining: Math.floor(breakerRemaining(cs, Date.now())),
            },
          };
        })(),
        subscriptionMounts: this.#activeSubscriptionMounts().map((r) => ({
          name: r.name,
          providedAtOffset: r.providedAtOffset,
          lane: rpcStubTarget(r.target)
            ? r.liveState
              ? "connected-live-state"
              : "connected"
            : "forwarder",
        })),
        ...this.#rpcStubs.state(),
      });

    // EGRESS: substitute `{{secret:NAME}}` placeholders, then the FALLBACK terminal.
    const sub = await substituteHeaderSecrets(request, "project", (name) =>
      this.env.SECRETS_KV
        ? this.env.SECRETS_KV.get(`secret:${this.#address.projectId}:${name}`)
        : null,
    );
    return this.env.FALLBACK.fetch(sub);
  }

  webSocketMessage(): void {
    // A stub pager WebSocket is DO→relay only — inbound payloads carry nothing we act on.
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.#rpcStubs.closed(ws, code, reason);
  }
  webSocketError(ws: WebSocket): void {
    this.#rpcStubs.closed(ws, 1006, "transport error");
  }

  // ── the rpc-stub RPC verbs (the directory owns the lifecycle — see rpc-stub-directory.ts;
  // these are the relay-facing doors) ──

  /** Reserve a transport for `key` — the relay calls this, then opens the pager carrying the
   *  returned transportId. */
  rpcStubAttach(input: { key: string; description?: string }): { transportId: string } {
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
