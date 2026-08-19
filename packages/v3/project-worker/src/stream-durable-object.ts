// stream-durable-object.ts — THE STREAM: one DO per `{projectId, path}` (codec-named
// `{projectId}.iterate{path}`). The stream is the parent — LOG + SOCKETS + DOORS only; the
// ITERATE CONTEXT (the routing table, iterate-context-stream-processor.ts) is a facet-hosted
// PROCESSOR on it (processor-facet.ts), one among many:
//
//   • the EVENT LOG — SQLite append/read, monotonic offsets, idempotency at the commit point;
//   • the PROCESSORS — every enabled one a workerd FACET driven after each commit (built-ins by
//     slug, userspace classes via the Worker Loader); the capability host (whose reduced state
//     is the routing table) is the built-in first member, lazily enabled on first use;
//   • the TRANSPORT — every hibernatable socket: relays park client/capability stubs behind
//     Pagers (core/hibernatable-stub.ts) so ANY number of connected providers leave this DO
//     free to hibernate; a live leg is borrowed per call burst only. The stub FACADE
//     (stubInvoke/stubFanOut/stubList/stubConnections/stubClose) is how the facet-hosted
//     capability host reaches the sockets — they can never move off the parent;
//   • the FETCH DOOR — the one place a 101 can enter: `x-itx-pager` accepts a Pager,
//     `x-itx-cap` forwards NATIVELY to the capability-host facet's fetch, anything else is
//     EGRESS (secret placeholder substitution → the FALLBACK terminal).
//
// PURE WORKERS-RPC: capnweb never terminates here (hard rule) — the stateless `/api` worker
// relays. Dispatch is ONE path: parse → route the table → substitute → evaluate → replay — all
// of it inside the iterate-context facet; this class only delegates. The dotted
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
import { invokePath, parse, pathProxy, toExpression, type Expression } from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";
import { PAGER_HEADER } from "./core/hibernatable-pager.ts";
import { HibernatableStubs, type Invoker, type Stub } from "./core/hibernatable-stub.ts";
import { parseName, stringifyName } from "./core/names.ts";
import { itxEntrypointFor } from "./iterate-context-entrypoint.ts";
import {
  IterateContextStreamProcessor,
  type IctxState,
} from "./iterate-context-stream-processor.ts";
import type { ReduceOnlyProcessor, ScanWindow } from "./core/processor.ts";
import type { RootsEnv } from "./roots-builder.ts";
import { PROCESSOR_RUNNER_MODULE } from "./generated/processor-runner.ts";
import { PROCESSOR_SDK_MODULE } from "./generated/processor-sdk.ts";
import { buildHostScope } from "./roots-builder.ts";
import type { FacetIdentity } from "./processor-facet.ts";

// The parent hosts the INLINE CORE (host scope + routing table + core fold), so it needs the
// full roots env the facet used to inherit, plus the config seeds.
interface Env extends RootsEnv {
  APP_CONFIG?: string;
}

/** One enabled facet-hosted processor: a built-in slug, or — with `ref` — USERSPACE code (a
 *  source expression resolved to modules + which export is the StreamProcessor subclass). */
type FacetProcessorEntry = {
  slug: string;
  ref?: { source: Expression; export: string };
};

/** The duck-typed contract BOTH facet kinds satisfy (the built-in ProcessorFacet and the
 *  SDK-injected runner.js): identity in, pushed windows in, fold + barrier out. */
type FacetProcessorHandle = {
  configure(identity: FacetIdentity): Promise<unknown> | unknown;
  processEventBatch(events: StreamEvent[], window: ScanWindow): Promise<unknown> | unknown;
  snapshot(): Promise<{ offset: number; state: unknown }>;
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<unknown>;
};

/** ONE DERIVED push-subscription row — a PROJECTION of the capability-provided/-revoked events
 *  at pattern `itx.subscribers.<name>` (subscription config is EVENT-SOURCED; this index exists
 *  only because the post-commit fan-out is the hot path and must not RPC into the facet to
 *  learn who to notify). Same-name re-provides STACK (freeze-and-fork: the shadowed row's
 *  cursor freezes; revoke pops and it resumes exactly where it stopped; revoke = cursor GC). */
type PushRow = DeliveryPolicy & {
  name: string;
  providedAtOffset: number; // the row's identity AND its cursor key
  onFailingEvent: "halt" | "skip"; // defaulted at projection time
  /** The mount's target, carried into the projection so the CANONICAL parked-callback shape
   *  (itx.clients.get(sid)) delivers via the parent's own stubInvoke — zero facet hops. Any
   *  other target keeps the facet lane (deliverSubscription: substitute + apply). */
  target?: Expression;
};

