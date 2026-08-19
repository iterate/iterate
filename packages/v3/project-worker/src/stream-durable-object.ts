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
import { confinedWorker } from "./core/agent-runtime.ts";
import { codedError } from "./core/errors.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./core/events.ts";
import { stepGet, toExpression, type Expression } from "./core/expression.ts";
import { hashSource } from "./core/hash.ts";
import { PAGER_HEADER } from "./core/hibernatable-pager.ts";
import { HibernatableStubs, type Invoker, type Stub } from "./core/hibernatable-stub.ts";
import { parseName } from "./core/names.ts";
import { itxEntrypointFor } from "./iterate-context-entrypoint.ts";
import type { ScanWindow } from "./core/processor.ts";
import { PROCESSOR_RUNNER_MODULE } from "./generated/processor-runner.ts";
import { PROCESSOR_SDK_MODULE } from "./generated/processor-sdk.ts";
import type { FacetIdentity, ProcessorFacet } from "./processor-facet.ts";

// What THIS class touches of the shared worker env (the facets see the rest — a built-in facet
// inherits the whole worker env; see roots-builder.ts RootsEnv).
interface Env {
  CONTEXT: DurableObjectNamespace<StreamDurableObject>;
  LOADER: WorkerLoader;
  SECRETS_KV?: KVNamespace;
  /** Deploy identity — folded into loader cacheKeys so a redeploy mints fresh isolates (the
   *  stale-isolate/DataCloneError family the stateful runner documents). */
  CF_VERSION_METADATA?: { id: string };
  /** The shell this context's egress bottoms out at (a whole control plane). */
  FALLBACK: Fetcher;
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
type PushRow = {
  name: string;
  providedAtOffset: number; // the row's identity AND its cursor key
  consumes?: string[];
  onFailingEvent: "halt" | "skip";
  maxAttempts?: number;
  start?: "beginning" | "now";
  /** LIVE STATE row: no cursor, no ladder — the key's change events (which carry their own
   *  delta patch) are forwarded as they commit; the CLIENT owns the revision chain. */
  liveState?: { key: string };
};
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

/** The capability host's slug — the one facet processor this class itself depends on. */
const ICTX_SLUG = "iterate-context";

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
         offset INTEGER PRIMARY KEY AUTOINCREMENT,
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
   *  class, because consumers key durable truth by offset. */
  #maxAssignedCache?: number;
  #maxAssigned(): number {
    if (this.#maxAssignedCache !== undefined) return this.#maxAssignedCache;
    const kvHigh = (this.ctx.storage.kv.get("maxAssignedOffset") as number | undefined) ?? 0;
    const sqlHigh = this.#eventsTableExists()
      ? Number(this.ctx.storage.sql.exec("SELECT COALESCE(MAX(offset),0) AS m FROM events").one().m)
      : 0;
    this.#maxAssignedCache = Math.max(kvHigh, sqlHigh);
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
      if (nextOffset > scannedAfterOffset) this.ctx.storage.kv.put("maxAssignedOffset", nextOffset); // THE one deliberate write
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
      this.#foldSubscriptionProjection(committed, scannedAfterOffset);
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

  /** Fold the subscription PROJECTION inline: exact `itx.subscribers.<name>` provided/revoked
   *  events maintain the derived index + cursors. No facet round trip, no cache staleness —
   *  the parent is the commit point and sees every event body as it lands. Two skips keep this
   *  fold and the facet's mounts fold IN AGREEMENT forever: idempotency dedupe hits replay OLD
   *  offsets (already folded at their original commit — re-folding one resurrects a revoked
   *  row), and ephemeral capability events are invisible to any refold (folding them live here
   *  would mint rows the facet's rebuilt table denies). */
  #foldSubscriptionProjection(committed: StreamEvent[], scannedAfterOffset: number): void {
    for (const e of committed) {
      if (e.offset <= scannedAfterOffset || e.ephemeral) continue;
      if (e.type === "events.iterate.com/capability-host/capability-provided") {
        const { pattern, delivery } = e.payload as {
          pattern: unknown[];
          delivery?: Omit<PushRow, "name" | "providedAtOffset">;
        };
        if (
          Array.isArray(pattern) &&
          pattern.length === 3 &&
          pattern[0] === "itx" &&
          pattern[1] === "subscribers" &&
          typeof pattern[2] === "string"
        ) {
          const name = pattern[2];
          const rows = this.#pushRows().filter((r) => r.providedAtOffset !== e.offset);
          rows.push({
            name,
            providedAtOffset: e.offset,
            ...(delivery ?? {}),
            onFailingEvent: delivery?.onFailingEvent ?? "halt",
          });
          this.ctx.storage.kv.put("push-subscriptions", rows);
          // State rows are cursorless by design — only event rows mint one. (No mount seed
          // either: the CLIENT seeds itself through the producer's door before subscribing.)
          if (!delivery?.liveState && !this.#pushCursor(e.offset))
            this.#putPushCursor(e.offset, {
              confirmedOffset: delivery?.start === "beginning" ? 0 : e.offset,
              attempt: 0,
              skipsSinceSuccess: 0,
            });
        }
      }
      if (e.type === "events.iterate.com/capability-host/capability-revoked") {
        const { providedAtOffset } = e.payload as { providedAtOffset: number };
        const rows = this.#pushRows();
        if (rows.some((r) => r.providedAtOffset === providedAtOffset)) {
          this.ctx.storage.kv.put(
            "push-subscriptions",
            rows.filter((r) => r.providedAtOffset !== providedAtOffset),
          );
          this.ctx.storage.kv.delete(`push-cursor:${providedAtOffset}`); // revoke doubles as GC
        }
      }
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
  /** ONE alarm write per quiet-period start, never per append (an ephemeral flood arms once). */
  async #armAlarmNoLaterThan(target: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }
  // In-memory on purpose: a fresh incarnation always runs one resurrection pass, and losing
  // the flag with an eviction is exactly the point.
  #facetsResurrected = false;

  async alarm(): Promise<void> {
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
  #pushRows(): PushRow[] {
    return (this.ctx.storage.kv.get("push-subscriptions") as PushRow[] | undefined) ?? [];
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
  async subscribe(input: {
    name?: string;
    target: string | Expression;
    consumes?: string[];
    onFailingEvent?: "halt" | "skip";
    maxAttempts?: number;
    start?: "beginning" | "now";
    liveState?: { key: string };
  }): Promise<{ name: string; providedAtOffset: number }> {
    this.#touch();
    const target = toExpression(input.target);
    if (target[0] !== "itx")
      throw new Error(
        `subscribe: target must be an itx expression (got ${JSON.stringify(target[0])})`,
      );
    // A UNIQUE default name — two concurrent anonymous subscribes must never collide on the
    // same name and silently shadow each other (the max-offset default did exactly that).
    const name = input.name ?? `subscription:${crypto.randomUUID().slice(0, 8)}`;
    const { providedAtOffset } = await (
      await this.#ictx()
    ).provide({
      pattern: ["itx", "subscribers", name],
      target,
      delivery: {
        consumes: input.consumes,
        onFailingEvent: input.onFailingEvent,
        maxAttempts: input.maxAttempts,
        start: input.start,
        liveState: input.liveState,
      },
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
  #forwardLiveState(committed: StreamEvent[]): void {
    let rows: PushRow[] | undefined; // read once per batch, not once per change event
    for (const e of committed) {
      if (e.type !== "events.iterate.com/live-state/changed") continue;
      const { key } = e.payload as { key: string };
      for (const row of (rows ??= this.#activePushRows())) {
        if (row.liveState?.key !== key) continue;
        void this.#ictx()
          .then((f) => f.deliverSubscription(row.providedAtOffset, [e.payload]))
          .catch((err) =>
            console.error(`live-state "${row.name}" forward failed (client re-seeds on gap)`, err),
          );
      }
    }
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
        const cursor = this.#pushCursor(row.providedAtOffset);
        if (!cursor || cursor.halted) return;
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
        // Delivery BY ROW IDENTITY through the ictx facet — never by name through the table
        // (a broad default route must not intercept deliveries). Awaited resolve IS the ack.
        // The watchdog timer is CLEARED on the happy path: a leaked 20s timer per delivery
        // pins the DO out of hibernation — quiet time converted into billed duration.
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (await this.#ictx()).deliverSubscription(row.providedAtOffset, [events, window]),
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
    return (this.ctx.storage.kv.get("facet-processors") as FacetProcessorEntry[] | undefined) ?? [];
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
    const klass = worker.getDurableObjectClass("ProcessorFacetRunner");
    if (!klass) throw new Error(`userspace processor "${slug}": runner class missing`);
    // Abort + recreate the facet on a source change, KEEPING its storage — the stateful runner's
    // version-marker pattern, keyed per slug.
    const markerKey = `procfacet:${slug}:version`;
    const prev = this.ctx.storage.kv.get(markerKey) as string | undefined;
    if (prev !== undefined && prev !== version)
      this.ctx.facets.abort(`proc:${slug}`, "source changed");
    if (prev !== version) this.ctx.storage.kv.put(markerKey, version);
    return this.ctx.facets.get(`proc:${slug}`, () => ({
      class: klass,
    })) as unknown as FacetProcessorHandle;
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
    if (slug === ICTX_SLUG) throw new Error("the iterate-context processor cannot be disabled");
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
    if (slug !== ICTX_SLUG && !this.#facetEntries().some((e) => e.slug === slug))
      throw new Error(`no facet "${slug}" enabled`);
    const facet = (await this.#facet(slug)) as unknown as object;
    let receiver: unknown = facet;
    for (let i = 0; i < path.length - 1; i++) {
      receiver = await stepGet(receiver as object, path[i]);
      if (receiver == null)
        throw new Error(
          `facet "${slug}": "${path.join(".")}" hit ${String(receiver)} at "${path[i]}"`,
        );
    }
    const handler = stepGet(receiver as object, path[path.length - 1]);
    if (typeof handler !== "function")
      throw new Error(`facet "${slug}" has no method "${path.join(".")}"`);
    return await Reflect.apply(handler, receiver, args);
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

  /** THE capability host — the iterate-context facet, lazily enabled on first use like any other
   *  facet processor (so every commit drives it too); the durable marker keeps the enable to
   *  once, not once per call. */
  async #ictx(): Promise<ProcessorFacet> {
    this.#noteActivity();
    if (!this.ctx.storage.kv.get("ictx:enabled")) {
      await this.enableProcessor(ICTX_SLUG);
      this.ctx.storage.kv.put("ictx:enabled", true);
    }
    return (await this.#facet(ICTX_SLUG)) as unknown as ProcessorFacet;
  }

  // ── dispatch (ONE path: the routing table — hosted in the iterate-context facet) ──

  /** Resolve + run one call (either codec half) against the current table. */
  async invoke(call: string | Expression, depth = 0): Promise<unknown> {
    return (await this.#ictx()).invoke(toExpression(call), depth);
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
    return (await this.#ictx()).provide(input);
  }

  async revokeCapability(input: { providedAtOffset: number }): Promise<void> {
    return (await this.#ictx()).revoke(input);
  }

  // ── native fetch: the pager door, the fetch lane, observability, egress ──

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // A relay opens its hibernatable Pager (the DO→relay back-channel; no pin).
    if (request.headers.get(PAGER_HEADER)) return this.#stubs.accept(request);

    // THE FETCH LANE: `x-itx-cap` rides NATIVELY into the capability-host facet's own fetch
    // (facet fetch tunnels a 101 — the stateful runner proves the pattern).
    if (request.headers.get("x-itx-cap")) return (await this.#ictx()).fetch(request);

    // Observability: incarnation (the hibernation tell) + the stub registry's live state.
    // Read-only on purpose — probing /state must never be the write that mints storage.
    if (url.pathname === "/state")
      return Response.json({
        incarnation: this.#storageReady
          ? this.incarnation
          : ((this.ctx.storage.kv.get("incarnation") as number | undefined) ?? 0),
        facetProcessors: this.#facetEntries().map((e) => e.slug),
        pushSubscriptions: this.#activePushRows().map((r) => {
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
