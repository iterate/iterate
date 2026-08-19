// stream-durable-object.ts — THE STREAM: one DO per `{projectId, path}` (codec-named
// `{projectId}.iterate{path}`). The stream is the parent — LOG + SOCKETS + DOORS only; the
// CAPABILITY TABLE (capability-table-processor.ts) is an inline reduce-only processor at its
// PROCESSOR on it (processor-facet.ts), one among many:
//
//   • the EVENT LOG — SQLite append/read, monotonic offsets, idempotency at the commit point;
//   • the PROCESSORS — every enabled one a workerd FACET driven after each commit (built-ins by
//     slug, userspace classes via the Worker Loader); the capability host (whose reduced state
//     is the routing table) is the built-in first member, lazily enabled on first use;
//   • the TRANSPORT — every hibernatable socket: each attached ItxConnection is a delivery
//     WebSocket from the stateless relay (core/itx-connection-registry.ts), so ANY number of
//     connected clients leave this DO free to hibernate. OUT is one-directional fire-and-forget
//     delivery (event batches + state changes); IN borrows a short RetainedCallbackInvoker leg
//     per wake burst. Connection identity = connectedAtOffset (the offset of the ephemeral
//     connection-opened fact); the SESSION RULE files durable ItxConnectionSession history;
//   • the FETCH DOOR — the one place a 101 can enter: `x-itx-delivery-websocket` accepts a
//     delivery WebSocket, `x-itx-cap` resolves the fetch lane, anything else is EGRESS (secret
//     placeholder substitution → the FALLBACK terminal).
//
// PURE WORKERS-RPC: capnweb never terminates here (hard rule) — the stateless `/api` worker
// relays. Dispatch is ONE path: parse → route the table → substitute → evaluate → replay — all
// of it against the inline capability table; this class only delegates. The dotted
// `invokeCapability(callPath, args)` door remains as the degenerate string half of the codec
// (loaded workers + the stateful runner speak it).

import { DurableObject } from "cloudflare:workers";
import { substituteHeaderSecrets } from "@v3/shared/egress";
import { confinedWorker, versionedFacet } from "./core/agent-runtime.ts";
import { parseAppConfig } from "./core/config.ts";
import {
  breakerRemaining,
  CoreStreamProcessor,
  isCoreControl,
  type CoreState,
} from "./core-processor.ts";
import { codedError, errorCode } from "./core/errors.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type DeliveryPolicy,
  type StreamEvent,
  type StreamEventInput,
} from "./core/events.ts";
import {
  invokePath,
  parse,
  pathProxy,
  print,
  toExpression,
  type Expression,
} from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";
import {
  HibernatableRpcStubManager,
  STUB_PAGER_WEBSOCKET_HEADER,
  type HibernatableRpcStubRecord,
  type RetainedCallbackInvoker,
} from "./core/hibernatable-rpc-stub.ts";
import { parseName, stringifyName } from "./core/names.ts";
import { itxEntrypointFor } from "./itx-entrypoint.ts";
import {
  CapabilityTableProcessor,
  type CapabilityTable,
  type ProcessorPolicy,
} from "./capability-table-processor.ts";
import {
  LIVE_STATE_CHANGED,
  type ReduceOnlyProcessor,
  type ScannedOffsetRange,
} from "./core/processor.ts";
import type { BuiltInsEnv } from "./built-ins.ts";
import { PROCESSOR_RUNNER_MODULE } from "./generated/processor-runner.ts";
import { PROCESSOR_SDK_MODULE } from "./generated/processor-sdk.ts";
import { buildBuiltIns } from "./built-ins.ts";
import type { FacetIdentity } from "./processor-facet.ts";

// The parent hosts the INLINE CORE (host scope + routing table + core reduce), so it needs the
// full roots env the facet used to inherit, plus the config seeds.
interface Env extends BuiltInsEnv {
  APP_CONFIG?: string;
}

/** One enabled facet-hosted processor: a built-in slug, or — with `ref` — USERSPACE code (a
 *  source expression resolved to modules + which export is the StreamProcessor subclass). */
type FacetProcessorEntry = {
  slug: string;
  ref?: { source: Expression; export: string };
  /** Per-instance configuration from the enablement mount, handed to the constructor. */
  props?: Record<string, unknown>;
};

/** The duck-typed contract BOTH facet kinds satisfy (the built-in ProcessorFacet and the
 *  SDK-injected runner.js): identity in, pushed windows in, reduce + barrier out. */
type FacetProcessorHandle = {
  configure(identity: FacetIdentity): Promise<unknown> | unknown;
  processEventBatch(events: StreamEvent[], window: ScannedOffsetRange): Promise<unknown> | unknown;
  snapshot(): Promise<{ offset: number; state: unknown }>;
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<unknown>;
};

/** ONE DERIVED subscription-mount row — a PROJECTION of the capability-provided/-revoked events
 *  at capability path `itx.subscribers.<name>` (subscription config is EVENT-SOURCED; this index
 *  exists only because the post-commit fan-out is the hot path and must not RPC anywhere to
 *  learn who to notify). CONNECTED targets are served right here (fire-and-forget batches down
 *  the delivery WebSocket); ABSENT targets are served by the subscription-forwarder facet, which
 *  keeps its own projection of the same events. */
type SubscriptionMount = DeliveryPolicy & {
  name: string;
  providedAtOffset: number; // the row's identity
  target?: Expression;
};

/** Match a CONNECTED target: `itx.connections.get('<key>')` plus an optional trailing dotted
 *  path (which callable on the retained callback receives the delivery; `[]` = the callback IS
 *  the function). Anything else is an ABSENT target — the forwarder's lane. */
