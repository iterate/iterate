// stream/stream.ts — THE STREAM, a dependency-injected class the context DO holds and drives. The
// one thing it needs from its host is `onCommit` (the post-commit fan-out); nothing here reaches
// back into the DO. `ReachableContext`, the seam one context reaches another through, is at the bottom.
//   stream storage — `StreamStorage`, THE STREAM'S TABLES: every SQL statement the stream runs, over the one platform handle
//
// EPHEMERALS COST ZERO WRITES. An ephemeral event takes an offset from the shared sequence but is
// never stored — and an ephemeral-only batch touches storage NOT AT ALL: no row, no transaction, not
// even the high-water mark. Its offsets live in this incarnation's memory. The consequence is the
// one contract every offset-keyed consumer already honours: an ephemeral's offset is unique WITHIN
// an incarnation, and a later incarnation — which resumes from the last DURABLE mark — may hand the
// same number to a durable. Every persisted checkpoint in this package advances only on a batch
// that carried a durable (the processor engine, the core reduce, the subscription cursors), and
// such a batch's high-water mark is committed with it, so no durable is ever skipped; the
// `stream/woken` record, the first event of each incarnation, marks the boundary for anyone
// chaining ranges across it. And `read()` never PROVES a scan beyond the durable mark: a short
// page's `scannedThroughOffset` is the mark, not the in-memory head — so nothing a reader persists
// (a facet's checkpoint, a subscription cursor) can name an offset a later incarnation could hand
// to a durable. Pushes still carry the full head in their ranges; only the log's own proof is capped.

import { codedError, errorCode, reportIssue } from "../lib.ts";
import type { ItxExpressionInput } from "../context/expression.ts";
import { CoreContract, reduceCoreEventBatch, type CoreState } from "./core-processor.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
  LiveState,
  ReduceCheckpointTable,
  type SqlStorageHandle,
} from "./processor.ts";

/** One page of the log: the events after an offset, how far the scan reached (the range a client
 *  chains for contiguity), and whether that reached the durable head — a page is CUT by `limit` or
 *  by the server's byte budget (`read` below), and its length says nothing about which. */
export interface StreamPage {
  events: StreamEvent[];
  scannedThroughOffset: number;
  /** True iff the scan reached the durable mark: nothing more to read until the next commit. */
  atHead: boolean;
}

/** THE APPEND CEILING on one serialized body, in JS chars (`JSON.stringify(body).length` — the one
 *  O(1) size JS has; V8 serializes a string at 1–2 bytes per char). Workers RPC caps ONE message at
 *  32 MiB serialized (every hop, no knob), and a 128 MiB isolate holds ~4 transient copies of a body
 *  while reading it back — 8 MiB keeps both comfortable, and is the one number to tune. An event is
 *  a fact, not a blob: a large payload lives elsewhere and the event names it. */
const EVENT_BODY_MAX_CHARS = 8 * 1024 * 1024;
/** THE READ BUDGET, in UTF-8 bytes as SQLite counts them (≥ JS chars): a page stops BEFORE the row
 *  that would cross it and always carries ≥ 1 row, so the largest legal event still rides alone.
 *  Every replay loop in the package pages through this budget. */
const READ_PAGE_BUDGET_BYTES = 8 * 1024 * 1024;
/** The most rows one page returns whatever `limit` asks — the object overhead of tiny events, which
 *  the byte budget cannot see. */
const READ_PAGE_MAX_EVENTS = 1000;

/** THE SELF-WAKE HALT STREAK — the billing circuit-breaker (wave-0 3b, Jonas: "we need runaway
 *  billing controls"). A context that fires its alarm this many times IN A ROW with NO public door
 *  touched in between has woken itself for nothing — a retry ladder grinding on a context no one is
 *  using, or any arm that fires and re-arms with nothing to show for it. (The loop it was measured
 *  on — the constructor appends `woken`, the `config` cursor row arms the lane's insurance alarm to
 *  deliver it, that alarm found nothing due and the DO's alarm() re-armed its quiet clock with
 *  nothing to quiesce, the isolate was evicted in between, the alarm re-created it every minute —
 *  is closed at its root: alarm() re-arms only while a facet is live or a stub is borrowed.) Past
 *  this, `armAlarmNoLaterThan` stops arming (below) — one billed wake per minute becomes zero —
 *  until a real request clears the streak. Low, because each self-wake is a billed wake and a durable
 *  row: five is a few minutes of a loop, not hours. A live retry ladder is self-limiting anyway (≤ 15
 *  attempts, then it halts on its own); this bounds the UNBOUNDED case. The durable count lives in
 *  stream-storage's `stream_meta`. */
const SELF_WAKE_HALT_STREAK = 5;

/** The waitForEvent selector: `type` is an exact event-type match (absent = any type); only events
 *  with offset strictly greater than `afterOffset` match (default = the head at call time — "the
 *  next occurrence"; history-inclusive waits pass an explicit afterOffset); `timeoutMs` defaults to
 *  30s, capped at 120s, and expiry rejects with codedError("WAIT_TIMEOUT", …). */
export type WaitForEventFilter = { type?: string; afterOffset?: number; timeoutMs?: number };