/** The one short-circuitable target shape: exactly `itx.clients.get('<key>')`. */
const parkedKey = (t?: Expression): string | undefined =>
  t &&
  t.length === 3 &&
  t[0] === "itx" &&
  t[1] === "clients" &&
  Array.isArray(t[2]) &&
  t[2].length === 2 &&
  t[2][0] === "get" &&
  typeof t[2][1] === "string"
    ? t[2][1]
    : undefined;
/** The stream-held cursor + failure ladder state for one push row. */
type PushCursor = {
  confirmedOffset: number;
  attempt: number; // consecutive failures of the CURRENT batch
  skipsSinceSuccess: number;
  pinned?: boolean; // after a failure: batch size 1 (isolate-or-progress)
  nextAttemptAtMs?: number;
  halted?: { reason: string };
  /** Surgery generation: resumeSubscription bumps it; an in-flight pump that read the OLD
   *  cursor must not clobber the surgical one (compare-and-swap before every pump write). */
  rev?: number;
};

/** The capability host's slug — hosted INLINE (see the inline-core section below). */
const ICTX_SLUG = "iterate-context";
/** The core processor is stateless (pure reduce) — one module-level instance serves every DO. */
const CORE_PROCESSOR = new CoreStreamProcessor();

export class StreamDurableObject extends DurableObject<Env> {
  // ── transport: the parked-stub registry over this DO's hibernatable sockets ──
  #stubs = new HibernatableStubs({
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
  });
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
  #maxAssignedCache?: number;
  #maxAssigned(): number {
    this.#maxAssignedCache ??= (this.ctx.storage.kv.get("maxAssignedOffset") as number) ?? 0;
    return this.#maxAssignedCache;
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
    const scannedAfterOffset = this.#maxAssigned();
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
      this.#maxAssignedCache = nextOffset;
      // THE PUMP: push the batch + window into every enabled facet processor (each an isolated
      // workerd facet with its own storage — including the iterate-context capability host).
      // Fire-and-forget from append's view — an awaited drive would deadlock if a facet
      // processor APPENDS during its batch (append → this method → await the same facet's busy
      // chain), and the capability host DOES append (provide/revoke) — but SERIALIZED PER FACET:
      // without the chain, a slow loader materialization lets a later batch overtake an earlier
      // one, and the earlier window is then judged a stale redelivery and its EPHEMERAL events
      // (undeliverable by repair, by design) are silently dropped. Reads stay correct because
      // every snapshot/invoke gap-repairs from the log. The push is what wakes an aborted facet.
      // Live-state change events never ride a drive: the platform rule makes them unconsumable
      // by every fold, so delivering them is pure RPC waste (the voice flood). A batch that is
      // ONLY live-state skips the drives; the next real drive's window then COVERS the skipped
      // span (per-facet lastDeliveredThrough) so the facet's contiguity fast path holds — to a
      // fold, a skipped live-state offset is exactly an ephemeral hole, which windows already
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
                this.#noteActivity(); // a finished fold earns a fresh quiet window
              }),
          );
        }
      // Push rows read DURABLE rows themselves — a pure-ephemeral batch has nothing for them,
      // and driving them anyway bought a cursor kv write per row per append (the flood bill).
      if (committed.some((e) => !e.ephemeral && e.offset > scannedAfterOffset))
        this.#drivePushRows(); // never awaited
      this.#forwardLiveState(committed); // patch frames onto state rows — never awaited
    }
    this.#noteActivity();
    return committed;
  }

  // Per-facet drive serialization + the in-flight count the quiesce alarm respects (aborting a
  // facet MID-FOLD is exactly the stall the resurrection pass exists to heal — never cause it).
  #driveChains = new Map<string, Promise<unknown>>();
  #driveWindows = new Map<string, number>(); // per-facet lastDeliveredThrough (skipped spans ride the next window)
  #facetWorkInFlight = 0;

  // ── THE INLINE CORE: reduce-only processors folded synchronously at the commit point ──
  // The runner apparatus (chain, cursors, gap repair, resurrection) is the price of being AWAY
  // from the commit point; these folds run AT it and pay none of it. Checkpoint = one versioned
  // kv value per slug, committed atomically with the batch; rebuild = replay the durable log
  // (version skew, eviction, first contact — all the same path). Inline folds see DURABLE
  // events only, so the checkpoint always rebuilds bit-identically.
  #inlineCache = new Map<
    string,
    { proc: ReduceOnlyProcessor<unknown>; state: unknown; throughOffset: number }
  >();
  #ictxInstance?: IterateContextStreamProcessor;

  /** THE capability host, parent-constructed: same class, same contract, zero distance. */
  #ictxProcessor(): IterateContextStreamProcessor {
    if (this.#ictxInstance) return this.#ictxInstance;
    const { projectId, path } = this.#name;
    const ownContext = {
      append: (...e: unknown[]) => this.append(...(e as StreamEventInput[])),
      read: (after?: number, limit?: number) => this.read(after, limit),
      invoke: (call: unknown) => this.invoke(call as Expression),
    };
    const hostScope = buildHostScope({
      projectId,
      path,
      contextName: this.#doName,
      env: this.env,
      invoke: (call) => this.invoke(call),
      context: (p) =>
        p === path ? ownContext : this.env.CONTEXT.getByName(stringifyName({ projectId, path: p })),
      // The clients + facets views are PARENT-LOCAL — the sockets and facets live here.
      clients: {
        get: (key) =>
          pathProxy((segments, args) => this.stubInvoke(key, segments, args), {
            allowRootCall: true,
          }),
        at: (p) => ({ call: (method, args) => this.stubFanOut(p, method, args) }),
        list: () => this.stubList(),
        connections: (p) => this.stubConnections(p),
        close: (key) => this.stubClose(key),
      },
      facets: {
        get: (slug) => pathProxy((segments, args) => this.facetInvoke(slug, segments, args)),
      },
      hostCtx: this.ctx,
    });
    const proc = new IterateContextStreamProcessor({
      stream: {
        append: (...events) => this.append(...events),
        read: (after, limit) => Promise.resolve(this.read(after, limit)),
      },
      seeds: parseAppConfig(this.env.APP_CONFIG).seeds,
      hostScope,
    });
    proc.resolveCurrent = (call, depth) => this.invoke(call, depth);
    this.#ictxInstance = proc;
    return proc;
  }

  #inlineDefs(): { slug: string; proc: ReduceOnlyProcessor<unknown> }[] {
    return [
      { slug: "core", proc: CORE_PROCESSOR as ReduceOnlyProcessor<unknown> },
      { slug: ICTX_SLUG, proc: this.#ictxProcessor() as ReduceOnlyProcessor<unknown> },
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
    const head = this.#maxAssigned();
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

  /** Called INSIDE append's transaction: fold every fresh durable event, checkpoint on change. */
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
        : Math.max(afterOffset, this.#maxAssigned());
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
    this.#drivePushRows(); // retries whose backoff came due
    if (!this.#facetsResurrected) {
      // THE RESURRECTION PASS: a fold interrupted by eviction, with no follow-up traffic,
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
      // Never while a drive/fold is in flight: aborting mid-fold is the stall the resurrection
      // pass exists to heal.
      for (const { slug } of this.#facetEntries()) {
        try {
          this.ctx.facets.abort(`proc:${slug}`, "idle quiesce");
        } catch {
          /* facet not running — already quiesced */
        }
      }
    } else {
      await this.#armAlarmNoLaterThan(this.#lastActivityMs + 60_000);
    }
    // keep the earliest pending push retry armed (the arms above may be later)
    const dues = this.#activePushRows()
      .map((r) => this.#pushCursor(r.providedAtOffset)?.nextAttemptAtMs)
      .filter((t): t is number => typeof t === "number");
    if (dues.length) await this.#armAlarmNoLaterThan(Math.min(...dues));
  }

  // ── PUSH SUBSCRIPTIONS: the stream-held cursor + the retry/skip/halt ladder ──
  // For consumers that CANNOT hold a cursor (a webhook, the stateless `processEvent`-style
  // worker). The row's `target` is a path expression; the sender turns its terminal segment
  // into the call `(events, window)` per batch, and the AWAITED call resolving IS the ack.
  // Push rows never see ephemeral events (reads are durable-only); their cursor still advances
  // over ephemeral offsets via scan windows. There is no dead-letter queue on purpose: the
  // ladder is bounded retries (1s·2^n, cap 30min, ±20% jitter, 15 attempts) → poison isolation
  // (`onFailingEvent: "skip"`: pin the batch to 1, three failures → skip + audit event) →
  // HALT (audited, resumable) — the apps/os shape, one mode instead of three kinds.

  #pushInFlight = new Set<number>();
  /** DERIVED from the routing table (the one fold): subscriber mounts ARE the push rows. */
  #pushRows(): PushRow[] {
    const state = this.#inline(ICTX_SLUG).state as IctxState;
    const rows: PushRow[] = [];
    for (const m of state.mounts) {
      const pat = m.pattern;
      if (
        pat.length === 3 &&
        pat[0] === "itx" &&
        pat[1] === "subscribers" &&
        typeof pat[2] === "string"
      ) {
        const delivery = (m.delivery ?? {}) as DeliveryPolicy;
        rows.push({
          name: pat[2],
          providedAtOffset: m.providedAtOffset,
          ...delivery,
          onFailingEvent: delivery.onFailingEvent ?? "halt",
          target: m.target,
        });
      }
    }
    return rows;
  }
  /** The pumped rows: per name, the NEWEST provide wins (the shadow stack, projected).
   *  Shadowed rows keep their cursors — frozen until a revoke restores them. */
  #activePushRows(): PushRow[] {
    const byName = new Map<string, PushRow>();
    for (const r of this.#pushRows()) {
      const cur = byName.get(r.name);
      if (!cur || r.providedAtOffset > cur.providedAtOffset) byName.set(r.name, r);
    }
    return [...byName.values()];
  }
  #pushCursor(offset: number): PushCursor | undefined {
    return this.ctx.storage.kv.get(`push-cursor:${offset}`) as PushCursor | undefined;
  }
  #putPushCursor(offset: number, cursor: PushCursor): void {
    this.ctx.storage.kv.put(`push-cursor:${offset}`, cursor);
  }

  /** SUBSCRIBING IS PROVIDING: sugar that appends the ordinary capability-provided event at
   *  `itx.subscribers.<name>` with the delivery policy riding the SAME event — auditable,
   *  replayable, revocable/shadowable like every other mount. The projection in append() turns
   *  it into a pumped row; provide/revoke/shadow give subscription lifecycle for free
   *  (shadow a subscriber → its cursor freezes; revoke → it resumes where it stopped). */
  async subscribe(
    input: DeliveryPolicy & { name?: string; target: string | Expression },
  ): Promise<{ name: string; providedAtOffset: number }> {
    this.#touch();
    // (the target-root gate lives in ictx.provide — the one enforcement point)
    // A UNIQUE default name — two concurrent anonymous subscribes must never collide on the
    // same name and silently shadow each other (the max-offset default did exactly that).
    const name = input.name ?? `subscription:${crypto.randomUUID().slice(0, 8)}`;
    const { name: _n, target, ...delivery } = input;
    const { providedAtOffset } = await this.#ictxProcessor().provide({
      pattern: ["itx", "subscribers", name],
      target: toExpression(target),
      delivery,
    });
    return { name, providedAtOffset };
  }

  /** Revoke the name's WINNING subscription mount (sugar over revokeCapability). */
  async unsubscribe(input: { name: string }): Promise<{ ok: true }> {
    const winner = this.#activePushRows().find((r) => r.name === input.name);
    if (winner) await this.revokeCapability({ providedAtOffset: winner.providedAtOffset });
    return { ok: true };
  }

  /** THE cursor-surgery verb (the irreducible residue of a subscription beyond its mount):
   *  clear the failure state, optionally move the cursor, kick the pump. */
  resumeSubscription(input: { name: string; afterOffset?: number }): { ok: true } {
    const winner = this.#activePushRows().find((r) => r.name === input.name);
    if (!winner) throw new Error(`no push subscription "${input.name}"`);
    if (winner.liveState)
      throw new Error(
        `"${input.name}" is a live-state subscription — it has no cursor to move (re-read the producer's door instead)`,
      );
    const cursor = this.#pushCursor(winner.providedAtOffset);
    this.#putPushCursor(winner.providedAtOffset, {
      confirmedOffset: input.afterOffset ?? cursor?.confirmedOffset ?? winner.providedAtOffset,
      attempt: 0,
      skipsSinceSuccess: 0,
      rev: (cursor?.rev ?? 0) + 1, // the surgery generation — in-flight pump writes lose to this
    });
    this.#drivePushRows();
    return { ok: true };
  }

  #drivePushRows(): void {
    for (const row of this.#activePushRows())
      if (!row.liveState)
        void this.#pumpPush(row).catch((e) => console.error(`push "${row.name}" pump failed`, e));
  }

  // ── LIVE STATE (the third delivery mode): cursorless, ladderless, LiveView-style ──
  // The change event carries its own delta (`{key, from, to, patch}` — see LIVE_STATE_CHANGED
  // in core/processor.ts) on a producer-owned revision chain, so the stream is a PURE
  // FORWARDER: it pushes each committed change payload at every row watching the key and keeps
  // NO per-row state — the CLIENT owns the chain (seed through the producer's door, apply a
  // patch when `from` matches the held rev, re-read the door on any mismatch). Deliveries are
  // fire-and-forget and NOT mutually ordered; a reordered or dropped frame is just a chain
  // mismatch at the client, which is the same one recovery path as everything else.
  // Latest-wins backpressure: ONE delivery in flight per row, ONE pending payload per row. A
  // chatty producer with a slow subscriber must never grow an unbounded queue of stale deltas —
  // dropped intermediate frames ARE the designed path (the client sees a chain mismatch and
  // re-reads the door, receiving the freshest state in one hop instead of replaying history).
  #liveStateInFlight = new Set<number>();
  #liveStatePending = new Map<number, unknown>();

  #forwardLiveState(committed: StreamEvent[]): void {
    let rows: PushRow[] | undefined; // read once per batch, not once per change event
    for (const e of committed) {
      if (e.type !== "events.iterate.com/live-state/changed") continue;
      const { key } = e.payload as { key: string };
      for (const row of (rows ??= this.#activePushRows())) {
        if (row.liveState?.key !== key) continue;
        this.#liveStatePending.set(row.providedAtOffset, e.payload); // latest wins
        void this.#pumpLiveState(row).catch((err) =>
          console.error(`live-state "${row.name}" pump failed`, err),
        );
      }
    }
  }

  async #pumpLiveState(row: PushRow): Promise<void> {
    if (this.#liveStateInFlight.has(row.providedAtOffset)) return;
    this.#liveStateInFlight.add(row.providedAtOffset);
    try {
      for (;;) {
        const payload = this.#liveStatePending.get(row.providedAtOffset);
        if (payload === undefined) return;
        this.#liveStatePending.delete(row.providedAtOffset);
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.#deliverToRow(row, [payload]),
            new Promise((_, reject) => {
              watchdog = setTimeout(
                () => reject(new Error(`live-state "${row.name}": delivery timed out after 20s`)),
                20_000,
              );
            }),
          ]);
        } catch (err) {
          // A dropped frame is a chain gap at the client — the one recovery path heals it.
          console.error(`live-state "${row.name}" forward failed (client re-seeds on gap)`, err);
        } finally {
          if (watchdog !== undefined) clearTimeout(watchdog);
        }
      }
    } finally {
      this.#liveStateInFlight.delete(row.providedAtOffset);
    }
  }

  /** THE delivery leg: the canonical parked-callback target (itx.clients.get(sid)) rides the
   *  parent's own stubInvoke — zero hops, zero table routing (delivery is "by row identity,
   *  never the table"). Any other target substitutes + applies against the inline fold. */
  #deliverToRow(row: PushRow, args: unknown[]): Promise<unknown> {
    const key = parkedKey(row.target);
    if (key !== undefined) return this.stubInvoke(key, [], args);
    const state = this.#inline(ICTX_SLUG).state as IctxState;
    return this.#ictxProcessor().deliverTo(state, row.providedAtOffset, args);
  }

  /** One in-flight delivery per row; loop until caught up. Never called from the commit path
   *  with an await — the commit never blocks on a subscriber. */
  async #pumpPush(row: PushRow): Promise<void> {
    if (this.#pushInFlight.has(row.providedAtOffset)) return;
    this.#pushInFlight.add(row.providedAtOffset);
    try {
      for (;;) {
        // Shadowed mid-flight → the cursor freezes NOW, not when the pump happens to drain
        // (the shadow's whole meaning is that the OLD target stops receiving).
        if (!this.#activePushRows().some((r) => r.providedAtOffset === row.providedAtOffset))
          return;
        let cursor = this.#pushCursor(row.providedAtOffset);
        if (!cursor) {
          // Minted LAZILY on first pump — rows are derived from the fold, nothing mints them.
          cursor = {
            confirmedOffset: row.start === "beginning" ? 0 : row.providedAtOffset,
            attempt: 0,
            skipsSinceSuccess: 0,
          };
          this.#putPushCursor(row.providedAtOffset, cursor);
        }
        if (cursor.halted) return;
        if (cursor.nextAttemptAtMs && Date.now() < cursor.nextAttemptAtMs) {
          void this.#armAlarmNoLaterThan(cursor.nextAttemptAtMs).catch(() => {});
          return;
        }
        const page = this.read(cursor.confirmedOffset, cursor.pinned ? 1 : 100);
        if (page.scannedThroughOffset <= cursor.confirmedOffset) return; // caught up
        const window = {
          scannedAfterOffset: cursor.confirmedOffset,
          scannedThroughOffset: page.scannedThroughOffset,
        };
        const events = row.consumes
          ? page.events.filter((e) => row.consumes!.includes(e.type))
          : page.events;
        if (events.length === 0) {
          // everything in the window was filtered — confirm through it, no call
          this.#putPushCursor(row.providedAtOffset, {
            ...cursor,
            confirmedOffset: window.scannedThroughOffset,
          });
          continue;
        }
        // Delivery BY ROW IDENTITY — never by name through the table (a broad default route
        // must not intercept deliveries). Awaited resolve IS the ack. The watchdog timer is
        // CLEARED on the happy path: a leaked 20s timer per delivery pins the DO out of
        // hibernation — quiet time converted into billed duration.
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.#deliverToRow(row, [events, window]),
            new Promise((_, reject) => {
              watchdog = setTimeout(
                () => reject(new Error(`push "${row.name}": delivery timed out after 20s`)),
                20_000,
              );
            }),
          ]);
          // Compare-and-swap on the surgery generation: if resumeSubscription rewrote the
          // cursor while we were delivering, the surgical cursor wins (the delivered batch may
          // redeliver — exactly what a replay request asks for). A revoked row's cursor is
          // GONE — writing would resurrect a kv row revoke already GC'd.
          const fresh = this.#pushCursor(row.providedAtOffset);
          if (!fresh || (fresh.rev ?? 0) !== (cursor.rev ?? 0)) continue;
          // A clean delivery resets the WHOLE ladder — including the skip counter, so
          // "3 consecutive skips" really means consecutive.
          this.#putPushCursor(row.providedAtOffset, {
            confirmedOffset: window.scannedThroughOffset,
            attempt: 0,
            skipsSinceSuccess: 0,
            rev: cursor.rev,
          });
        } catch (error) {
          await this.#onPushFailure(row, cursor, events, error);
          return;
        } finally {
          if (watchdog !== undefined) clearTimeout(watchdog);
        }
      }
    } finally {
      this.#pushInFlight.delete(row.providedAtOffset);
    }
  }

  /** ONE ladder, then ONE policy decision — never interleaved. Every failure retries with
   *  backoff (pinned to a single event after the first, so a poison event is isolated from its
   *  batch); only when the 15 attempts are EXHAUSTED does `onFailingEvent` speak: "halt" stops
   *  the subscription; "skip" drops exactly that one event (with an audit fact) and moves on —
   *  and three consecutive skips (no clean delivery between) still halt. A target outage and a
   *  poison event therefore ride the same, predictable ladder. */
  async #onPushFailure(
    row: PushRow,
    cursor: PushCursor,
    events: StreamEvent[],
    error: unknown,
  ): Promise<void> {
    // The same CAS as the success path: surgery or revoke mid-delivery wins over the failure.
    const fresh = this.#pushCursor(row.providedAtOffset);
    if (!fresh || (fresh.rev ?? 0) !== (cursor.rev ?? 0)) return;
    const attempt = cursor.attempt + 1;
    const message = error instanceof Error ? error.message : String(error);
    const backoffFrom = (n: number) =>
      Math.round(Math.min(1000 * 2 ** (n - 1), 1_800_000) * (0.8 + Math.random() * 0.4));
    if (attempt < (row.maxAttempts ?? 15)) {
      const jittered = backoffFrom(attempt);
      this.#putPushCursor(row.providedAtOffset, {
        ...cursor,
        attempt,
        pinned: true, // isolate-or-progress: every retry runs with batch size 1
        nextAttemptAtMs: Date.now() + jittered,
      });
      void this.#armAlarmNoLaterThan(Date.now() + jittered).catch(() => {});
      return;
    }
    // Retries exhausted. A skip policy can only name ONE event — if exhaustion landed on an
    // un-isolated batch (maxAttempts:1 skips the ladder's pinning), pin and go once more so
    // the policy speaks about a single event instead of silently degrading into a halt.
    if (row.onFailingEvent === "skip" && events.length > 1) {
      const jittered = backoffFrom(attempt);
      this.#putPushCursor(row.providedAtOffset, {
        ...cursor,
        attempt,
        pinned: true,
        nextAttemptAtMs: Date.now() + jittered,
      });
      void this.#armAlarmNoLaterThan(Date.now() + jittered).catch(() => {});
      return;
    }
    // Now, and only now, consult the policy.
    if (row.onFailingEvent === "skip" && events.length === 1) {
      const skips = cursor.skipsSinceSuccess + 1;
      if (skips >= 3) return this.#haltPush(row, `3 consecutive skips (last error: ${message})`);
      await this.append({
        type: "events.iterate.com/stream/subscription-event-skipped",
        payload: { name: row.name, offset: events[0].offset, error: message },
      });
      this.#putPushCursor(row.providedAtOffset, {
        confirmedOffset: events[0].offset,
        attempt: 0,
        skipsSinceSuccess: skips,
        rev: cursor.rev,
      });
      void this.#armAlarmNoLaterThan(Date.now()).catch(() => {}); // resume past the skip
      return;
    }
    return this.#haltPush(row, `${attempt} delivery attempts failed (last: ${message})`);
  }

  async #haltPush(row: PushRow, reason: string): Promise<void> {
    const cursor = this.#pushCursor(row.providedAtOffset);
    if (cursor)
      this.#putPushCursor(row.providedAtOffset, {
        confirmedOffset: cursor.confirmedOffset,
        attempt: 0,
        skipsSinceSuccess: cursor.skipsSinceSuccess,
        halted: { reason },
        rev: cursor.rev,
      });
    await this.append({
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: { name: row.name, reason },
    });
  }

  // ── facet-hosted processors (built-ins via processor-facet.ts; userspace via the LOADER) ──

  #facetEntries(): FacetProcessorEntry[] {
    const entries =
      (this.ctx.storage.kv.get("facet-processors") as FacetProcessorEntry[] | undefined) ?? [];
    return entries.filter((e) => e.slug !== ICTX_SLUG); // pre-inline deployments listed it here
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
  ): Promise<{ ok: true }> {
    this.#touch();
    if (slug === ICTX_SLUG || slug === "core")
      throw new Error(`"${slug}" is an inline core processor — it is always on, never a facet`);
    const entry: FacetProcessorEntry = ref
      ? { slug, ref: { source: toExpression(ref.source), export: ref.export } }
      : { slug };
    const others = this.#facetEntries().filter((e) => e.slug !== slug);
    this.ctx.storage.kv.put("facet-processors", [...others, entry]);
    await (await this.#facet(slug)).configure(this.#identityFor(slug, ref?.export));
    return { ok: true };
  }

  /** Disable a facet processor: remove its row and DELETE its facet — storage included (the
   *  fold is derived state, rebuildable from the log by re-enabling; the missing off-switch
   *  the hunt flagged: before this, a misbehaving userspace processor burned a loader
   *  materialization + error log on EVERY commit with no remedy but hand-editing kv). */
  disableProcessor(slug: string): { ok: true } {
    if (slug === ICTX_SLUG || slug === "core")
      throw new Error(`"${slug}" is an inline core processor — it cannot be disabled`);
    this.#driveChains.delete(slug);
    this.#driveWindows.delete(slug); // a re-enable must not inherit a window it never saw
    this.ctx.storage.kv.put(
      "facet-processors",
      this.#facetEntries().filter((e) => e.slug !== slug),
    );
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
    if (slug === ICTX_SLUG || slug === "core") {
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

  #identityFor(slug: string, exportName?: string): FacetIdentity {
    return {
      parentName: this.#doName,
      projectId: this.#name.projectId,
      path: this.#name.path,
      slug,
      ...(exportName ? { export: exportName } : {}),
    };
  }

  // ── dispatch (ONE path: the routing table — the INLINE core fold, zero distance) ──

  /** Resolve + run one call (either codec half) against the current table. */
  async invoke(call: string | Expression, depth = 0): Promise<unknown> {
    this.#noteActivity();
    const state = this.#inline(ICTX_SLUG).state as IctxState;
    return this.#ictxProcessor().resolve(state, toExpression(call), undefined, depth);
  }

  /** The dotted door — the degenerate string half. Loaded workers' `itx.js` + the runner speak
   *  this (`itx.a.b(args)` ⇒ ["itx","a",["b",...args]]). */
  invokeCapability(callPath: string, args: unknown[] = []): Promise<unknown> {
    const segments = callPath.split(".");
    const last = segments.at(-1)!;
    return this.invoke([...segments.slice(0, -1), [last, ...args]] as Expression);
  }

  /** Mount a capability (event provenance — `roots` targets are rejected). */
  async provideCapability(input: {
    pattern: string | Expression;
    target: string | Expression;
  }): Promise<{ providedAtOffset: number }> {
    this.#touch();
    return this.#ictxProcessor().provide(input);
  }

  async revokeCapability(input: { providedAtOffset: number }): Promise<void> {
    await this.#ictxProcessor().revoke(input);
    // Revoke doubles as GC for the delivery machinery keyed by the mount's identity.
    this.ctx.storage.kv.delete(`push-cursor:${input.providedAtOffset}`);
    this.#liveStatePending.delete(input.providedAtOffset);
  }

  // ── native fetch: the pager door, the fetch lane, observability, egress ──

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // A relay opens its hibernatable Pager (the DO→relay back-channel; no pin).
    if (request.headers.get(PAGER_HEADER)) return this.#stubs.accept(request);

    // THE FETCH LANE: `x-itx-cap` resolves against the inline fold right here — a 101 flows
    // back out natively (no facet tunnel needed at all).
    const capHeader = request.headers.get("x-itx-cap");
    if (capHeader) {
      try {
        const expr = capHeader.trimStart().startsWith("[")
          ? (JSON.parse(capHeader) as Expression)
          : parse(capHeader.startsWith("itx") ? capHeader : `itx.${capHeader}`);
        const state = this.#inline(ICTX_SLUG).state as IctxState;
        const result = await this.#ictxProcessor().resolveFetch(state, expr, request);
        if (result instanceof Response) return result;
        return new Response(`fetch lane: ${JSON.stringify(result)}\n`);
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        // Classification by CODE, never message text — the code survives every hop.
        const status = errorCode(error) === "NO_CAPABILITY_MATCH" ? 404 : 500;
        return new Response(`fetch lane error: ${message}\n`, { status });
      }
    }

    // Observability: incarnation (the hibernation tell) + the stub registry's live state.
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
        pushSubscriptions: this.#activePushRows().map((r) => {
          if (r.liveState)
            return { name: r.name, providedAtOffset: r.providedAtOffset, liveState: r.liveState };
          const c = this.#pushCursor(r.providedAtOffset);
          return {
            name: r.name,
            providedAtOffset: r.providedAtOffset,
            confirmedOffset: c?.confirmedOffset ?? 0,
            attempt: c?.attempt ?? 0,
            skipsSinceSuccess: c?.skipsSinceSuccess ?? 0,
            ...(c?.halted ? { halted: c.halted.reason } : {}),
          };
        }),
        ...this.#stubs.state(),
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
    // A Pager is DO→relay only — inbound frames carry nothing we act on.
  }
  webSocketClose(ws: WebSocket): void {
    this.#stubs.closed(ws); // relay gone → its parked stubs vanish with the socket
  }
  webSocketError(ws: WebSocket): void {
    this.#stubs.closed(ws);
  }

  // ── relay-facing transport RPC (the edge parks/activates/drops stubs) ──

  /** Park a live capability's stub; the caller then mounts `itx.clients.get(socketId)` at its
   *  pattern (provide = park + alias — the R13 desugar, done BY the edge in two calls). */
  parkCapability(input: { socketId: string; description?: string }): { ok: true } {
    this.#touch(); // a park is real project use (durable socket attachments follow)
    this.#stubs.park(input.socketId, { description: input.description });
    return { ok: true };
  }
  /** Park a `.connect` client connection (reconnect under the same key replaces its predecessor). */
  parkClient(input: {
    socketId: string;
    path: string;
    connectionKey: string;
    description?: string;
  }): { ok: true; connectionKey: string } {
    this.#touch(); // a park is real project use (durable socket attachments follow)
    for (const s of this.#stubs.all())
      if (
        s.clientPath === input.path &&
        s.connectionKey === input.connectionKey &&
        s.socketId !== input.socketId
      )
        this.#stubs.drop(s.socketId, "replaced");
    this.#stubs.park(input.socketId, {
      clientPath: input.path,
      connectionKey: input.connectionKey,
      description: input.description,
      openedAt: new Date().toISOString(),
    });
    return { ok: true, connectionKey: input.connectionKey };
  }
  /** Wake handshake: the woken relay lends its short Workers-RPC leg for one burst. */
  activateStub(input: { socketId: string; invoker: Invoker }) {
    return this.#stubs.activate(input);
  }
  dropStub(input: { socketId: string }): { ok: true } {
    this.#stubs.drop(input.socketId, "dropped");
    return { ok: true };
  }

  // ── the stub-registry FACADE (the clients view; sockets live HERE and can never move) ──
  // ONE registry, two access verbs: `stubInvoke` single-target (throws when offline);
  // `stubFanOut` per client path (allSettled — a dead connection drops out of the results).
  // The facet-hosted capability host builds its `itx.clients` view as thin RPC wrappers over
  // exactly these five methods (roots-builder.ts facetClientsView).

  #findStub(key: string): Stub {
    const s = this.#stubs.all().find((x) => x.connectionKey === key || x.socketId === key);
    if (!s) throw new Error(`client "${key}" is offline`);
    return s;
  }

  /** Invoke one parked stub by connectionKey/socketId (wake → borrowed leg → invoke). */
  stubInvoke(key: string, segments: string[], args: unknown[]): Promise<unknown> {
    return this.#stubs.invoke(this.#findStub(key).socketId, segments, args);
  }

  /** Fan out one method call over every open connection at a client path. */
  async stubFanOut(path: string, method: string[], args: unknown[]): Promise<unknown[]> {
    const settled = await Promise.allSettled(
      this.#stubs
        .all()
        .filter((s) => s.clientPath === path)
        .map((s) => this.#stubs.invoke(s.socketId, method, args)),
    );
    return settled
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  /** The client roster, grouped by path. */
  stubList(): { path: string; description: unknown; connections: number }[] {
    const byPath = new Map<string, Stub[]>();
    for (const s of this.#stubs.all())
      if (typeof s.clientPath === "string")
        byPath.set(s.clientPath, [...(byPath.get(s.clientPath) ?? []), s]);
    return [...byPath.entries()].map(([p, list]) => ({
      path: p,
      description: list.at(-1)?.description ?? null,
      connections: list.length,
    }));
  }

  /** Every open connection at a client path. */
  stubConnections(
    path: string,
  ): { connectionKey: unknown; description: unknown; openedAt: unknown }[] {
    return this.#stubs
      .all()
      .filter((s) => s.clientPath === path)
      .map((s) => ({
        connectionKey: s.connectionKey,
        description: s.description,
        openedAt: s.openedAt,
      }));
  }

  /** Kick a connection by connectionKey/socketId (idempotent — unknown keys are a no-op). */
  stubClose(key: string): { ok: true } {
    const s = this.#stubs.all().find((x) => x.connectionKey === key || x.socketId === key);
    if (s) this.#stubs.drop(s.socketId, "kicked");
    return { ok: true };
  }
}