const connectedTarget = (t?: Expression): { key: string; path: string[] } | undefined => {
  if (!t || t.length < 3 || t[0] !== "itx" || t[1] !== "connections") return undefined;
  const call = t[2];
  if (!Array.isArray(call) || call.length !== 2 || call[0] !== "get" || typeof call[1] !== "string")
    return undefined;
  const path: string[] = [];
  for (const step of t.slice(3)) {
    if (typeof step !== "string") return undefined;
    path.push(step);
  }
  return { key: call[1], path };
};

/** The ItxConnectionSession record for one connectionKey (kv `connection-session:<key>`) — the
 *  session rule's working memory. The durable truth is the connection-session-started/-ended
 *  facts on the stream; this record only carries what deciding the rule needs. */
type ItxConnectionSessionRecord = { sessionStartedAtOffset: number; lastActiveMs: number };
/** The session rule's T: two capnweb WebSockets under one connectionKey belong to the same
 *  ItxConnectionSession unless separated by a clean end or ≥ this much absence. */
const ITX_CONNECTION_SESSION_ABSENCE_MS = 15 * 60_000;
/** The subscription-forwarder facet's slug (auto-enabled when an absent-target subscription
 *  mount first appears). */
const SUBSCRIPTION_FORWARDER_SLUG = "subscription-forwarder";

/** The capability host's slug — hosted INLINE (see the inline-core section below). */
const CAPABILITY_TABLE_SLUG = "capability-table";
/** The core processor is stateless (pure reduce) — one module-level instance serves every DO. */
const CORE_PROCESSOR = new CoreStreamProcessor();

