// stream/stream.ts — THE STREAM, a simple dependency-injected JS class:
// SQLite rows + one kv high-water mark, idempotency at the door, one shared offset sequence,
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
// The CONTEXT seam (`interface Context` + `localContext`) lives at the bottom: what one context
// reaches another THROUGH, uniform-async and REAL-typed.

import { codedError, reportIssue } from "../lib/errors.ts";
import type { ItxExpression } from "../context/expression.ts";
import { CoreStreamProcessor, type CoreState } from "./core-processor.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./events.ts";
import { LiveState } from "./live-state.ts";
import { consumesEvent } from "./processor.ts";
import { readReduceCheckpoint, writeReduceCheckpoint } from "./reduce-checkpoint.ts";

/** One page of the log: the events after an offset, plus how far the scan reached (the range a
 *  client chains for contiguity). Structurally identical to IterateContextDurableObject.read's return. */
export interface StreamPage {
  events: StreamEvent[];
  scannedThroughOffset: number;
}

/** A serialized body longer than this (JSON string chars) is split across `event_chunks` rows
 *  instead of one SQLite TEXT cell (which caps around 2MB — SQLITE_TOOBIG). 512KiB matches apps/os;
 *  a body at or under it stays single-cell (the fast path — no chunk join on read). */
const EVENT_CHUNK_SIZE = 512 * 1024;

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
  /** The DO's sqlite + kv + alarms — the ONE platform handle. */
  storage: DurableObjectStorage;
  /** Idempotency-scope / logging identity — the event-identity stamp on every StreamEvent. */
  path: string;
  /** Who this stream belongs to — the birth certificate's payload (`wake`). */
  projectId: string;
  /** The post-commit fan-out, called once per offset-advancing commit with `freshEvents` — the
   *  newly committed events in offset order, ephemerals included (the host's delivery loop; the
   *  waitForEvent waiters settle before it). */
  onCommit: (freshEvents: StreamEvent[], afterOffset: number, nextOffset: number) => void;
}

/** THE STREAM — the commit point: SQLite rows + ONE kv high-water mark, idempotency at the door,
 *  offsets assigned from one shared sequence (ephemeral events consume offsets, never rows — after
 *  a reboot their offsets survive as valid gaps), and THE CORE REDUCE (core-processor.ts) reduced
 *  inside every commit: the stream's own state — who it is, its incarnation, pause, mounts,
 *  subscriptions — checkpointed with the rows it was reduced from. A body over EVENT_CHUNK_SIZE is
 *  chunked into `event_chunks` rows keyed (offset, chunk_index) — INVISIBLE to the events table, so a
 *  chunked event is still ONE row at ONE offset; reads and idempotency-dedupe reassemble it. */
export class Stream {
  readonly #storage: DurableObjectStorage;
  readonly #path: string;
  readonly #projectId: string;
  readonly #onCommit: StreamDeps["onCommit"];
  /** This incarnation's number — the kv counter, bumped by the constructor; growth across idle ⇒ it hibernated. */
  readonly #incarnation: number;
  /** The highest offset assigned THIS INCARNATION — ephemerals included. Seeded from the durable
   *  mark; an ephemeral-only batch advances this alone (an ephemeral's offset is unique within an
   *  incarnation and may be reused by the next one — see the header). */
  #highestAssignedOffset: number;
  /** The kv high-water mark (`maxAssignedOffset`) as of the last COMMITTED durable batch: the
   *  DURABLE head. What `read()` proves a scan through, what the core reduce has reduced to, and what
   *  a resume's seek is clamped to — never the in-memory head above. */
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
  /** ONE LiveState holder, born at the first durable commit SEEDED WITH THE PRE-BATCH STATE so the
   *  first publish diffs exactly what that batch changed (`payload.key` = "core"). */
  #coreLiveState?: LiveState<CoreState>;
  #coreReducedStateChangedAtCommit = false;