/** One waiting waitForEvent caller. In-memory only — an eviction drops waiters, and that is FINE:
 *  the caller's own open RPC call keeps the DO awake for the wait's duration anyway, and a dropped
 *  waiter surfaces as the transport error the caller already handles. */
type WaitForEventWaiter = {
  type: string | undefined;
  resolve: (event: StreamEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Everything the stream needs from its host. */
interface StreamDeps {
  /** The DO's whole `ctx.storage` — sync SQLite, the sync transaction, the alarm. */
  storage: DurableObjectStorageSlice;
  /** The event-identity stamp on every StreamEvent. */
  path: string;
  /** The birth certificate's payload. */
  projectId: string;
  /** The post-commit fan-out, once per offset-advancing commit with the newly committed events in
   *  offset order, ephemerals included (the waitForEvent waiters settle before it). */
  onCommit: (freshEvents: StreamEvent[], afterOffset: number, throughOffset: number) => void;
}

/** THE STREAM — the commit point: SQLite rows + ONE durable mark, idempotency at the door, one
 *  shared offset sequence (the header's ephemeral contract), and THE CORE REDUCE (core-processor.ts)
 *  reduced inside every commit and checkpointed with the rows it was reduced from. A body over
 *  EVENT_CHUNK_SIZE is chunked (`StreamStorage` below) — still ONE row at ONE offset. */
export class Stream {
  /** THE TABLES (`StreamStorage` below) — the delivery loop keeps its cursors through here too. */
  readonly storage: StreamStorage;
  readonly #path: string;
  readonly #projectId: string;
  readonly #onCommit: StreamDeps["onCommit"];
  /** The highest offset assigned THIS INCARNATION, ephemerals included; an ephemeral-only batch
   *  advances this alone. */
  #highestAssignedOffset: number;
  /** THE DURABLE MARK: the through-offset of the last COMMITTED durable batch — the core
   *  checkpoint's offset, written every durable commit, so there is no separate mark. What `read()`
   *  proves a scan through and what a resume's seek is clamped to — never the in-memory head above. */
  #highestDurableOffset: number;
  /** FIFO; resolved from `freshEvents` in append's step 5. */
  readonly #waitForEventWaiters: WaitForEventWaiter[] = [];
  #alarmArmedForMs: number | null = null;
  /** The self-wake streak (SELF_WAKE_HALT_STREAK), durable in `stream_meta` and loaded once at
   *  construction so `armAlarmNoLaterThan` can gate on it synchronously; the host DO drives it. */
  #selfWakeStreak = 0;

  // ── THE CORE REDUCE's state: rehydrated by the constructor from the versioned checkpoint and caught
  // up to the durable mark, reduced inside every durable commit and checkpointed with it (the cursor
  // every batch, the state on change). Durable events only, so it rebuilds bit-identically. ──
  #coreReducedState: CoreState;
  #coreReducedThroughOffset: number;
  /** The live-state holder for the core state (`payload.key` = "core"). */
  readonly #coreLiveState: LiveState<CoreState>;

  constructor(deps: StreamDeps) {
    this.storage = new StreamStorage(deps.storage);
    this.#selfWakeStreak = this.storage.readSelfWakeStreak(); // durable across incarnations
    this.#path = deps.path;
    this.#projectId = deps.projectId;
    this.#onCommit = deps.onCommit;
    // THE DURABLE HEAD is the core checkpoint's offset — written every durable commit anyway (the
    // reduce inside the transaction below), so there is no separate mark to write. Read WHATEVER
    // version wrote it: a core-version bump still recovers the head and re-reduces the log up to it.
    const checkpoint = this.storage.reduceCheckpoints.read<CoreState>(CoreContract.slug);
    // A log with rows but NO checkpoint (a lost row; a store from before the SQL layout) is
    // recoverable: the log is the truth and the checkpoint its cache — the mark is the highest row,
    // and the state is re-reduced below exactly as after a version bump. Reported, never fatal: the
    // alternative was re-appending the birth certificate over offset 1 and dying of a UNIQUE
    // constraint on every wake.
    const highestDurableOffset = checkpoint
      ? checkpoint.reducedThroughOffset
      : this.storage.highestEventOffset();
    if (!checkpoint && highestDurableOffset > 0)
      reportIssue(
        "stream.core-checkpoint-missing",
        new Error(
          `stream ${this.#path}: the log holds rows through offset ${highestDurableOffset} but no core checkpoint — re-deriving the mark and the state from the log`,
        ),
        { highestDurableOffset },
      );
    this.#highestDurableOffset = highestDurableOffset;
    this.#highestAssignedOffset = highestDurableOffset;
    // The checkpoint is written in the SAME transaction as the rows it was reduced from, so the two
    // cannot disagree; one written under ANOTHER contract version re-reduces the durable log from
    // offset 0 — the one-time cost of a version bump.
    if (checkpoint?.reducerVersion === CoreContract.version) {
      this.#coreReducedState = checkpoint.state ?? CoreContract.initialState();
      this.#coreReducedThroughOffset = checkpoint.reducedThroughOffset;
    } else {
      this.#coreReducedState = CoreContract.initialState();
      this.#coreReducedThroughOffset = 0;
      // Budgeted pages (READ_PAGE_BUDGET_BYTES): this runs in the DO constructor, where a page that
      // did not fit the isolate would be a reboot loop — every wake re-running the same re-reduce.
      while (this.#coreReducedThroughOffset < this.#highestDurableOffset) {
        let page: StreamPage;
        try {
          page = this.read(this.#coreReducedThroughOffset, 500);
        } catch (error) {
          // An unreadable row must not brick the context on every wake: report it, skip it, go on.
          if (errorCode(error) !== "EVENT_UNREADABLE") throw error;
          const { offset } = (error as { data: { offset: number } }).data;
          reportIssue("stream.core-rereduce", error, { offset });
          this.#coreReducedThroughOffset = offset;
          continue;
        }
        this.#coreReducedState = this.#reduceEventsIntoCoreReducedState(
          page.events,
          this.#coreReducedState,
        );
        if (page.scannedThroughOffset <= this.#coreReducedThroughOffset) break; // nothing left
        this.#coreReducedThroughOffset = page.scannedThroughOffset;
      }
    }
    this.#coreLiveState = new LiveState(
      { append: (event) => this.append(event) },
      CoreContract.slug,
      this.#coreReducedState,
      // A same-isolate sink: the delta must land densely inside the commit that triggered it, never
      // deferred through the ordering chain (processor.ts `LiveState#orderDeltaAppends`).
      { orderDeltaAppends: false },
    );
  }

  /** THE WAKE RECORD — the DO constructor calls this before any door opens, so a probe on a
   *  never-seen context materializes it (what is worth reaching is worth recording). The first
   *  incarnation appends `stream/created { projectId, path }` at offset 1, every incarnation
   *  `stream/woken { incarnation }`. Both are exempt from pause: a paused stream still records its wake. */
  appendCreatedAndWokenEvents(): void {
    const born = this.#highestDurableOffset === 0;
    this.append(
      ...(born
        ? [
            {
              type: "events.iterate.com/stream/created",
              payload: { projectId: this.#projectId, path: this.#path },
            },
          ]
        : []),
      {
        type: "events.iterate.com/stream/woken",
        payload: { incarnation: this.storage.incarnation },
      },
    );
  }

  highestAssignedOffset(): number {
    return this.#highestAssignedOffset;
  }

  /** 0 on a store that never held a durable row. Ephemeral offsets above it exist only in this
   *  incarnation's memory. */
  highestDurableOffset(): number {
    return this.#highestDurableOffset;
  }

  /** The core reduced state as of the last commit — what the append door, the dispatcher and the
   *  delivery loop read, synchronously. */
  get coreReducedState(): CoreState {
    return this.#coreReducedState;
  }

  /** `{ offset, state }` — the `itx.facets.get('core').snapshot()` door. */
  coreReducedStateSnapshot(): { offset: number; state: CoreState } {
    return { offset: this.#coreReducedThroughOffset, state: this.#coreReducedState };
  }

  /** The live-state seed door, as a facet processor's `liveSnapshot()` is. */
  coreLiveStateSnapshot(): { rev: number; state: CoreState } {
    return this.#coreLiveState.snapshot();
  }

  // ── APPEND: the commit pipeline, top to bottom ──

  /** Commit a batch. Synchronous end to end (sync SQLite), so the steps never interleave:
   *
   *    1. MAY THIS LAND?  well-formed
   *    2. OFFSETS         idempotency (dedupe or refuse) · the pause (a dedupe hit is admitted, a
   *                       fresh event refused) · expected offsets · one shared sequence, ephemerals
   *                       included — decided in memory, nothing written yet
   *    3 + 4. REDUCE + COMMIT   rows + the high-water mark + the core reduce with its checkpoint, ONE
   *                             transaction (an ephemeral-only batch skips this entirely: zero SQL)
   *    5. AFTER           waiters, then the host's fan-out (every subscriber), then core's live delta
   *
   *  Every refusal happens before a single write. The two marks are advanced only AFTER the
   *  transaction returns, so a throw leaves them true. */
  append(...events: StreamEventInput[]): StreamEvent[] {
    if (events.length === 0) return []; // a pure no-op: nothing checked, minted, or fanned out
    // 1. may this land? — this runtime check is the SOLE enforcement (no boundary validator).
    for (const event of events) {
      if (typeof event.type !== "string" || event.type.trim() === "")
        throw new Error("append: every event needs a non-empty type");
      // RESERVED NAMES, refused at the one append door (parseSubscriptionName refuses them at the
      // command door too): `core` — a raw `subscription-configured { name: "core" }` would install an
      // undeliverable row that climbs the retry ladder to a halt — and any key of `Object.prototype`,
      // which the plain-record subscriptions table would read or write as the prototype.
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        const name = (event.payload as { name?: unknown } | undefined)?.name;
        if (name === CoreContract.slug || (typeof name === "string" && name in Object.prototype))
          throw codedError(
            "RESERVED_SUBSCRIPTION_NAME",
            `${JSON.stringify(name)} is reserved as a subscription name: "${CoreContract.slug}" is the core reduce, and a key of Object.prototype would name the table's prototype`,
            { name },
          );
      }
      // An EPHEMERAL is never stored, but it rides every push over the same 32 MiB RPC and sits in
      // the same delivery memory — the same ceiling, measured here (a durable is measured at its insert).
      if (event.ephemeral) {
        const chars = JSON.stringify(event).length;
        if (chars > EVENT_BODY_MAX_CHARS)
          throw codedError(
            "EVENT_TOO_LARGE",
            `append: an ephemeral ${JSON.stringify(event.type)} serializes to ${chars} chars, over the ${EVENT_BODY_MAX_CHARS / (1024 * 1024)} MiB ceiling — it would ride every push over Workers RPC (32 MiB per message); nothing was appended`,
            { type: event.type, chars, maxChars: EVENT_BODY_MAX_CHARS },
          );
      }
    }
    // 2. offsets — decided in memory, nothing written yet. THE PAUSE is checked per event AFTER the
    //    idempotency lookup: the DO constructor replays its birth `config` row on every incarnation,
    //    and checked before the dedupe a paused context could never be rebuilt after an eviction, so
    //    never resumed. A FRESH event on a paused stream is refused, except the platform's own
    //    records and the pause/resume pair itself (it must always accept its own resume).
    const paused = this.#coreReducedState.paused;
    const pauseExempt = [
      "events.iterate.com/stream/created",
      "events.iterate.com/stream/woken",
      "events.iterate.com/stream/paused",
      "events.iterate.com/stream/resumed",
      // the delivery loop's own record of a halted row — a paused stream's ladder must still end
      "events.iterate.com/stream/subscription-delivery-halted",
    ];
    const afterOffset = this.#highestAssignedOffset;
    const createdAt = new Date().toISOString();
    const committedEvents: StreamEvent[] = []; // one per appended event, in order (a dedupe hit echoes the existing event)
    const freshEvents: StreamEvent[] = []; // the events NEW to the log, in offset order — what commits, reduces, fans out
    const eventsByIdempotencyKey = new Map<string, StreamEvent>(); // keys landing earlier in THIS batch
    let throughOffset = afterOffset;
    for (const event of events) {
      const { offset: expectedOffset, ...eventInput } = event;
      // IDEMPOTENCY: a key already in the log (or earlier in this batch) answers with THAT event and
      // consumes no offset; a different body under the same key refuses the whole batch.
      let existingEvent = eventInput.idempotencyKey
        ? eventsByIdempotencyKey.get(eventInput.idempotencyKey)
        : undefined;
      if (eventInput.idempotencyKey && !existingEvent) {
        const row = this.storage.readEventByIdempotencyKey(eventInput.idempotencyKey);
        if (row)
          existingEvent = {
            ...(JSON.parse(row.body) as object),
            offset: row.offset,
            path: this.#path,
          } as StreamEvent;
      }
      if (existingEvent) {
        if (!sameIdempotentEvent(existingEvent, eventInput))
          throw codedError(
            "IDEMPOTENCY_CONFLICT",
            idempotencyConflictMessage(eventInput.idempotencyKey!, existingEvent.offset),
            { existingOffset: existingEvent.offset },
          );
        committedEvents.push(existingEvent); // a retry answers with the event it already has, whatever `offset` it hoped for
        continue;
      }
      if (paused && !pauseExempt.includes(eventInput.type))
        throw codedError("STREAM_PAUSED", `stream paused: ${paused.reason}`);
      // EXPECTED OFFSET: an event carrying `offset` lands exactly there or the batch is refused —
      // "nothing has happened since I last looked" (apps/os's optimistic-concurrency shape).
      const offset = throughOffset + 1;
      if (expectedOffset !== undefined && expectedOffset !== offset)
        throw codedError(
          "OFFSET_CONFLICT",
          `expected offset ${expectedOffset}, but the next offset is ${offset}`,
          { expected: expectedOffset, actual: offset },
        );
      throughOffset = offset;
      const committedEvent = { ...eventInput, offset, createdAt, path: this.#path } as StreamEvent;
      if (eventInput.idempotencyKey)
        eventsByIdempotencyKey.set(eventInput.idempotencyKey, committedEvent);
      committedEvents.push(committedEvent);
      freshEvents.push(committedEvent);
    }
    if (freshEvents.length === 0) return committedEvents; // every event deduped to an existing one
    // 3 + 4. reduce and commit
    let coreReducedStateChanged = false;
    if (freshEvents.every((event) => event.ephemeral)) {
      // THE EPHEMERAL FAST PATH: nothing to store, so no transaction and no high-water write —
      // what lets a flood of ephemerals leave SQLite untouched (the flood proofs measure it).
      this.#highestAssignedOffset = throughOffset; // the durable mark is untouched
    } else {
      let reducedState = this.#coreReducedState;
      this.storage.transactionSync(() => {
        for (const event of freshEvents) {
          if (event.ephemeral) continue;
          // the row carries the offset, the stream is the path
          const { offset: _offset, path: _path, ...eventBody } = event;
          const serializedBody = JSON.stringify(eventBody);
          // THE APPEND CEILING (EVENT_BODY_MAX_CHARS), measured on the durable's stored body. The
          // transaction rolls back and the marks are locals until it commits: nothing written, no
          // offset burned. (An ephemeral met the same ceiling in step 1, before any offset was assigned.)
          if (serializedBody.length > EVENT_BODY_MAX_CHARS)
            throw codedError(
              "EVENT_TOO_LARGE",
              `append: the event that would land at offset ${event.offset} serializes to ${serializedBody.length} chars, over the ${EVENT_BODY_MAX_CHARS / (1024 * 1024)} MiB ceiling — Workers RPC caps a message at 32 MiB and a read holds several copies; store the payload elsewhere and let the event name it`,
              {
                offset: event.offset,
                chars: serializedBody.length,
                maxChars: EVENT_BODY_MAX_CHARS,
              },
            );
          this.storage.insertEvent(event.offset, serializedBody, event.idempotencyKey ?? null);
        }
        // The core reduce checkpoints with this batch: the cursor every batch IS the durable head
        // (one write, not two), the state on change. Reduced into a LOCAL: the fields move only
        // after the transaction commits, so a failed write never leaves phantom core state in memory.
        reducedState = this.#reduceEventsIntoCoreReducedState(freshEvents, reducedState);
        this.storage.reduceCheckpoints.write(
          CoreContract.slug,
          { reducerVersion: CoreContract.version, reducedThroughOffset: throughOffset },
          reducedState,
          reducedState !== this.#coreReducedState,
        );
      });
      coreReducedStateChanged = reducedState !== this.#coreReducedState;
      this.#coreReducedState = reducedState;
      this.#coreReducedThroughOffset = throughOffset;
      this.#highestAssignedOffset = throughOffset;
      this.#highestDurableOffset = throughOffset;
    }
    // 5. after the commit
    this.#resolveWaitForEventWaiters(freshEvents); // waiters first: onCommit may append again (a nested commit)
    this.#onCommit(freshEvents, afterOffset, throughOffset);
    // Core's live-state delta rides this stream's own append (a nested commit). LOSSY BY CONTRACT:
    // LiveState.set contains every refusal (a PAUSED stream refuses the delta) as a revision-chain
    // gap the client heals by re-seeding. No feedback loop: the delta is ephemeral and changes no
    // core state, so the nested commit's own step 5 finds nothing left.
    if (coreReducedStateChanged) this.#coreLiveState.set(this.#coreReducedState);
    return committedEvents;
  }

  /** THE ONE DOOR into the core reduce — the commit's fresh events and each page of the constructor's
   *  re-reduce. A malformed control event must not wedge the stream: record the skip, move on. */
  #reduceEventsIntoCoreReducedState(events: StreamEvent[], state: CoreState): CoreState {
    return reduceCoreEventBatch(events, state, (error, event) =>
      reportIssue("stream.core-reduce", error, { offset: event.offset, type: event.type }),
    );
  }

  /** One page after `afterOffset`: at most `limit` rows AND at most READ_PAGE_BUDGET_BYTES of
   *  bodies — the SERVER decides the page, `limit` only shrinks it. SYNCHRONOUS: the stream's own
   *  single-turn scans call it inline, and cross-hop callers get a promise from Workers RPC
   *  regardless. The budget bounds ONE read; many large reads at once are an accepted
   *  client-behaviour limit (e2e/stream-isolate-ceilings-deployed, CONCURRENT READERS, says why). */
  read(afterOffset = 0, limit = 500): StreamPage {
    limit = Math.min(Math.max(1, limit), READ_PAGE_MAX_EVENTS); // limit 0 crashed the cut check (userspace-reachable)
    const { rows, nextRowDidNotFit } = this.storage.readEventPage(
      afterOffset,
      limit,
      READ_PAGE_BUDGET_BYTES,
    );
    const events: StreamEvent[] = rows.map((row) => {
      let body: StreamEventInput & { createdAt: string };
      try {
        body = JSON.parse(row.body) as StreamEventInput & { createdAt: string };
      } catch (error) {
        // A stored body that is not JSON is storage corruption; name the offset so a reader can
        // skip past it (`read(offset)`), instead of the platform's parse error naming nothing.
        throw codedError(
          "EVENT_UNREADABLE",
          `read: the stored body at offset ${row.offset} is not JSON (${error instanceof Error ? error.message : String(error)}) — read on from that offset to skip it`,
          { offset: row.offset },
        );
      }
      return { ...body, offset: row.offset, path: this.#path };
    });
    // The proof: a CUT page is contiguously known through its last row; a complete page proves the
    // scan reached the durable mark — never the in-memory head (the header's zero-write contract).
    // At head: the scan ran out of rows, or the page's last row IS the durable mark (an
    // exact-`limit` page at the head must say so — rule 5's caught-up pass rides it).
    const highestDurableOffset = this.highestDurableOffset();
    const lastOffset = events.length ? events[events.length - 1].offset : afterOffset;
    const atHead =
      !nextRowDidNotFit && (events.length < limit || lastOffset >= highestDurableOffset);
    return { events, scannedThroughOffset: atHead ? highestDurableOffset : lastOffset, atHead };
  }

  /** Resolve with the next event matching `filter` — or the first COMMITTED durable match already in
   *  the log after an explicit `filter.afterOffset`. CHECK-AND-WAIT IS ONE SYNCHRONOUS SLICE: zero
   *  awaits between the log scan and waiter registration (an await there would lose a racing commit
   *  → spurious WAIT_TIMEOUT). Waiters are fed from `freshEvents` in append's tail, so EPHEMERAL
   *  events resolve waits too — but only while a waiter is registered, since they never hit the log. */
  waitForEvent(filter: WaitForEventFilter = {}): Promise<StreamEvent> {
    const type = filter.type;
    const afterOffset = filter.afterOffset ?? this.highestAssignedOffset();
    const timeoutMs = Math.min(filter.timeoutMs ?? 30_000, 120_000);
    let cursor = afterOffset;
    for (;;) {
      const page = this.read(cursor, 500);
      for (const event of page.events)
        if (type === undefined || event.type === type) return Promise.resolve(event);
      if (page.atHead) break;
      cursor = page.scannedThroughOffset; // cut by `limit` or the byte budget: read on
    }
    return new Promise<StreamEvent>((resolve, reject) => {
      const waiter: WaitForEventWaiter = {
        type,
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.#waitForEventWaiters.indexOf(waiter);
          if (at !== -1) this.#waitForEventWaiters.splice(at, 1);
          reject(
            codedError(
              "WAIT_TIMEOUT",
              `waitForEvent: no ${type === undefined ? "" : `"${type}" `}event after offset ${afterOffset} within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      this.#waitForEventWaiters.push(waiter);
    });
  }

  /** The type is a waiter's only filter: it registered after its scan reached the head, so every
   *  fresh event is past the offset it waited from. */
  #resolveWaitForEventWaiters(freshEvents: StreamEvent[]): void {
    for (const event of freshEvents) {
      if (this.#waitForEventWaiters.length === 0) return;
      for (const w of [...this.#waitForEventWaiters]) {
        if (w.type !== undefined && event.type !== w.type) continue;
        this.#waitForEventWaiters.splice(this.#waitForEventWaiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(event);
      }
    }
  }

  // ── the alarm armer ──

  /** ONE alarm write per quiet-period start, never per append (an ephemeral flood arms once).
   *  Memo-only: a fresh incarnation writes one redundant setAlarm and a later target may overwrite
   *  an earlier one, which is safe because every alarm() pass re-derives its obligations and re-arms. */
  armAlarmNoLaterThan(atMs: number): void {
    // The single chokepoint every arm site goes through, so a halted context (SELF_WAKE_HALT_STREAK)
    // cannot re-arm from anywhere. A real request clears the streak before its work, so this only
    // ever suppresses an ALARM-driven arm.
    if (this.selfWakeHalted()) return;
    if (this.#alarmArmedForMs !== null && this.#alarmArmedForMs <= atMs) return;
    this.#alarmArmedForMs = atMs;
    // Not awaited: the native output gate owns the write and turns an async failure into an
    // invocation failure — and a lost memo just re-arms on the next alarm() pass.
    void this.storage.setAlarm(atMs);
  }

  noteAlarmFired(): void {
    this.#alarmArmedForMs = null;
  }

  /** True once the self-wake streak has hit its ceiling — `armAlarmNoLaterThan` is a no-op until a
   *  public door clears it. */
  selfWakeHalted(): boolean {
    return this.#selfWakeStreak >= SELF_WAKE_HALT_STREAK;
  }

  /** One more self-wake (the host's alarm-only pass). `justHalted` is true for THE call that crossed
   *  the ceiling, so the host records the durable fact exactly once even if a pre-armed alarm fires
   *  once more after the halt. */
  noteSelfWake(): { streak: number; justHalted: boolean } {
    const before = this.#selfWakeStreak;
    this.#selfWakeStreak += 1;
    this.storage.writeSelfWakeStreak(this.#selfWakeStreak);
    return {
      streak: this.#selfWakeStreak,
      justHalted: this.selfWakeHalted() && before < SELF_WAKE_HALT_STREAK,
    };
  }

  /** A real request: the loop is broken, so reset the streak and lift the halt. NO write when
   *  already zero, so the common request path pays nothing. */
  notePublicDoor(): void {
    if (this.#selfWakeStreak === 0) return;
    this.#selfWakeStreak = 0;
    this.storage.writeSelfWakeStreak(0);
  }
}

// ── stream storage ── THE STREAM'S TABLES, typed: every SQL statement the stream runs lives here,
// over the ONE platform handle — `ctx.storage.sql`, `transactionSync` and `setAlarm`. Workerd's kv
// is itself a SQLite table, so the stream keeps none of its own: the whole seam is SQL, and a
// node:sqlite stand-in satisfies it in a screen (test-support.ts `nodeSqliteDurableObjectStorage`).
//
//   events                offset · body · idempotency_key   one row per durable event
//   event_chunks          offset · chunk_index · chunk      a body over EVENT_CHUNK_SIZE, sliced —
//                         the events row keeps an EMPTY body as the chunked marker (a real body is
//                         never empty JSON); reads and the idempotency lookup reassemble it
//   stream_meta           key · value                       the incarnation counter, the self-wake streak
//   subscription_cursors  name · cursor (JSON)              the delivery loop's at-least-once cursors
//   reduce_checkpoints    ReduceCheckpointTable (processor.ts) the core reduce's checkpoint (a facet host
//                                                           keeps its own, in its own storage)

/** The slice of `DurableObjectStorage` the stream drives, spelled structurally so a node:sqlite
 *  stand-in satisfies it; the DO passes its whole `ctx.storage`. */
export type DurableObjectStorageSlice = {
  sql: SqlStorageHandle;
  transactionSync<T>(closure: () => T): T;
  setAlarm(scheduledTime: number | Date): Promise<void>;
};

/** A serialized body longer than this (chars) is split across `event_chunks` rows instead of one
 *  SQLite TEXT cell (which caps around 2MB — SQLITE_TOOBIG). 512KiB matches apps/os; a body at or
 *  under it stays single-cell (the fast path — no chunk join on read). */
const EVENT_CHUNK_SIZE = 512 * 1024;

/** THE cursor of a subscription the stream delivers at-least-once (subscription-delivery.ts): the
 *  offset an acked call confirmed, the ladder attempt, when the next attempt is due, and the
 *  offset of the delivery-resumed fact already applied (so a resume applies exactly once). */
export type SubscriptionCursor = {
  confirmedOffset: number;
  attempt: number;
  nextAttemptAtMs?: number;
  resumeAppliedAtOffset?: number;
};

/** One durable row as stored: its offset and its serialized body, reassembled. */
export type StoredEventRow = { offset: number; body: string };

class StreamStorage {
  readonly #storage: DurableObjectStorageSlice;
  readonly #sql: SqlStorageHandle;
  /** The core reduce's checkpoint (processor.ts `ReduceCheckpointTable`), in this store. */
  readonly reduceCheckpoints: ReduceCheckpointTable;
  /** This incarnation's number — the counter in `stream_meta`, bumped here: constructing the
   *  storage IS an incarnation starting. Growth across idle ⇒ the actor hibernated. */
  readonly incarnation: number;

  constructor(storage: DurableObjectStorageSlice) {
    this.#storage = storage;
    this.#sql = storage.sql;
    // The tables ONLY on a virgin store: a store with an incarnation was opened by a prior one and
    // already has them (they are never dropped) — skipping four CREATEs on every re-wake saves
    // their prepare+parse. `stream_meta` is the one CREATE that always runs: it holds the answer.
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS stream_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const prior = this.#sql
      .exec<{ value: string }>("SELECT value FROM stream_meta WHERE key = 'incarnation'")
      .toArray()[0];
    if (!prior) {
      this.#sql.exec(
        `CREATE TABLE IF NOT EXISTS events (
           offset INTEGER PRIMARY KEY,
           body TEXT NOT NULL,
           idempotency_key TEXT UNIQUE
         )`,
      );
      this.#sql.exec(
        `CREATE TABLE IF NOT EXISTS event_chunks (
           offset INTEGER NOT NULL,
           chunk_index INTEGER NOT NULL,
           chunk TEXT NOT NULL,
           PRIMARY KEY (offset, chunk_index)
         )`,
      );
      this.#sql.exec(
        "CREATE TABLE IF NOT EXISTS subscription_cursors (name TEXT PRIMARY KEY, cursor TEXT NOT NULL)",
      );
      ReduceCheckpointTable.createTable(this.#sql);
    }
    this.reduceCheckpoints = new ReduceCheckpointTable(this.#sql, { createTable: false });
    this.incarnation = (prior ? Number(prior.value) : 0) + 1;
    this.#sql.exec(
      "INSERT OR REPLACE INTO stream_meta (key, value) VALUES ('incarnation', ?)",
      String(this.incarnation),
    );
  }

  transactionSync<T>(closure: () => T): T {
    return this.#storage.transactionSync(closure);
  }

  setAlarm(atMs: number): Promise<void> {
    return this.#storage.setAlarm(atMs);
  }

  /** The self-wake streak (stream.ts SELF_WAKE_HALT_STREAK): one `stream_meta` row, read once at
   *  construction and written only when it MOVES, so normal request operation pays no extra write. */
  readSelfWakeStreak(): number {
    const row = this.#sql
      .exec<{ value: string }>("SELECT value FROM stream_meta WHERE key = 'selfWakeStreak'")
      .toArray()[0];
    return row ? Number(row.value) : 0;
  }
  writeSelfWakeStreak(streak: number): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO stream_meta (key, value) VALUES ('selfWakeStreak', ?)",
      String(streak),
    );
  }

  /** The highest offset in the log — 0 on an empty one. The stream's constructor reads it once: a
   *  log with rows but no core checkpoint is not a store this code wrote. */
  highestEventOffset(): number {
    const row = this.#sql
      .exec<{ offset: number | null }>("SELECT MAX(offset) AS offset FROM events")
      .toArray()[0];
    return row?.offset === null || row?.offset === undefined ? 0 : Number(row.offset);
  }

  /** Insert one durable row (inside the caller's transaction). A body over EVENT_CHUNK_SIZE rides
   *  `event_chunks` behind an empty marker cell, and a cut NEVER splits a UTF-16 surrogate PAIR
   *  across two cells: a lone surrogate becomes U+FFFD on the SQLite TEXT bind, silently corrupting
   *  the body — if the cut lands right after a high surrogate, it keeps the low half with it. */
  insertEvent(offset: number, serializedBody: string, idempotencyKey: string | null): void {
    if (serializedBody.length <= EVENT_CHUNK_SIZE) {
      this.#sql.exec(
        "INSERT INTO events (offset, body, idempotency_key) VALUES (?, ?, ?)",
        offset,
        serializedBody,
        idempotencyKey,
      );
      return;
    }
    this.#sql.exec(
      "INSERT INTO events (offset, body, idempotency_key) VALUES (?, '', ?)",
      offset,
      idempotencyKey,
    );
    for (let start = 0, idx = 0; start < serializedBody.length; idx++) {
      let end = Math.min(start + EVENT_CHUNK_SIZE, serializedBody.length);
      if (end < serializedBody.length) {
        const c = serializedBody.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end -= 1;
      }
      this.#sql.exec(
        "INSERT INTO event_chunks (offset, chunk_index, chunk) VALUES (?, ?, ?)",
        offset,
        idx,
        serializedBody.slice(start, end),
      );
      start = end;
    }
  }

  /** The row under an idempotency key, body reassembled — the dedupe lookup. */
  readEventByIdempotencyKey(idempotencyKey: string): StoredEventRow | undefined {
    const row = this.#sql
      .exec<{ offset: number; body: string }>(
        "SELECT offset, body FROM events WHERE idempotency_key = ?",
        idempotencyKey,
      )
      .toArray()[0];
    if (!row) return undefined;
    const offset = Number(row.offset);
    return { offset, body: this.#reassembleBody(offset, String(row.body)) };
  }

  /** The rows after `afterOffset`: at most `limit`, and at most `budgetBytes` of bodies as SQLite
   *  counts them (UTF-8). The cursor is ITERATED and each row's size comes back with it, so no body
   *  is built and then dropped; a page always carries ≥ 1 row. `nextRowDidNotFit` says the budget,
   *  not the log, ended the page. */
  readEventPage(
    afterOffset: number,
    limit: number,
    budgetBytes: number,
  ): { rows: StoredEventRow[]; nextRowDidNotFit: boolean } {
    const rows: StoredEventRow[] = [];
    let pageBytes = 0;
    for (const row of this.#sql.exec<{ offset: number; body: string; body_bytes: number }>(
      `SELECT offset, body,
              length(CAST(body AS BLOB)) + COALESCE((SELECT SUM(length(CAST(chunk AS BLOB)))
                FROM event_chunks WHERE event_chunks.offset = events.offset), 0) AS body_bytes
         FROM events WHERE offset > ? ORDER BY offset LIMIT ?`,
      afterOffset,
      limit,
    )) {
      if (rows.length > 0 && pageBytes + Number(row.body_bytes) > budgetBytes)
        return { rows, nextRowDidNotFit: true }; // the cursor is left undrained (workerd frees the statement with it)
      pageBytes += Number(row.body_bytes);
      const offset = Number(row.offset);
      rows.push({ offset, body: this.#reassembleBody(offset, String(row.body)) });
    }
    return { rows, nextRowDidNotFit: false };
  }

  listSubscriptionCursors(): [name: string, cursor: SubscriptionCursor][] {
    return this.#sql
      .exec<{ name: string; cursor: string }>("SELECT name, cursor FROM subscription_cursors")
      .toArray()
      .map((row) => [String(row.name), JSON.parse(String(row.cursor)) as SubscriptionCursor]);
  }

  writeSubscriptionCursor(name: string, cursor: SubscriptionCursor): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO subscription_cursors (name, cursor) VALUES (?, ?)",
      name,
      JSON.stringify(cursor),
    );
  }

  deleteSubscriptionCursor(name: string): void {
    this.#sql.exec("DELETE FROM subscription_cursors WHERE name = ?", name);
  }

  /** An EMPTY cell is the chunked marker (a real body is never empty JSON); otherwise the cell IS the body. */
  #reassembleBody(offset: number, cell: string): string {
    if (cell !== "") return cell;
    return this.#sql
      .exec<{ chunk: string }>(
        "SELECT chunk FROM event_chunks WHERE offset = ? ORDER BY chunk_index",
        offset,
      )
      .toArray()
      .map((r) => String(r.chunk))
      .join("");
  }
}

/** A CONTEXT reachable over the wire — what `itx.cd('/x')` routes through. Named with the REAL
 *  event types and Promise-returning throughout, so every backing satisfies it structurally with
 *  ZERO casts: the IterateContextDurableObject itself (its own path hands `this`), a sibling
 *  `DurableObjectStub<IterateContextDurableObject>`, an off-platform `RpcTarget` over capnweb. */
export interface ReachableContext {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(afterOffset?: number, limit?: number): Promise<StreamPage>;
  /** THE dispatch door. `caller` (WHO is calling) is what a `cd(path)` hop carries across to a
   *  sibling — the same identity, so a sibling append is attributed too; `args` are the expression's
   *  positional args. Both optional, so a bare `invoke(call)` is an anonymous probe. */
  invoke(
    call: ItxExpressionInput,
    args?: unknown[],
    caller?: { principal: { actor: string; email?: string } | null; scopes?: string[] },
  ): Promise<unknown>;
}
