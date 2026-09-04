// stream/stream.ts — THE STREAM, a simple dependency-injected JS class:
// SQLite rows (stream-storage.ts, the typed tables) + one durable mark (the core checkpoint's
// offset), idempotency at the door, one shared offset sequence,
// chunked large bodies, the append validation + the pause check, the wake record, waitForEvent, and
// the alarm armer — and THE CORE REDUCE (`coreReducedState`), the stream's own state reduced inside every
// commit. The DurableObject holds a `Stream` and drives it; the one thing the stream needs from its
// host is `onCommit` (the post-commit fan-out), so nothing here reaches back into the DO.
//
// EPHEMERALS COST ZERO WRITES. An ephemeral event takes an offset from the shared sequence but is
// never stored — and an ephemeral-only batch touches storage NOT AT ALL: no row, no transaction, not
// even the high-water mark. Its offsets live in this incarnation's memory. The consequence is the
// one contract every offset-keyed consumer already honours: an ephemeral's offset is unique WITHIN
// an incarnation, and a later incarnation — which resumes from the last DURABLE mark — may hand the
// same number to a durable. Every persisted checkpoint in this package advances only on a batch
// that carried a durable (the processor engine, the core reduce, the subscription cursors), and
// such a batch's high-water mark is committed with it, so no durable is ever skipped; the
// `stream/woken` record, the first event of each incarnation (Stream.appendCreatedAndWokenEvents), marks the boundary for
// anyone chaining ranges across it. And `read()` never PROVES a scan beyond the durable mark: a
// short page's `scannedThroughOffset` is the mark, not the in-memory head — so nothing a reader
// persists (a facet's checkpoint, a subscription cursor) can name an offset a later incarnation
// could hand to a durable. Pushes still carry the full head in their ranges; only the log's own
// proof is capped.
//
// Every context that is ever reached holds at least its birth certificate and a wake record: the DO
// constructor calls `appendCreatedAndWokenEvents()` before any door opens (the apps/os shape), so a probe on a never-seen
// context materializes it — deliberately; what is worth reaching is worth recording.
//
// The CONTEXT seam (`interface ReachableContext` + `localContext`) lives at the bottom: what one context
// reaches another THROUGH, uniform-async and REAL-typed.

import { codedError, reportIssue } from "../lib/errors.ts";
import type { ItxExpressionInput } from "../context/expression.ts";
import { CoreStreamProcessor, type CoreState } from "./core-processor.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./events.ts";
import { LiveState } from "./live-state.ts";
import { consumesEvent } from "./processor.ts";
import { StreamStorage, type DurableObjectStorageSlice } from "./stream-storage.ts";

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
export const EVENT_BODY_MAX_CHARS = 8 * 1024 * 1024;
/** THE READ BUDGET, in UTF-8 bytes as SQLite counts them (≥ JS chars): a page stops BEFORE the row
 *  that would cross it and always carries ≥ 1 row, so the largest legal event still rides alone.
 *  Every replay loop in the package pages through this budget. */
const READ_PAGE_BUDGET_BYTES = 8 * 1024 * 1024;
/** The most rows one page returns whatever `limit` asks — the object overhead of tiny events, which
 *  the byte budget cannot see. */
const READ_PAGE_MAX_EVENTS = 1000;

/** The waitForEvent selector: `type` is an exact event-type match (absent = any type); only events
 *  with offset strictly greater than `afterOffset` match (default = the head at call time — "the
 *  next occurrence"; history-inclusive waits pass an explicit afterOffset); `timeoutMs` defaults to
 *  30s, capped at 120s, and expiry rejects with codedError("WAIT_TIMEOUT", …). */
export type WaitForEventFilter = { type?: string; afterOffset?: number; timeoutMs?: number };

/** One waiting waitForEvent caller: its filter, the promise ends, and the timeout timer. In-memory
 *  only — an eviction drops waiters, and that is FINE: the caller's own open RPC call keeps the DO
 *  awake for the wait's duration anyway, and a dropped waiter surfaces as the transport error the
 *  caller already handles. */