  constructor(deps: StreamDeps) {
    this.#storage = deps.storage;
    this.#path = deps.path;
    this.#projectId = deps.projectId;
    this.#onCommit = deps.onCommit;
    // Storage opens HERE, synchronously (sync SQLite, the DO constructor's own turn): the two
    // tables if this store has none, and this incarnation's number — constructing the stream IS an
    // incarnation starting.
    this.#storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
         offset INTEGER PRIMARY KEY,
         body TEXT NOT NULL,
         idempotency_key TEXT UNIQUE
       )`,
    );
    // Overflow rows for a large body: the events row keeps an EMPTY body as the "chunked" marker
    // (a real body is always non-empty JSON), and the pieces live here, ordered by chunk_index.
    this.#storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS event_chunks (
         offset INTEGER NOT NULL,
         chunk_index INTEGER NOT NULL,
         chunk TEXT NOT NULL,
         PRIMARY KEY (offset, chunk_index)
       )`,
    );
    this.#incarnation = ((this.#storage.kv.get("incarnation") as number | undefined) ?? 0) + 1;
    this.#storage.kv.put("incarnation", this.#incarnation);
    this.#highestDurableOffset =
      (this.#storage.kv.get("maxAssignedOffset") as number | undefined) ?? 0;
    this.#highestAssignedOffset = this.#highestDurableOffset;
    // The core reduced state. Its checkpoint is written in the SAME synchronous transaction as the
    // rows it was reduced from (SQLite storage writes in one synchronous block are one atomic
    // implicit transaction; ours is an explicit one), so after any commit the two cannot disagree.
    // A checkpoint is therefore only ever ABSENT on a store with no commits (mark 0, nothing to
    // reduce) or DISCARDED because the contract's version changed — then the durable log is
    // re-reduced from offset 0, the one-time cost of a version bump.
    const { contract } = this.#coreProcessor;
    const checkpoint = readReduceCheckpoint<CoreState>(
      this.#storage.kv,
      contract.slug,
      contract.version,
      () => contract.initialState(),
    );
    if (checkpoint) {
      this.#coreReducedState = checkpoint.state;
      this.#coreReducedThroughOffset = checkpoint.reducedThroughOffset;
    } else {
      this.#coreReducedState = contract.initialState();
      this.#coreReducedThroughOffset = 0;
      while (this.#coreReducedThroughOffset < this.#highestDurableOffset) {
        const page = this.read(this.#coreReducedThroughOffset, 500);
        for (const event of page.events) this.#reduceEventIntoCoreReducedState(event);
        this.#coreReducedThroughOffset = page.scannedThroughOffset;
        if (page.events.length < 500) break;
      }
    }
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
   *  pause, the capability mounts, the subscription rows. What the append door, the dispatcher and the
   *  delivery loop read — synchronously. */
  get coreReducedState(): CoreState {
    return this.#coreReducedState;
  }

  /** `{ offset, state }` — the `itx.facets.get('core').snapshot()` door. */
  coreReducedStateSnapshot(): { offset: number; state: CoreState } {
    return { offset: this.#coreReducedThroughOffset, state: this.#coreReducedState };
  }

  /** The live-state SEED — `{ rev, state }` in step with the deltas the holder emits (the same door a
   *  facet processor's `liveSnapshot()` is). Before the first durable commit of an incarnation there
   *  is no holder yet: rev 0 over the current reduced state, which the first delta (`from: 0`) chains onto. */
  coreLiveStateSnapshot(): { rev: number; state: CoreState } {
    return this.#coreLiveState?.snapshot() ?? { rev: 0, state: this.#coreReducedState };
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
    //    boundary validator): a non-blank type; `ephemeral` literal true or absent (a `false` is a
    //    LOUD error, never a silent synonym for durable — every consumer tests truthiness); no
    //    idempotencyKey on an ephemeral (nothing idempotent about the unreplayable)
    for (const event of events) {
      if (typeof event.type !== "string" || event.type.trim() === "")
        throw new Error("append: every event needs a non-empty type");
      if ("ephemeral" in event && event.ephemeral !== undefined && event.ephemeral !== true)
        throw new Error(
          `append: ephemeral must be literal true or absent — got ${JSON.stringify(event.ephemeral)} on "${event.type}"`,
        );
      if (event.ephemeral && event.idempotencyKey)
        throw codedError(
          "EPHEMERAL_IDEMPOTENCY_KEY",
          "ephemeral events cannot carry an idempotencyKey — nothing idempotent about the unreplayable",
        );
    }
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
    const after = this.#highestAssignedOffset;
    const createdAt = new Date().toISOString();
    const committedEvents: StreamEvent[] = []; // one per appended event, in order (a dedupe hit echoes the existing event)
    const freshEvents: StreamEvent[] = []; // the events NEW to the log, in offset order — what commits, reduces, fans out
    const eventsByIdempotencyKey = new Map<string, StreamEvent>(); // keys landing earlier in THIS batch
    let nextOffset = after;
    for (const event of events) {
      const { offset: expectedOffset, ...eventInput } = event;
      // IDEMPOTENCY: a key already in the log (or earlier in this batch) answers with THAT event and
      // consumes no offset; a different body under the same key refuses the whole batch.
      let existingEvent = eventInput.idempotencyKey
        ? eventsByIdempotencyKey.get(eventInput.idempotencyKey)
        : undefined;
      if (eventInput.idempotencyKey && !existingEvent) {
        const row = this.#storage.sql
          .exec(
            "SELECT offset, body FROM events WHERE idempotency_key = ?",
            eventInput.idempotencyKey,
          )
          .toArray()[0];
        if (row)
          existingEvent = {
            ...(JSON.parse(
              this.#reassembleEventBodyFromChunks(Number(row.offset), String(row.body)),
            ) as object),
            offset: Number(row.offset),
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
        if (expectedOffset !== undefined && expectedOffset !== existingEvent.offset)
          throw codedError(
            "OFFSET_CONFLICT",
            `expected offset ${expectedOffset}, but "${eventInput.idempotencyKey}" already landed at ${existingEvent.offset}`,
            { expected: expectedOffset, actual: existingEvent.offset },
          );
        committedEvents.push(existingEvent);
        continue;
      }
      // EXPECTED OFFSET: an event carrying `offset` lands exactly there or the batch is refused —
      // "nothing has happened since I last looked" (apps/os's optimistic-concurrency shape).
      const offset = nextOffset + 1;
      if (expectedOffset !== undefined && expectedOffset !== offset)
        throw codedError(
          "OFFSET_CONFLICT",
          `expected offset ${expectedOffset}, but the next offset is ${offset}`,
          { expected: expectedOffset, actual: offset },
        );
      nextOffset = offset;
      const committedEvent = { ...eventInput, offset, createdAt, path: this.#path } as StreamEvent;
      if (eventInput.idempotencyKey)
        eventsByIdempotencyKey.set(eventInput.idempotencyKey, committedEvent);
      committedEvents.push(committedEvent);
      freshEvents.push(committedEvent);
    }
    if (freshEvents.length === 0) return committedEvents; // every event deduped to an existing one
    // 3 + 4. reduce and commit
    if (freshEvents.every((event) => event.ephemeral)) {
      // THE EPHEMERAL FAST PATH: nothing to store, so no transaction and no high-water write —
      // what lets a flood of ephemerals leave SQLite untouched (the flood proofs measure it).
      this.#highestAssignedOffset = nextOffset; // the durable mark is untouched
    } else {
      this.#storage.transactionSync(() => {
        for (const event of freshEvents) {
          if (event.ephemeral) continue;
          // the stored body is the event as appended plus createdAt — the row carries the offset,
          // the stream is the path
          const { offset: _offset, path: _path, ...eventBody } = event;
          this.#insertEventRowAndChunks(
            event.offset,
            JSON.stringify(eventBody),
            event.idempotencyKey ?? null,
          );
        }
        // The mark rides the durable rows' transaction — every offset this batch handed out,
        // ephemeral ones included, is covered by this write.
        this.#storage.kv.put("maxAssignedOffset", nextOffset);
        // The core reduce takes this batch's durables and checkpoints with them: the cursor every
        // batch (the transaction is already open, so the put is free), the reduced state on change.
        const { contract } = this.#coreProcessor;
        this.#coreLiveState ??= new LiveState(
          { append: (event) => this.append(event) },
          contract.slug,
          this.#coreReducedState,
        );
        const reducedStateBefore = this.#coreReducedState;
        for (const event of freshEvents) this.#reduceEventIntoCoreReducedState(event);
        this.#coreReducedThroughOffset = nextOffset;
        const changed = this.#coreReducedState !== reducedStateBefore;
        if (changed) this.#coreReducedStateChangedAtCommit = true; // published in step 5 — never inside the txn
        writeReduceCheckpoint(
          this.#storage.kv,
          contract.slug,
          { reducerVersion: contract.version, reducedThroughOffset: nextOffset },
          this.#coreReducedState,
          changed,
        );
      });
      this.#highestAssignedOffset = nextOffset;
      this.#highestDurableOffset = nextOffset;
    }
    // 5. after the commit
    this.#resolveWaitForEventWaiters(freshEvents); // waiters first: onCommit may append again (a nested commit)
    this.#onCommit(freshEvents, after, nextOffset);
    // Core's live-state delta, when this commit changed the reduced state: `set` mints the standard
    // ephemeral live-state/changed delta through this stream's own append (a nested commit). LOSSY BY
    // CONTRACT — LiveState.set contains every refusal (a PAUSED stream refuses the delta) as a
    // revision-chain gap the client heals by re-seeding. No feedback loop: the delta is ephemeral and
    // changes no core state; the flag is cleared BEFORE the set, so the nested commit's own step 5
    // finds nothing left.
    if (this.#coreReducedStateChangedAtCommit) {
      this.#coreReducedStateChangedAtCommit = false;
      this.#coreLiveState?.set(this.#coreReducedState);
    }
    return committedEvents;
  }

  /** Reduce one durable event into the core reduced state — the commit and the constructor's
   *  version-bump re-reduce both come here. A malformed control event must not wedge the stream:
   *  record the skip, move on. */
  #reduceEventIntoCoreReducedState(event: StreamEvent): void {
    if (event.ephemeral || !consumesEvent(this.#coreProcessor.contract.consumes, event)) return;
    try {
      this.#coreReducedState =
        this.#coreProcessor.reduce({ event, state: this.#coreReducedState }) ??
        this.#coreReducedState;
    } catch (err) {
      reportIssue("stream.core-reduce", err, { offset: event.offset, type: event.type });
    }
  }

  read(afterOffset = 0, limit = 500): StreamPage {
    limit = Math.max(1, limit); // limit 0 crashed the full-page check (userspace-reachable)
    const events = this.#storage.sql
      .exec(
        "SELECT offset, body FROM events WHERE offset > ? ORDER BY offset LIMIT ?",
        afterOffset,
        limit,
      )
      .toArray()
      .map((r) => {
        const offset = Number(r.offset);
        // Chunk rows never enter this SELECT, so the page counts EVENTS and its scannedThroughOffset
        // is an event offset — never a chunk boundary. Reassemble each body for the caller.
        return {
          ...(JSON.parse(
            this.#reassembleEventBodyFromChunks(offset, String(r.body)),
          ) as StreamEventInput & {
            createdAt: string;
          }),
          offset,
          path: this.#path,
        };
      });
    // The scanned-offset-range proof: a FULL page is only contiguously known through its last
    // row; a short page proves the read scanned the whole DURABLE log — through the durable mark,
    // never the in-memory head. The head counts ephemeral offsets, which die with the incarnation
    // and may be handed to durables by the next one; a proof that named one would let a persisted
    // checkpoint skip those durables (the zero-write contract in the header).
    const scannedThroughOffset =
      events.length === limit ? events[events.length - 1].offset : this.highestDurableOffset();
    return { events, scannedThroughOffset };
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
      if (page.events.length < 500) break; // a short page proves the scan reached the head
      cursor = page.scannedThroughOffset;
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

  /** Each resolution is armored: a waiter can never delay or fail a commit. */
  #resolveWaitForEventWaiters(freshEvents: StreamEvent[]): void {
    for (const event of freshEvents) {
      if (this.#waitForEventWaiters.length === 0) return;
      for (const w of [...this.#waitForEventWaiters]) {
        if ((w.type !== undefined && event.type !== w.type) || event.offset <= w.afterOffset)
          continue;
        this.#waitForEventWaiters.splice(this.#waitForEventWaiters.indexOf(w), 1);
        clearTimeout(w.timer);
        try {
          w.resolve(event);
        } catch (err) {
          reportIssue("stream.wait-for-event", err, { type: event.type, offset: event.offset });
        }
      }
    }
  }

  /** A body over EVENT_CHUNK_SIZE rides `event_chunks` behind an empty marker cell; both writes are
   *  the caller's transaction, so a throw rolls back the chunk rows with the event row. */
  #insertEventRowAndChunks(
    offset: number,
    serialized: string,
    idempotencyKey: string | null,
  ): void {
    if (serialized.length <= EVENT_CHUNK_SIZE) {
      this.#storage.sql.exec(
        "INSERT INTO events (offset, body, idempotency_key) VALUES (?, ?, ?)",
        offset,
        serialized,
        idempotencyKey,
      );
      return;
    }
    this.#storage.sql.exec(
      "INSERT INTO events (offset, body, idempotency_key) VALUES (?, '', ?)",
      offset,
      idempotencyKey,
    );
    for (let start = 0, idx = 0; start < serialized.length; idx++) {
      let end = Math.min(start + EVENT_CHUNK_SIZE, serialized.length);
      // NEVER split a UTF-16 surrogate PAIR across two cells: a lone surrogate becomes U+FFFD on
      // the SQLite TEXT bind, silently corrupting the body (byte-identity breaks). If the cut lands
      // right after a high surrogate, keep it with its low half in the next cell.
      if (end < serialized.length) {
        const c = serialized.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end -= 1;
      }
      this.#storage.sql.exec(
        "INSERT INTO event_chunks (offset, chunk_index, chunk) VALUES (?, ?, ?)",
        offset,
        idx,
        serialized.slice(start, end),
      );
      start = end;
    }
  }

  /** An EMPTY cell is the chunked marker (a real body is never empty JSON); otherwise the cell IS the body. */
  #reassembleEventBodyFromChunks(offset: number, cell: string): string {
    if (cell !== "") return cell;
    return this.#storage.sql
      .exec("SELECT chunk FROM event_chunks WHERE offset = ? ORDER BY chunk_index", offset)
      .toArray()
      .map((r) => String(r.chunk))
      .join("");
  }

  // ── the alarm armer ──

  /** ONE alarm write per quiet-period start, never per append (an ephemeral flood arms once).
   *  Memo-only: a fresh incarnation writes one redundant setAlarm and a later target may overwrite
   *  an earlier one, which is safe because every alarm() pass re-derives its obligations and
   *  re-arms. */
  armNoLaterThan(atMs: number): void {
    if (this.#alarmArmedForMs !== null && this.#alarmArmedForMs <= atMs) return;
    this.#alarmArmedForMs = atMs;
    // Not awaited: the native output gate owns the write and turns an async failure into an
    // invocation failure — and a lost memo just re-arms on the next alarm() pass.
    void this.#storage.setAlarm(atMs);
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
//     Promises of these exact types, so it IS a Context structurally (no `as unknown as`);
//   • the own parent — `localContext(this)`, whose only wrap is `read` (sync on the class, async
//     on the wire — one microtask on a path that then does real I/O anyway);
//   • an off-platform Pi — its `RpcTarget` returns Promises over capnweb.

/** A CONTEXT reachable over the wire: the stream verbs (append/read), plus `invoke` for capability
 *  dispatch. This is what `itx.cd('/x')` routes through and what `deps.context(path)`
 *  returns. The IterateContextDurableObject is one; a sibling DO stub and the own-path adapter satisfy it. */
export interface Context {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(afterOffset?: number, limit?: number): Promise<StreamPage>;
  invoke(call: ItxExpression): Promise<unknown>;
}

/** The own IterateContextDurableObject (same isolate) as a uniform-async Context. The ONLY wrap is `read`
 *  (sync on the class, async on the seam); `append` and `invoke` are already async. Built once per
 *  DO, never per call. */
export function localContext(self: {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(afterOffset?: number, limit?: number): StreamPage;
  invoke(call: ItxExpression): Promise<unknown>;
}): Context {
  return {
    append: (...events) => self.append(...events),
    read: async (afterOffset, limit) => self.read(afterOffset, limit),
    invoke: (call) => self.invoke(call),
  };
}