export class StreamDurableObject extends DurableObject<Env> {
  // ── transport: every ItxConnection is a HIBERNATABLE RPC STUB (keyed by connectionId) ──
  #hibernatableRpcStubs = new HibernatableRpcStubManager({
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
  });
  /** Records handed to `attachItxConnection`, waiting for their stub pager WebSocket to arrive
   *  (the two-phase attach: RPC first — it mints connectedAtOffset — then the upgrade). In
   *  memory on purpose: if the DO dies in between, the upgrade 409s and the relay re-attaches. */
  #pendingConnectionRecords = new Map<string, Record<string, unknown>>();
  incarnation = 0; // durable, bumped once per incarnation that WRITES — growth across idle ⇒ it hibernated
  #storageReady = false;

  // The constructor deliberately touches NO storage: a DO that never writes must never mint
  // backing storage (workerd auto-deletes empty objects, and a probed /state or typo'd ctx must
  // leave nothing behind — the Kenton PR #6101 doctrine). All writes funnel through #touch().

  /** First write of this incarnation: name-check BEFORE anything persists, then the events
   *  table + one incarnation bump (the hibernation tell — workless incarnations no longer
   *  count, which is the point). Synchronous (the kv API), so append needs no boot barrier. */
  #touch(): void {
    if (this.#storageReady) return;
    void this.#doName; // an id-addressed instance must fail before its first write
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
         offset INTEGER PRIMARY KEY,
         body TEXT NOT NULL,
         idempotency_key TEXT UNIQUE
       )`,
    );
    this.incarnation = ((this.ctx.storage.kv.get("incarnation") as number | undefined) ?? 0) + 1;
    this.ctx.storage.kv.put("incarnation", this.incarnation);
    this.#storageReady = true;
  }

  /** This DO's codec name. A stream is only ever reached `getByName` — an id-addressed instance
   *  has no identity and must fail before it writes anything. */
  get #doName(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("StreamDurableObject requires a named id (reach it via getByName)");
    return name;
  }

  /** The context this DO is — parsed from its unforgeable codec name. */
  get #name(): { projectId: string; path: string } {
    return parseName(this.#doName);
  }

  // ── the event log (the commit point) ──

  /** The highest offset EVER ASSIGNED — including to ephemeral events whose bodies are gone.
   *  Backed by ONE tiny kv value (the deliberate write that makes a pure-ephemeral append cost
   *  exactly one storage write): offset REUSE after an incarnation dies is a data-corruption
   *  class, because consumers key durable truth by offset. The kv value is the ONE source —
   *  append's transactionSync commits it with the sql rows atomically. */
  #highestAssignedOffsetCache?: number;
  #highestAssignedOffset(): number {
    this.#highestAssignedOffsetCache ??=
      (this.ctx.storage.kv.get("maxAssignedOffset") as number) ?? 0;
    return this.#highestAssignedOffsetCache;
  }

  #eventsTableExists(): boolean {
    return (
      this.#storageReady ||
      this.ctx.storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'")
        .toArray().length > 0
    );
  }

  /** Commit events: idempotency-checked, offsets assigned from ONE shared sequence (ephemeral
   *  events consume offsets but never touch the log — their bodies exist only in this batch and
   *  in whatever pushes deliver them; after a reboot their offsets survive as valid gaps), then
   *  every enabled facet processor is PUSHED the batch with its scan-window proof. */
  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    this.#touch();
    // THE CORE PROCESSOR SPEAKS FIRST (the apps/os shape): pause refuses every non-control
    // append; the token-bucket breaker meters durable growth. Control events always pass — a
    // paused or tripped stream must accept its own resume.
    const nonControl = inputs.filter((i) => !isCoreControl(i.type));
    if (nonControl.length > 0) {
      const core = this.#inline("core").state as CoreState;
      if (core.paused) throw codedError("STREAM_PAUSED", `stream paused: ${core.paused.reason}`);
      const counted = nonControl.filter((i) => !i.ephemeral).length;
      if (counted > 0 && breakerRemaining(core, Date.now()) < counted)
        throw codedError(
          "STREAM_BREAKER_OPEN",
          `stream circuit breaker open — ${counted} durable event(s) exceed the bucket`,
        );
    }
    // The mutation is ATOMIC (transactionSync rolls back sql AND kv together): a mid-batch throw
    // — an idempotency conflict after earlier inserts — must never leave rows above the recorded
    // max offset, which the next append would re-assign (one offset, two identities). The cache
    // is assigned only AFTER the transaction returns; a throw leaves it untouched and true.
    const scannedAfterOffset = this.#highestAssignedOffset();
    const { committed, nextOffset } = this.ctx.storage.transactionSync(() => {
      const committed: StreamEvent[] = [];
      let nextOffset = scannedAfterOffset;
      for (const input of inputs) {
        if (input.ephemeral && input.idempotencyKey)
          throw new Error(
            "ephemeral events cannot carry an idempotencyKey — nothing idempotent about the unreplayable",
          );
        if (input.idempotencyKey) {
          const hit = this.ctx.storage.sql
            .exec("SELECT offset, body FROM events WHERE idempotency_key = ?", input.idempotencyKey)
            .toArray()[0];
          if (hit) {
            const existing = JSON.parse(String(hit.body)) as StreamEventInput;
            if (sameIdempotentEvent(existing, input)) {
              committed.push({
                ...existing,
                offset: Number(hit.offset),
                path: this.#name.path,
              } as StreamEvent);
              continue; // a dedupe hit consumes NO offset
            }
            throw codedError(
              "IDEMPOTENCY_CONFLICT",
              idempotencyConflictMessage(input.idempotencyKey, Number(hit.offset)),
              { existingOffset: Number(hit.offset) },
            );
          }
        }
        nextOffset += 1;
        const body = { ...input, createdAt: new Date().toISOString() };
        if (!input.ephemeral) {
          this.ctx.storage.sql.exec(
            "INSERT INTO events (offset, body, idempotency_key) VALUES (?, ?, ?)",
            nextOffset,
            JSON.stringify(body),
            input.idempotencyKey ?? null,
          );
        }
        committed.push({ ...body, offset: nextOffset, path: this.#name.path } as StreamEvent);
      }
      if (nextOffset > scannedAfterOffset) {
        this.ctx.storage.kv.put("maxAssignedOffset", nextOffset); // THE one deliberate write
        // THE INLINE FOLDS run INSIDE the transaction: the routing table and the core state
        // are atomically exact as of the last committed event, always — the pump-races-the-
        // provide class is unspellable, not carefully avoided. (Reduce errors are caught per
        // event; a bad event skips, it never aborts the commit.)
        this.#foldInline(committed, scannedAfterOffset, nextOffset);
      }
      return { committed, nextOffset };
    });
    if (nextOffset > scannedAfterOffset) {
      this.#highestAssignedOffsetCache = nextOffset;
      // THE PUMP: push the batch + window into every enabled facet processor (each an isolated
      // workerd facet with its own storage).
      // Fire-and-forget from append's view — an awaited drive would deadlock if a facet
      // processor APPENDS during its batch (append → this method → await the same facet's busy
      // chain), and the capability host DOES append (provide/revoke) — but SERIALIZED PER FACET:
      // without the chain, a slow loader materialization lets a later batch overtake an earlier
      // one, and the earlier window is then judged a stale redelivery and its EPHEMERAL events
      // (undeliverable by repair, by design) are silently dropped. Reads stay correct because
      // every snapshot/invoke gap-repairs from the log. The push is what wakes an aborted facet.
      // Live-state change events never ride a drive: the platform rule makes them unconsumable
      // by every reduce, so delivering them is pure RPC waste (the voice flood). A batch that is
      // ONLY live-state skips the drives; the next real drive's window then COVERS the skipped
      // span (per-facet lastDeliveredThrough) so the facet's contiguity fast path holds — to a
      // reduce, a skipped live-state offset is exactly an ephemeral hole, which windows already
      // express. Without the widened window, the skip broke contiguity and gap repair silently
      // dropped deliverable named ephemerals between two live-state changes (proof-caught).
      const drivable = committed.filter((e) => e.type !== "events.iterate.com/live-state/changed");
      if (drivable.length > 0)
        for (const { slug } of this.#facetEntries()) {
          this.#facetWorkInFlight++;
          const after = this.#driveWindows.get(slug) ?? scannedAfterOffset;
          this.#driveWindows.set(slug, nextOffset);
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
              .catch((e) => console.error(`facet "${slug}" drive failed`, e))
              .finally(() => {
                this.#facetWorkInFlight--;
                this.#noteActivity(); // a finished reduce earns a fresh quiet window
              }),
          );
        }
      // CONNECTED subscription mounts get the batch pushed one-directionally, right now, from
      // the commit path — a synchronous fire-and-forget WebSocket send, no RPC, no await.
      // (ABSENT targets ride the subscription-forwarder facet, which is one of the drives above.)
      this.#deliverToConnectedSubscriptions(committed, scannedAfterOffset, nextOffset);
    }
    this.#noteActivity();
    return committed;
  }

  // Per-facet drive serialization + the in-flight count the quiesce alarm respects (aborting a
  // facet MID-FOLD is exactly the stall the resurrection pass exists to heal — never cause it).
  #driveChains = new Map<string, Promise<unknown>>();
  #driveWindows = new Map<string, number>(); // per-facet lastDeliveredThrough (skipped spans ride the next window)
  #facetWorkInFlight = 0;

  // ── THE INLINE CORE: reduce-only processors reduced synchronously at the commit point ──
  // The runner apparatus (chain, cursors, gap repair, resurrection) is the price of being AWAY
  // from the commit point; these reduces run AT it and pay none of it. Checkpoint = one versioned
  // kv value per slug, committed atomically with the batch; rebuild = replay the durable log
  // (version skew, eviction, first contact — all the same path). Inline reduces see DURABLE
  // events only, so the checkpoint always rebuilds bit-identically.
  #inlineCache = new Map<
    string,
    { proc: ReduceOnlyProcessor<unknown>; state: unknown; throughOffset: number }
  >();
  #capabilityTableInstance?: CapabilityTableProcessor;

  /** THE capability host, parent-constructed: same class, same contract, zero distance. */
  #capabilityTableProcessor(): CapabilityTableProcessor {
    if (this.#capabilityTableInstance) return this.#capabilityTableInstance;
    const { projectId, path } = this.#name;
    const ownContext = {
      append: (...e: unknown[]) => this.append(...(e as StreamEventInput[])),
      read: (after?: number, limit?: number) => this.read(after, limit),
      invoke: (call: unknown) => this.invoke(call as Expression),
    };
    const builtIns = buildBuiltIns({
      projectId,
      path,
      contextName: this.#doName,
      env: this.env,
      invoke: (call) => this.invoke(call),
      context: (p) =>
        p === path ? ownContext : this.env.CONTEXT.getByName(stringifyName({ projectId, path: p })),
      // The connections + facets views are PARENT-LOCAL — the delivery WebSockets and facets
      // live here and can never move (workerd#6702: sockets never leave the parent).
      connections: {
        get: (key) =>
          pathProxy((segments, args) => this.#connectionInvoke(key, segments, args), {
            allowRootCall: true,
          }),
        each: (method, ...args) => this.#connectionFanOut(String(method).split("."), args),
        list: () => this.#currentlyConnected(),
        close: (key) => this.#connectionClose(key),
      },
      facets: {
        get: (slug) => pathProxy((segments, args) => this.facetInvoke(slug, segments, args)),
      },
      hostCtx: this.ctx,
    });
    const proc = new CapabilityTableProcessor({
      stream: {
        append: (...events) => this.append(...events),
        read: (after, limit) => Promise.resolve(this.read(after, limit)),
      },
      configMounts: parseAppConfig(this.env.APP_CONFIG).configMounts,
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
    const head = this.#highestAssignedOffset();
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
    const consumes = entry.proc.contract.consumes;
    if (!(consumes.includes("*") || consumes.includes(e.type))) return;
    try {
      entry.state = entry.proc.reduce({ event: e, state: entry.state }) ?? entry.state;
    } catch (err) {
      console.error(`inline "${entry.proc.contract.slug}" reduce failed at ${e.offset}`, err);
    }
  }

  /** Called INSIDE append's transaction: reduce every fresh durable event, checkpoint on change. */
  #foldInline(committed: StreamEvent[], scannedAfterOffset: number, nextOffset: number): void {
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
    limit = Math.max(1, limit); // limit 0 crashed the full-page check (userspace-reachable)
    // A virgin stream has no events table (and reading must not create one — see #touch).
    if (!this.#eventsTableExists()) return { events: [], scannedThroughOffset: afterOffset };
    const events = this.ctx.storage.sql
      .exec(
        "SELECT offset, body FROM events WHERE offset > ? ORDER BY offset LIMIT ?",
        afterOffset,
        limit,
      )
      .toArray()
      .map((r) => ({
        ...(JSON.parse(String(r.body)) as StreamEventInput & { createdAt: string }),
        offset: Number(r.offset),
        path: this.#name.path,
      }));
    // The scan-window proof: a FULL page is only contiguously known through its last row; a
    // short page proves the read scanned to the head (ephemeral holes and all).
    const scannedThroughOffset =
      events.length === limit
        ? events[events.length - 1].offset
        : Math.max(afterOffset, this.#highestAssignedOffset());
    return { events, scannedThroughOffset };
  }

  // ── the #6800 quiesce: idle facets un-pinned so this actor can hibernate ──

  #lastActivityMs = 0;
  #noteActivity(): void {
    this.#lastActivityMs = Date.now();
    void this.#armAlarmNoLaterThan(this.#lastActivityMs + 60_000).catch(() => {});
  }
  /** ONE alarm write per quiet-period start, never per append (an ephemeral flood arms once).
   *  The in-memory memo also kills the awaited getAlarm READ per append: staleness can only
   *  cause one redundant read (alarm() clears it; eviction loses it), never a missed arm. */
  #armedTargetMs?: number;
  async #armAlarmNoLaterThan(target: number): Promise<void> {
    if (this.#armedTargetMs !== undefined && this.#armedTargetMs <= target) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
    this.#armedTargetMs = Math.min(target, current ?? target);
  }
  // In-memory on purpose: a fresh incarnation always runs one resurrection pass, and losing
  // the flag with an eviction is exactly the point.
  #facetsResurrected = false;

  async alarm(): Promise<void> {
    this.#armedTargetMs = undefined; // this alarm FIRED — the memo no longer reflects storage
    // Facets have no alarms (workerd#6810) — the parent proxies. The subscription-forwarder's
    // due retries pump here; it re-arms itself through armSubscriptionRetry when work remains.
    if (this.#facetEntries().some((e) => e.slug === SUBSCRIPTION_FORWARDER_SLUG))
      void this.#facet(SUBSCRIPTION_FORWARDER_SLUG)
        .then((f) =>
          (
            f as unknown as { pumpSubscriptionDeliveries(): Promise<unknown> }
          ).pumpSubscriptionDeliveries(),
        )
        .catch((e) => console.error("subscription-forwarder pump failed", e));
    if (!this.#facetsResurrected) {
      // THE RESURRECTION PASS: a reduce interrupted by eviction, with no follow-up traffic,
      // would otherwise stall until the next append (the pump only fires on commits). The
      // first alarm of each incarnation asks every facet for a snapshot — which IS its
      // catch-up: a behind facet gap-repairs from its own durable cursor, a caught-up one
      // no-ops. The pass is AWAITED and does not count as activity — otherwise it would
      // re-materialize every facet exactly when the stream went quiet and then buy them a
      // second 60s of billed idle before the quiesce below could fire.
      // (State rows need no resurrection: the stream holds no live-state delivery state — a
      // dropped forward surfaces as a chain gap at the client, which re-reads the door.)
      this.#facetsResurrected = true;
      const idleSince = this.#lastActivityMs;
      await Promise.allSettled(
        this.#facetEntries().map(({ slug }) =>
          this.#facet(slug)
            .then((f) => f.snapshot())
            .catch((e) => console.error(`facet "${slug}" resurrection failed`, e)),
        ),
      );
      this.#lastActivityMs = idleSince;
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
      // Same doctrine for the paged-in RetainedCallbackInvoker stubs: retaining one pins this
      // actor awake, and a page always gets it back — dispose them with the idle facets.
      this.#hibernatableRpcStubs.disposeRetainedStubs();
    } else {
      await this.#armAlarmNoLaterThan(this.#lastActivityMs + 60_000);
    }
  }

  // ── SUBSCRIPTION DELIVERY, connected lane: one-directional, from the commit path ──
  // A CONNECTED subscription mount (target itx.connections.get(…)) is served by raw
  // fire-and-forget sends down the connection's delivery WebSocket: the filtered batch plus the
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
  #subscriptionDeliveredThrough = new Map<number, number>();

  #deliverToConnectedSubscriptions(
    committed: StreamEvent[],
    scannedAfterOffset: number,
    nextOffset: number,
  ): void {
    for (const row of this.#activeSubscriptionMounts()) {
      const conn = connectedTarget(row.target);
      if (!conn) continue; // absent target — the forwarder's lane
      const record = this.#findConnection(conn.key);
      if (!record) continue; // closing race — auto-revoke is on its way
      if (row.liveState) {
        // State mode: forward each committed change payload for the watched key, raw (no
        // in-flight tracking, no latest-wins queue — the owner's no-coalescing decision; a
        // dropped or reordered payload is a revision-chain mismatch the client door-heals).
        for (const e of committed) {
          if (e.type !== LIVE_STATE_CHANGED) continue;
          if ((e.payload as { key?: string }).key !== row.liveState.key) continue;
          void this.#hibernatableRpcStubs
            .invoke(record.stubKey, conn.path, [e.payload])
            .catch((err) =>
              console.error(
                `live-state "${row.name}" delivery failed (client re-seeds on gap)`,
                err,
              ),
            );
        }
        continue;
      }
      // Event mode: the consumes filter, applied statelessly outbound. Default = every durable
      // event; naming types opts into ephemerals too (the processor consumes rule, mirrored).
      // LIVE_STATE_CHANGED never rides the event lane (the platform rule).
      const events = committed.filter(
        (e) =>
          e.type !== LIVE_STATE_CHANGED &&
          (row.consumes ? row.consumes.includes(e.type) : !e.ephemeral),
      );
      if (events.length === 0) continue; // the skipped span rides the next delivered range
      const deliveredAfter =
        this.#subscriptionDeliveredThrough.get(row.providedAtOffset) ?? scannedAfterOffset;
      this.#subscriptionDeliveredThrough.set(row.providedAtOffset, nextOffset);
      void this.#hibernatableRpcStubs
        .invoke(record.stubKey, conn.path, [
          events,
          {
            scannedAfterOffset: Math.min(deliveredAfter, scannedAfterOffset),
            scannedThroughOffset: nextOffset,
          } satisfies ScannedOffsetRange,
        ])
        .catch((err) =>
          console.error(`subscription "${row.name}" delivery failed (client heals by pull)`, err),
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
  async armSubscriptionRetry(input: { atMs: number }): Promise<{ ok: true }> {
    await this.#armAlarmNoLaterThan(input.atMs);
    return { ok: true };
  }

  /** Recovery from a forwarder HALT (or an operator cursor seek) — proxied to the facet, which
   *  owns every absent-target cursor. Connected targets have no server cursor to move. */
  async resumeSubscription(input: { name: string; afterOffset?: number }): Promise<{ ok: true }> {
    const row = this.#activeSubscriptionMounts().find((r) => r.name === input.name);
    if (!row) throw new Error(`no subscription "${input.name}"`);
    if (connectedTarget(row.target))
      throw new Error(
        `"${input.name}" delivers one-directionally to a connected client — there is no server cursor; the client heals itself with read(afterOffset)`,
      );
    if (!this.#facetEntries().some((e) => e.slug === SUBSCRIPTION_FORWARDER_SLUG))
      throw new Error("no subscription-forwarder enabled (nothing to resume)");
    await (
      (await this.#facet(SUBSCRIPTION_FORWARDER_SLUG)) as unknown as {
        resumeSubscription(i: { name: string; afterOffset?: number }): Promise<{ ok: true }>;
      }
    ).resumeSubscription(input);
    return { ok: true };
  }

  // ── facet-hosted processors (built-ins via processor-facet.ts; userspace via the LOADER) ──

  /** DERIVED from the capability table: processor mounts (path itx.processors.<slug>) ARE the
   *  registry — enablement is event-sourced like every other attachment; the facet-processors
   *  kv registry is dead. Newest same-slug mount wins (re-enable with new props = shadow). */
  #facetEntries(): FacetProcessorEntry[] {
    const state = this.#inline(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
    const bySlug = new Map<string, FacetProcessorEntry>();
    for (const m of state.mounts) {
      if (m.path.length === 3 && m.path[0] === "itx" && m.path[1] === "processors") {
        const policy = (m.processor ?? {}) as ProcessorPolicy;
        bySlug.set(m.path[2], {
          slug: m.path[2],
          ...(policy.source
            ? { ref: { source: parse(policy.source), export: policy.export ?? "default" } }
            : {}),
          ...(policy.props ? { props: policy.props } : {}),
        });
      }
    }
    return [...bySlug.values()];
  }

  /** Materialize (or reuse) the facet hosting `slug`. A stored `ref` means USERSPACE: the
   *  user's modules ride the Worker Loader beside the injected SDK (`processor.js` — base class
   *  + contract helper + zod) and the generic runner DO (`runner.js`); the user exports
   *  `class X extends StreamProcessor` and never writes a DurableObject. Both facet kinds speak
   *  the same duck contract: configure / processEventBatch / snapshot / waitUntilProcessed.
   *  NEVER retain the returned handle (#6800: re-`get` per burst; the quiesce alarm aborts). */
  async #facet(slug: string): Promise<FacetProcessorHandle> {
    const ref = this.#facetEntries().find((e) => e.slug === slug)?.ref;
    if (!ref) {
      const exports = (this.ctx as unknown as { exports: Record<string, unknown> }).exports;
      return this.ctx.facets.get(`proc:${slug}`, () => ({
        class: exports.ProcessorFacet as DurableObjectClass,
      })) as unknown as FacetProcessorHandle;
    }
    const userModules = (await this.invoke(ref.source)) as Record<string, string>;
    const version = hashSource(JSON.stringify(userModules));
    const worker = confinedWorker(
      this.env,
      // Deploy id rides the minted key (the stale-isolate/DataCloneError family).
      { kind: "procfacet", owner: `${this.#doName}:${slug}`, contentHash: version },
      "runner.js",
      {
        ...userModules,
        "processor.js": PROCESSOR_SDK_MODULE,
        "runner.js": PROCESSOR_RUNNER_MODULE,
      },
      itxEntrypointFor(this.ctx, this.#doName),
    );
    return versionedFacet(this.ctx, {
      worker,
      className: "ProcessorFacetRunner",
      facetName: `proc:${slug}`,
      markerKey: `procfacet:${slug}:version`,
      version,
    }) as FacetProcessorHandle;
  }

  /** Enable a facet-hosted processor on this stream (idempotent; identity configured durably).
   *  With a `ref` the processor is USERSPACE code: `source` (an expression resolved to modules)
   *  + which `export` is the StreamProcessor subclass — stored durably so every incarnation
   *  rebuilds the same facet. */
  async enableProcessor(
    slug: string,
    ref?: { source: string | Expression; export: string },
    props?: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    this.#touch();
    if (slug === CAPABILITY_TABLE_SLUG || slug === "core")
      throw new Error(`"${slug}" is an inline core processor — it is always on, never a facet`);
    // Enablement IS a mount: the processor policy rides the same capability-provided event
    // (event-sourced, auditable, shadowable); the target makes itx.processors.<slug>.snapshot()
    // resolve through the ordinary facet-address view.
    await this.#capabilityTableProcessor().provide({
      path: `itx.processors.${slug}`,
      target: `itx.facets.get('${slug}')`,
      processor: {
        ...(ref ? { source: print(toExpression(ref.source)), export: ref.export } : {}),
        ...(props ? { props } : {}),
      },
    });
    await (await this.#facet(slug)).configure(this.#identityFor(slug, ref?.export, props));
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
    this.#driveWindows.delete(slug); // a re-enable must not inherit a scanned range it never saw
    await this.revokeCapability({ path: `itx.processors.${slug}` });
    const facets = this.ctx.facets as unknown as { delete?: (name: string) => void };
    if (typeof facets.delete === "function") facets.delete(`proc:${slug}`);
    else this.ctx.facets.abort(`proc:${slug}`, "disabled");
    return { ok: true };
  }

  /** THE generic facet door: resolve the facet LOCALLY (facet stubs are non-transferable — the
   *  walk happens where the stub lives), walk the dotted path with the exposure guard, apply
   *  the terminal. `roots.facets` (and via one seed, `itx.facets`) rides this to reach ANY
   *  method a facet's durable object exposes — a facet hosts an object; processor is a role. */
  async facetInvoke(slug: string, path: string[], args: unknown[]): Promise<unknown> {
    this.#noteActivity(); // (was in #facet — moved out so the resurrection pass stays idle-neutral)
    if (path.length === 0) throw new Error(`facet "${slug}": name a method`);
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
      throw new Error(`no facet "${slug}" enabled`);
    // invokePath = stepGet + Reflect.apply with the receiver carried (the DataCloneError
    // learning lives on the helper — see core/expression.ts).
    return invokePath(await this.#facet(slug), path, args, `facet "${slug}"`);
  }

  #identityFor(slug: string, exportName?: string, props?: Record<string, unknown>): FacetIdentity {
    return {
      parentName: this.#doName,
      projectId: this.#name.projectId,
      path: this.#name.path,
      slug,
      ...(exportName ? { export: exportName } : {}),
      ...(props ? { props } : {}),
    };
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

  /** Mount a capability (event provenance — built-in targets are config-mount-only). A
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
    this.#touch();
    const pathString = typeof input.path === "string" ? input.path : input.path.join(".");
    if (pathString.startsWith("itx.subscribers.") && !connectedTarget(toExpression(input.target))) {
      if (input.delivery?.liveState)
        throw new Error(
          "a live-state subscription needs a CONNECTED target (itx.connections.get(…)) — an absent target has no revision chain to keep",
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
  }

  // ── native fetch: the stub pager door, the fetch lane, observability, egress ──

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // A relay opens an ItxConnection's stub pager WebSocket (attach RPC first — it minted the
    // connectionId; an unknown id 409s so a relay that outlived a DO restart re-attaches).
    const pagingConnectionId = request.headers.get(STUB_PAGER_WEBSOCKET_HEADER);
    if (pagingConnectionId !== null) {
      const record = this.#pendingConnectionRecords.get(pagingConnectionId);
      if (!record)
        return new Response(
          `unknown itx connection ${pagingConnectionId} (attachItxConnection first)\n`,
          { status: 409 },
        );
      const response = this.#hibernatableRpcStubs.fetch(request)!;
      if (response.status === 101) {
        this.#pendingConnectionRecords.delete(pagingConnectionId);
        this.#hibernatableRpcStubs.attach(pagingConnectionId, record);
      }
      return response;
    }

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
        incarnation: this.#storageReady
          ? this.incarnation
          : ((this.ctx.storage.kv.get("incarnation") as number | undefined) ?? 0),
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
          lane: connectedTarget(r.target)
            ? r.liveState
              ? "connected-live-state"
              : "connected"
            : "forwarder",
        })),
        ...this.#hibernatableRpcStubs.state(),
      });

    // EGRESS: substitute `{{secret:NAME}}` placeholders, then the FALLBACK terminal.
    const sub = await substituteHeaderSecrets(request, "project", (name) =>
      this.env.SECRETS_KV
        ? this.env.SECRETS_KV.get(`secret:${this.#name.projectId}:${name}`)
        : null,
    );
    return this.env.FALLBACK.fetch(sub);
  }

  webSocketMessage(): void {
    // A stub pager WebSocket is DO→relay only — inbound frames carry nothing we act on.
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const record = this.#hibernatableRpcStubs.closed(ws);
    if (record)
      void this.#itxConnectionClosed(record, code, reason).catch((e) =>
        console.error("itx connection close handling failed", e),
      );
  }
  webSocketError(ws: WebSocket): void {
    const record = this.#hibernatableRpcStubs.closed(ws);
    if (record)
      void this.#itxConnectionClosed(record, 1006, "transport error").catch((e) =>
        console.error("itx connection close handling failed", e),
      );
  }

  // ── the ItxConnection lifecycle (attach → facts → close → auto-revoke) ──

  /** Attach an ItxConnection (the relay calls this BEFORE opening the delivery WebSocket).
   *  Appends the ephemeral connection-opened fact — its offset IS the connection's identity
   *  (`connectionId` = String(connectedAtOffset); no synthetic socket ids). With a
   *  `connectionKey` the SESSION RULE files the durable ItxConnectionSession facts: a reconnect
   *  within T of a non-clean end continues the running session (a crash-loop storm is ONE
   *  session and ONE durable fact); otherwise the stale session is settled ("ended no later
   *  than…") and a new one starts. Anonymous attaches (no key — parked live callbacks,
   *  subscriber callbacks) file no session history: their durable trace is the capability mount
   *  that names them. */
  async attachItxConnection(input: {
    connectionKey?: string;
    description?: string;
  }): Promise<{ connectionId: string; connectionKey?: string }> {
    this.#touch();
    let sessionStartedAtOffset: number | undefined;
    if (input.connectionKey) {
      // Reconnect under the same key replaces the predecessor transport (same logical client).
      for (const r of this.#hibernatableRpcStubs.all())
        if (r.connectionKey === input.connectionKey)
          this.#hibernatableRpcStubs.drop(r.stubKey, "replaced");
      const sessionKey = `connection-session:${input.connectionKey}`;
      const session = this.ctx.storage.kv.get(sessionKey) as ItxConnectionSessionRecord | undefined;
      if (session && Date.now() - session.lastActiveMs < ITX_CONNECTION_SESSION_ABSENCE_MS) {
        sessionStartedAtOffset = session.sessionStartedAtOffset; // the same session continues
      } else {
        const facts: StreamEventInput[] = [];
        if (session)
          // A dirty death ended nothing at the time — settle it now, bounded by what we know.
          facts.push({
            type: "events.iterate.com/itx-connection/connection-session-ended",
            payload: {
              connectionKey: input.connectionKey,
              sessionStartedAtOffset: session.sessionStartedAtOffset,
              endedNoLaterThan: new Date(
                session.lastActiveMs + ITX_CONNECTION_SESSION_ABSENCE_MS,
              ).toISOString(),
            },
          });
        facts.push({
          type: "events.iterate.com/itx-connection/connection-session-started",
          payload: {
            connectionKey: input.connectionKey,
            ...(input.description ? { description: input.description } : {}),
          },
        });
        const committed = await this.append(...facts);
        sessionStartedAtOffset = committed[committed.length - 1].offset;
      }
      this.ctx.storage.kv.put(sessionKey, {
        sessionStartedAtOffset,
        lastActiveMs: Date.now(),
      } satisfies ItxConnectionSessionRecord);
    }
    const [opened] = await this.append({
      type: "events.iterate.com/itx-connection/connection-opened",
      ephemeral: true,
      payload: {
        ...(input.connectionKey ? { connectionKey: input.connectionKey } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(sessionStartedAtOffset !== undefined ? { sessionStartedAtOffset } : {}),
      },
    });
    const connectionId = String(opened.offset);
    this.#pendingConnectionRecords.set(connectionId, {
      ...(input.connectionKey ? { connectionKey: input.connectionKey } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(sessionStartedAtOffset !== undefined ? { sessionStartedAtOffset } : {}),
      openedAt: new Date().toISOString(),
    });
    return {
      connectionId,
      ...(input.connectionKey ? { connectionKey: input.connectionKey } : {}),
    };
  }

  /** The page answer: the paged relay hands back a fresh RetainedCallbackInvoker stub, which
   *  stays warm until the idle quiesce disposes it (a page gets it back). */
  activateItxConnection(input: { connectionId: string; invoker: RetainedCallbackInvoker }) {
    return this.#hibernatableRpcStubs.activate({
      stubKey: input.connectionId,
      invoker: input.invoker,
    });
  }
  dropItxConnection(input: { connectionId: string }): { ok: true } {
    this.#hibernatableRpcStubs.drop(input.connectionId, "dropped");
    return { ok: true };
  }

  /** A delivery WebSocket closed: the ephemeral connection-closed fact, the auto-revoke of
   *  every mount targeting the dead connection, and — for keyed connections whose close was
   *  CLEAN and final (no replacement transport) — the durable session end. */
  async #itxConnectionClosed(
    record: HibernatableRpcStubRecord,
    code: number,
    reason: string,
  ): Promise<void> {
    const connectionId = record.stubKey; // the stub key IS the connectionId (connectedAtOffset)
    const connectionKey = record.connectionKey as string | undefined;
    // "replaced" is the SAME logical connection changing transports — never a key-final close.
    const keyFinal =
      typeof connectionKey === "string" &&
      reason !== "replaced" &&
      !this.#hibernatableRpcStubs
        .all()
        .some((r) => r.connectionKey === connectionKey && r.stubKey !== connectionId);
    const facts: StreamEventInput[] = [
      {
        type: "events.iterate.com/itx-connection/connection-closed",
        ephemeral: true,
        payload: {
          connectionId,
          ...(connectionKey !== undefined ? { connectionKey } : {}),
          code,
          reason,
        },
      },
    ];
    if (keyFinal) {
      const sessionKey = `connection-session:${connectionKey}`;
      const session = this.ctx.storage.kv.get(sessionKey) as ItxConnectionSessionRecord | undefined;
      if (session) {
        if (code === 1000) {
          // A clean, final end closes the session NOW — the next attach starts a fresh one.
          facts.push({
            type: "events.iterate.com/itx-connection/connection-session-ended",
            payload: {
              connectionKey,
              sessionStartedAtOffset: session.sessionStartedAtOffset,
            },
          });
          this.ctx.storage.kv.delete(sessionKey);
        } else {
          // A dirty death ends nothing yet — stamp the absence clock; the next attach (or ≥T of
          // absence) settles it ("ended no later than…").
          this.ctx.storage.kv.put(sessionKey, {
            ...session,
            lastActiveMs: Date.now(),
          } satisfies ItxConnectionSessionRecord);
        }
      }
    }
    await this.append(...facts);
    // AUTO-REVOKE: a mount whose target names the dead connection can never deliver again.
    // (By connectionId always; by connectionKey only when no replacement transport carries it.)
    const table = this.#inline(CAPABILITY_TABLE_SLUG).state as CapabilityTable;
    for (const m of table.mounts) {
      const conn = connectedTarget(m.target);
      if (!conn) continue;
      if (conn.key === connectionId || (keyFinal && conn.key === connectionKey))
        await this.revokeCapability({ providedAtOffset: m.providedAtOffset }).catch((e) =>
          console.error(`auto-revoke of mount ${m.providedAtOffset} failed`, e),
        );
    }
  }

  // ── the connections view (delivery WebSockets live HERE and can never move — workerd#6702) ──

  #findConnection(key: string): HibernatableRpcStubRecord | undefined {
    return this.#hibernatableRpcStubs
      .all()
      .find((r) => r.connectionKey === key || r.stubKey === key);
  }

  /** Invoke one connection's retained callback by connectionKey/connectionId (wake → borrowed
   *  RetainedCallbackInvoker leg → invoke). */
  #connectionInvoke(key: string, segments: string[], args: unknown[]): Promise<unknown> {
    const record = this.#findConnection(key);
    if (!record) throw new Error(`itx connection "${key}" is offline`);
    return this.#hibernatableRpcStubs.invoke(record.stubKey, segments, args);
  }

  /** Fan out one dotted method call over EVERY connection attached to this context
   *  (allSettled — a dead connection drops out of the results). */
  async #connectionFanOut(method: string[], args: unknown[]): Promise<unknown[]> {
    const settled = await Promise.allSettled(
      this.#hibernatableRpcStubs
        .all()
        .map((r) => this.#hibernatableRpcStubs.invoke(r.stubKey, method, args)),
    );
    return settled
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  /** The currently connected clients of this context. */
  #currentlyConnected(): Record<string, unknown>[] {
    return this.#hibernatableRpcStubs.all().map((r) => ({
      connectionId: r.stubKey,
      ...(r.connectionKey !== undefined ? { connectionKey: r.connectionKey } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
      ...(r.openedAt !== undefined ? { openedAt: r.openedAt } : {}),
    }));
  }

  /** Kick a connection by connectionKey/connectionId (idempotent — unknown keys are a no-op). */
  #connectionClose(key: string): { ok: true } {
    const record = this.#findConnection(key);
    if (record) this.#hibernatableRpcStubs.drop(record.stubKey, "kicked");
    return { ok: true };
  }
}