type WaitForEventWaiter = {
  type: string | undefined;
  afterOffset: number;
  resolve: (event: StreamEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Everything the stream needs from its host, enumerated (see the header). */
interface StreamDeps {
  /** The DO's storage handle — sync SQLite, the sync transaction, the alarm (the DO passes its
   *  whole `ctx.storage`; stream-storage.ts types the tables over it). */
  storage: DurableObjectStorageSlice;
  /** Idempotency-scope / logging identity — the event-identity stamp on every StreamEvent. */
  path: string;
  /** Who this stream belongs to — the birth certificate's payload (`wake`). */
  projectId: string;
  /** The post-commit fan-out, called once per offset-advancing commit with `freshEvents` — the
   *  newly committed events in offset order, ephemerals included (the host's delivery loop; the
   *  waitForEvent waiters settle before it). */
  onCommit: (freshEvents: StreamEvent[], afterOffset: number, throughOffset: number) => void;
}

/** THE STREAM — the commit point: SQLite rows + ONE durable mark, idempotency at the door,
 *  offsets assigned from one shared sequence (ephemeral events consume offsets, never rows — after
 *  a reboot their offsets survive as valid gaps), and THE CORE REDUCE (core-processor.ts) reduced
 *  inside every commit: the stream's own state — who it is, its incarnation, pause, rewrite rules,
 *  subscriptions — checkpointed with the rows it was reduced from. A body over EVENT_CHUNK_SIZE is
 *  chunked into `event_chunks` rows keyed (offset, chunk_index) — INVISIBLE to the events table, so a
 *  chunked event is still ONE row at ONE offset; reads and idempotency-dedupe reassemble it. */
export class Stream {
  /** THE TABLES (stream-storage.ts) — the delivery loop keeps its cursors through here too. */
  readonly storage: StreamStorage;
  readonly #path: string;
  readonly #projectId: string;
  readonly #onCommit: StreamDeps["onCommit"];
  /** This incarnation's number — the `stream_meta` counter, bumped by the storage's constructor; growth across idle ⇒ it hibernated. */
  readonly #incarnation: number;
  /** The highest offset assigned THIS INCARNATION — ephemerals included. Seeded from the durable
   *  mark; an ephemeral-only batch advances this alone (an ephemeral's offset is unique within an
   *  incarnation and may be reused by the next one — see the header). */
  #highestAssignedOffset: number;
  /** The DURABLE head as of the last COMMITTED durable batch — the core reduce's cursor offset
   *  (the core checkpoint's offset, written every durable commit; there is no separate mark).
   *  What `read()` proves a scan through, what the core reduce has reduced to, and what a
   *  resume's seek is clamped to — never the in-memory head above. */
  #highestDurableOffset: number;
  /** FIFO; resolved from `freshEvents` in append's step 5. */
  readonly #waitForEventWaiters: WaitForEventWaiter[] = [];
  #alarmArmedForMs: number | null = null;

  // ── THE CORE REDUCE: the stream's own state (core-processor.ts), event-sourced from its own log.
  // The processor is a pure reduce; the REDUCED STATE lives here — rehydrated by the constructor from
  // the versioned checkpoint (reduce-checkpoint.ts) and caught up to the durable mark, reduced inside
  // every durable commit and checkpointed with it (the cursor every batch, the state on change),
  // published as a live-state delta after the commit. Durable events only, so it rebuilds
  // bit-identically. ──
  readonly #coreProcessor = new CoreStreamProcessor();
  #coreReducedState: CoreState;
  #coreReducedThroughOffset: number;
  /** ONE LiveState holder for the core reduced state, born with the stream over the rehydrated state
   *  (`payload.key` = "core"); every commit that changed the state publishes a delta from it. */
  readonly #coreLiveState: LiveState<CoreState>;

  constructor(deps: StreamDeps) {
    this.storage = new StreamStorage(deps.storage);
    this.#path = deps.path;
    this.#projectId = deps.projectId;
    this.#onCommit = deps.onCommit;
    this.#incarnation = this.storage.incarnation;
    // THE DURABLE HEAD is the core checkpoint's offset — written every durable commit anyway (the
    // reduce inside the transaction below), so there is no separate mark to write. Read WHATEVER
    // version wrote it: a core-version bump still recovers the head and re-reduces the log up to it.
    const { contract } = this.#coreProcessor;
    const checkpoint = this.storage.reduceCheckpoints.read<CoreState>(contract.slug);
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
    // The core reduced state. Its checkpoint is written in the SAME synchronous transaction as the
    // rows it was reduced from, so after any commit the two cannot disagree; it is only ever ABSENT
    // on a store with no commits (mark 0, nothing to reduce) or written under ANOTHER contract
    // version — then the durable log is re-reduced from offset 0, the one-time cost of a version bump.
    if (checkpoint?.reducerVersion === contract.version) {
      this.#coreReducedState = checkpoint.state ?? contract.initialState();
      this.#coreReducedThroughOffset = checkpoint.reducedThroughOffset;
    } else {
      this.#coreReducedState = contract.initialState();
      this.#coreReducedThroughOffset = 0;
      // Budgeted pages (READ_PAGE_BUDGET_CHARS): this runs in the DO constructor, where a page that
      // did not fit the isolate would be a reboot loop — every wake re-running the same re-reduce.
      while (this.#coreReducedThroughOffset < this.#highestDurableOffset) {
        const page = this.read(this.#coreReducedThroughOffset, 500);
        for (const event of page.events)
          this.#coreReducedState = this.#reduceEventIntoCoreReducedState(
            event,
            this.#coreReducedState,
          );
        if (page.scannedThroughOffset <= this.#coreReducedThroughOffset) break; // nothing left
        this.#coreReducedThroughOffset = page.scannedThroughOffset;
      }
    }
    this.#coreLiveState = new LiveState(
      { append: (event) => this.append(event) },
      contract.slug,
      this.#coreReducedState,
    );
  }

  /** THE WAKE RECORD — the DO constructor calls this, synchronously, before any door opens (the
   *  apps/os shape). The first incarnation ever appends `stream/created { projectId, path }` — offset
   *  1, the birth certificate — and every incarnation appends `stream/woken { incarnation }`, so the
   *  core reduce knows who it is and which incarnation runs before the first append, read or facet
   *  call. Both are exempt from pause: a paused stream still records its wake. */
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
      { type: "events.iterate.com/stream/woken", payload: { incarnation: this.#incarnation } },
    );
  }

  currentIncarnation(): number {
    return this.#incarnation;
  }

  highestAssignedOffset(): number {
    return this.#highestAssignedOffset;
  }

  /** 0 on a store that never held a durable row. Ephemeral offsets above it exist only in this
   *  incarnation's memory. */
  highestDurableOffset(): number {
    return this.#highestDurableOffset;
  }

  /** The core reduced state, current as of the last commit: who this context is, its incarnation,
   *  pause, the rewrite rules, the subscription rows. What the append door, the dispatcher and the
   *  delivery loop read — synchronously. */
  get coreReducedState(): CoreState {
    return this.#coreReducedState;
  }

  /** `{ offset, state }` — the `itx.facets.get('core').snapshot()` door. */
  coreReducedStateSnapshot(): { offset: number; state: CoreState } {
    return { offset: this.#coreReducedThroughOffset, state: this.#coreReducedState };
  }

  /** The live-state SEED — `{ rev, state }` in step with the deltas the holder emits (the same door a
   *  facet processor's `liveSnapshot()` is). */
  coreLiveStateSnapshot(): { rev: number; state: CoreState } {
    return this.#coreLiveState.snapshot();
  }

  // ── APPEND: the commit pipeline, top to bottom ──

  /** Commit a batch. Synchronous end to end (sync SQLite), so the steps never interleave:
   *
   *    1. MAY THIS LAND?  well-formed · not paused
   *    2. OFFSETS         idempotency (dedupe or refuse) · expected offsets · one shared sequence,
   *                       ephemerals included — decided in memory, nothing written yet
   *    3 + 4. REDUCE + COMMIT   rows + the high-water mark + the core reduce with its checkpoint, ONE
   *                             transaction (an ephemeral-only batch skips this entirely: zero SQL)
   *    5. AFTER           waiters, then the host's fan-out (every subscriber), then core's live delta
   *
   *  Every refusal happens before a single write. The two marks are advanced only AFTER the
   *  transaction returns, so a throw leaves them true. */
  append(...events: StreamEventInput[]): StreamEvent[] {
    if (events.length === 0) return []; // a pure no-op: nothing checked, minted, or fanned out
    // 1. may this land? — the shape first (this runtime check is the SOLE enforcement; there is no
    //    boundary validator): a non-blank type. (An ephemeral's idempotencyKey is simply never
    //    stored — ephemerals never reach the idempotency column.)
    for (const event of events)
      if (typeof event.type !== "string" || event.type.trim() === "")
        throw new Error("append: every event needs a non-empty type");
    //    then the pause: a paused stream refuses everything except the platform's own records and
    //    the pause/resume pair itself (it must always accept its own resume)
    const paused = this.#coreReducedState.paused;
    if (paused) {
      const exempt = [
        "events.iterate.com/stream/created",
        "events.iterate.com/stream/woken",
        "events.iterate.com/stream/paused",
        "events.iterate.com/stream/resumed",
      ];
      if (events.some((event) => !exempt.includes(event.type)))
        throw codedError("STREAM_PAUSED", `stream paused: ${paused.reason}`);
    }
    // 2. offsets — decided in memory, nothing written yet
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
          // the stored body is the event as appended plus createdAt — the row carries the offset,
          // the stream is the path
          const { offset: _offset, path: _path, ...eventBody } = event;
          const serializedBody = JSON.stringify(eventBody);
          // THE APPEND CEILING (EVENT_BODY_MAX_CHARS). The transaction rolls back and the marks are
          // locals until it commits: nothing written, no offset burned. Ephemerals are never
          // stored, so they are not measured — the pending-push budget bounds them in delivery.
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
        // The core reduce takes this batch's durables and checkpoints with them: the cursor every
        // batch IS the durable head (read back as such at construction — one write, not two), the
        // reduced state on change.
        // Reduced into a LOCAL: the fields move only after the transaction commits, so a failed
        // write never leaves phantom core state in memory (a subscription row the log never got).
        const { contract } = this.#coreProcessor;
        for (const event of freshEvents)
          reducedState = this.#reduceEventIntoCoreReducedState(event, reducedState);
        this.storage.reduceCheckpoints.write(
          contract.slug,
          { reducerVersion: contract.version, reducedThroughOffset: throughOffset },
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
    // Core's live-state delta, when this commit changed the reduced state: `set` mints the standard
    // ephemeral live-state/changed delta through this stream's own append (a nested commit). LOSSY BY
    // CONTRACT — LiveState.set contains every refusal (a PAUSED stream refuses the delta) as a
    // revision-chain gap the client heals by re-seeding. No feedback loop: the delta is ephemeral and
    // changes no core state; the flag is cleared BEFORE the set, so the nested commit's own step 5
    // finds nothing left.
    if (coreReducedStateChanged) this.#coreLiveState.set(this.#coreReducedState);
    return committedEvents;
  }

  /** Reduce one durable event into the core reduced state — the commit and the constructor's
   *  version-bump re-reduce both come here. A malformed control event must not wedge the stream:
   *  record the skip, move on. */
  #reduceEventIntoCoreReducedState(event: StreamEvent, state: CoreState): CoreState {
    if (event.ephemeral || !consumesEvent(this.#coreProcessor.contract.consumes, event))
      return state;
    try {
      return this.#coreProcessor.reduce({ event, state }) ?? state;
    } catch (err) {
      reportIssue("stream.core-reduce", err, { offset: event.offset, type: event.type });
      return state;
    }
  }

  /** One page after `afterOffset`: at most `limit` rows AND at most READ_PAGE_BUDGET_BYTES of
   *  bodies (stream-storage.ts pages the cursor) — the SERVER decides the page; `limit` only shrinks it. */
  read(afterOffset = 0, limit = 500): StreamPage {
    limit = Math.min(Math.max(1, limit), READ_PAGE_MAX_EVENTS); // limit 0 crashed the cut check (userspace-reachable)
    const { rows, nextRowDidNotFit } = this.storage.readEventPage(
      afterOffset,
      limit,
      READ_PAGE_BUDGET_BYTES,
    );
    // Chunk rows never enter a page, so it counts EVENTS and its scannedThroughOffset is an event
    // offset — never a chunk boundary.
    const events: StreamEvent[] = rows.map((row) => ({
      ...(JSON.parse(row.body) as StreamEventInput & { createdAt: string }),
      offset: row.offset,
      path: this.#path,
    }));
    // The scanned-offset-range proof: a CUT page (by `limit` or by the budget) is only contiguously
    // known through its last row; a complete page proves the read scanned the whole DURABLE log —
    // through the durable mark, never the in-memory head (ephemeral offsets die with the
    // incarnation and may be handed to durables by the next one; a proof naming one would let a
    // persisted checkpoint skip those durables — the zero-write contract in the header).
    // At head: the scan ran out of rows (a short page), or the page's last row IS the durable mark
    // (an exact-`limit` page at the head must say so — rule 5's caught-up pass rides it).
    const highestDurableOffset = this.highestDurableOffset();
    const lastOffset = events.length ? events[events.length - 1].offset : afterOffset;
    const atHead =
      !nextRowDidNotFit && (events.length < limit || lastOffset >= highestDurableOffset);
    return {
      events,
      scannedThroughOffset: atHead ? highestDurableOffset : lastOffset,
      atHead,
    };
  }

  /** Resolve with the next event matching `filter` — or the first COMMITTED durable match already
   *  in the log after `filter.afterOffset` (explicitly passed; the default is the head at call
   *  time, so a bare wait means "the next occurrence" — reading history is what read() is for).
   *
   *  CHECK-AND-WAIT IS ONE SYNCHRONOUS SLICE: zero awaits between the log scan and waiter
   *  registration (read is sync; an await there would lose a racing commit → spurious
   *  WAIT_TIMEOUT). The initial scan PAGES read() to the head; it rides read()
   *  and writes nothing of its own (the constructor already appended created/woken). Waiters
   *  are fed from `freshEvents` in append's tail, so EPHEMERAL events resolve waits too (they ride the
   *  fan-out — always-an-event — but are only catchable while a waiter is registered, since they
   *  never hit the log). Multiple waiters settle FIFO per event; one event can resolve many waiters; a waiter
   *  resolves once, with its first matching event in offset order. */
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
        afterOffset,
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

  /** Settle every waiter the fresh events match (a Promise's own `resolve` cannot throw). */
  #resolveWaitForEventWaiters(freshEvents: StreamEvent[]): void {
    for (const event of freshEvents) {
      if (this.#waitForEventWaiters.length === 0) return;
      for (const w of [...this.#waitForEventWaiters]) {
        if ((w.type !== undefined && event.type !== w.type) || event.offset <= w.afterOffset)
          continue;
        this.#waitForEventWaiters.splice(this.#waitForEventWaiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(event);
      }
    }
  }

  // ── the alarm armer ──

  /** ONE alarm write per quiet-period start, never per append (an ephemeral flood arms once).
   *  Memo-only: a fresh incarnation writes one redundant setAlarm and a later target may overwrite
   *  an earlier one, which is safe because every alarm() pass re-derives its obligations and
   *  re-arms. */
  armAlarmNoLaterThan(atMs: number): void {
    if (this.#alarmArmedForMs !== null && this.#alarmArmedForMs <= atMs) return;
    this.#alarmArmedForMs = atMs;
    // Not awaited: the native output gate owns the write and turns an async failure into an
    // invocation failure — and a lost memo just re-arms on the next alarm() pass.
    void this.storage.setAlarm(atMs);
  }

  noteAlarmFired(): void {
    this.#alarmArmedForMs = null;
  }
}

// ── THE STREAM / CONTEXT SEAM, uniform-async and REAL-typed ──
//
// What one context reaches another THROUGH — a sibling by name, or the own-path parent. Naming it
// with the REAL event types (StreamEventInput / StreamEvent / StreamPage) and making the whole
// surface Promise-returning is what lets every backing satisfy it with ZERO casts:
//   • a sibling `DurableObjectStub<IterateContextDurableObject>` — Workers-RPC methods already return
//     Promises of these exact types, so it IS a ReachableContext structurally (no `as unknown as`);
//   • the own parent — `localContext(this)`, whose only wrap is `read` (sync on the class, async
//     on the wire — one microtask on a path that then does real I/O anyway);
//   • an off-platform Pi — its `RpcTarget` returns Promises over capnweb.

/** A CONTEXT reachable over the wire: the stream verbs (append/read), plus `invoke` for capability
 *  dispatch. This is what `itx.cd('/x')` routes through and what `deps.context(path)`
 *  returns. The IterateContextDurableObject is one; a sibling DO stub and the own-path adapter satisfy it. */
export interface ReachableContext {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(afterOffset?: number, limit?: number): Promise<StreamPage>;
  invoke(call: ItxExpressionInput): Promise<unknown>;
}

/** The own IterateContextDurableObject (same isolate) as a uniform-async ReachableContext. The ONLY wrap is `read`
 *  (sync on the class, async on the seam); `append` and `invoke` are already async. Built once per
 *  DO, never per call. */
export function localReachableContext(self: {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(afterOffset?: number, limit?: number): StreamPage;
  invoke(call: ItxExpressionInput): Promise<unknown>;
}): ReachableContext {
  return {
    append: (...events) => self.append(...events),
    read: async (afterOffset, limit) => self.read(afterOffset, limit),
    invoke: (call) => self.invoke(call),
  };
}
