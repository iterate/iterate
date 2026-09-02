// stream/stream.ts — THE STREAM, a simple dependency-injected JS class:
// SQLite rows + one kv high-water mark, idempotency at the door, one shared offset sequence,
// chunked large bodies, the append validation + the pause check, the wake record, waitForEvent, and
// the alarm armer — and THE CORE REDUCE (`core()`), the stream's own state folded inside every
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
// `stream/woken` record, the first event of each incarnation (Stream.wake), marks the boundary for
// anyone chaining ranges across it. And `read()` never PROVES a scan beyond the durable mark: a
// short page's `scannedThroughOffset` is the mark, not the in-memory head — so nothing a reader
// persists (a facet's checkpoint, a subscription cursor) can name an offset a later incarnation
// could hand to a durable. Pushes still carry the full head in their ranges; only the log's own
// proof is capped.
//
// Every context that is ever reached holds at least its birth certificate and a wake record: the DO
// constructor calls `wake()` before any door opens (the apps/os shape), so a probe on a never-seen
// context materializes it — deliberately; what is worth reaching is worth recording.
//
// The CONTEXT seam (`interface Context` + `localContext`) lives at the bottom: what one context
// reaches another THROUGH, uniform-async and REAL-typed.

import { codedError, reportIssue } from "../lib/errors.ts";
import type { ItxExpression } from "../context/expression.ts";
import { CoreStreamProcessor, isCoreControl, type CoreState } from "./core-processor.ts";
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

/** One parked waitForEvent caller: its filter, the promise ends, and the timeout timer. In-memory
 *  only — an eviction drops waiters, and that is FINE: the caller's own open RPC call keeps the DO
 *  awake for the wait's duration anyway, and a dropped waiter surfaces as the transport error the
 *  caller already handles. */
type EventWaiter = {
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
  /** The post-commit fan-out, called once per offset-advancing commit with `fresh` — the newly
   *  committed events in offset order, ephemerals included (the host's delivery loop; the
   *  waitForEvent waiters settle before it). */
  onCommit: (fresh: StreamEvent[], afterOffset: number, nextOffset: number) => void;
}

/** What `#plan` decides for one batch, before anything is written. */
type Plan = {
  /** One receipt per INPUT, in input order — a dedupe hit echoes the existing event. */
  receipts: StreamEvent[];
  /** The events that are NEW to the log, in offset order (what commits, folds, and fans out). */
  fresh: StreamEvent[];
  nextOffset: number;
};

/** The events table + the chunk overflow table. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
     offset INTEGER PRIMARY KEY,
     body TEXT NOT NULL,
     idempotency_key TEXT UNIQUE
   )`,
  // Overflow rows for a large body: the events row keeps an EMPTY body as the "chunked" marker
  // (a real body is always non-empty JSON), and the pieces live here, ordered by chunk_index.
  `CREATE TABLE IF NOT EXISTS event_chunks (
     offset INTEGER NOT NULL,
     chunk_index INTEGER NOT NULL,
     chunk TEXT NOT NULL,
     PRIMARY KEY (offset, chunk_index)
   )`,
];

/** The commit door every path funnels through (public stream/contexts/env.ITX + internal): an event
 *  must carry a non-blank type; `ephemeral` is literal `true` or ABSENT — a boolean `false` is a
 *  LOUD input error, never a silent synonym for durable (every consumer tests truthiness); and an
 *  ephemeral cannot carry an idempotencyKey (nothing idempotent about the unreplayable). This
 *  runtime guard is the SOLE enforcement (no capnweb-validate boundary). */
function assertWellFormed(inputs: StreamEventInput[]): void {
  for (const input of inputs) {
    if (typeof input.type !== "string" || input.type.trim() === "")
      throw new Error("append: every event needs a non-empty type");
    if ("ephemeral" in input && input.ephemeral !== undefined && input.ephemeral !== true)
      throw new Error(
        `append: ephemeral must be literal true or absent — got ${JSON.stringify(input.ephemeral)} on "${input.type}"`,
      );
    if (input.ephemeral && input.idempotencyKey)
      throw codedError(
        "EPHEMERAL_IDEMPOTENCY_KEY",
        "ephemeral events cannot carry an idempotencyKey — nothing idempotent about the unreplayable",
      );
  }
}

/** THE STREAM — the commit point: SQLite rows + ONE kv high-water mark, idempotency at the door,
 *  offsets assigned from one shared sequence (ephemeral events consume offsets, never rows — after
 *  a reboot their offsets survive as valid gaps), and THE CORE REDUCE (core-processor.ts) folded
 *  inside every commit: the stream's own state — who it is, its incarnation, pause, mounts,
 *  subscriptions — checkpointed with the rows it was reduced from. A body over EVENT_CHUNK_SIZE is
 *  chunked into `event_chunks` rows keyed (offset, chunk_index) — INVISIBLE to the events table, so a
 *  chunked event is still ONE row at ONE offset; reads and idempotency-dedupe reassemble it. */
export class Stream {
  readonly #storage: DurableObjectStorage;
  readonly #path: string;
  readonly #projectId: string;
  readonly #onCommit: StreamDeps["onCommit"];
  #incarnation = 0; // durable, bumped once per incarnation that WRITES — growth across idle ⇒ it hibernated
  #storageReady = false;
  /** The highest offset assigned THIS INCARNATION — ephemerals included. Seeded from the kv
   *  high-water mark (`maxAssignedOffset`), which append commits ONLY with a batch that stored a
   *  durable row, atomically with those rows; an ephemeral-only batch advances this cache alone
   *  (see the header: an ephemeral's offset is unique within an incarnation). */
  #highestAssignedOffsetCache?: number;
  /** The kv high-water mark (`maxAssignedOffset`) as of the last COMMITTED durable batch: the
   *  DURABLE head. What `read()` proves a scan through, what the core reduce folds up to, and
   *  what a resume's seek is clamped to — never the in-memory head above. */
  #durableMarkCache?: number;
  /** Parked waitForEvent callers, FIFO. Fed from `fresh` in append's post-commit tail. */
  readonly #waiters: EventWaiter[] = [];
  #armedForMs: number | null = null;

  // ── THE CORE REDUCE: the stream's own state, event-sourced from its own log (core-processor.ts).
  // Rehydrated from a versioned checkpoint (reduce-checkpoint.ts), caught up to the durable mark by
  // replaying the log, folded inside every durable commit, checkpointed with it (the cursor every
  // batch — a ~1 µs kv put inside the transaction already open — the state only on change), and
  // published as a live-state delta after the commit. Durable events only, so it rebuilds
  // bit-identically. ──
  readonly #core = new CoreStreamProcessor();
  #coreCache?: { state: CoreState; throughOffset: number };
  /** ONE LiveState holder, born at the first durable commit SEEDED WITH THE PRE-BATCH STATE so the
   *  first publish diffs exactly what that batch changed (`payload.key` = "core"). */
  #coreLive?: LiveState<CoreState>;
  #coreChangedAtCommit = false;

  constructor(deps: StreamDeps) {
    this.#storage = deps.storage;
    this.#path = deps.path;
    this.#projectId = deps.projectId;
    this.#onCommit = deps.onCommit;
  }

  /** First write of this incarnation: the tables + one incarnation bump (the hibernation tell —
   *  workless incarnations don't count, which is the point). Synchronous (the kv API), so append
   *  needs no boot barrier. */
  touch(): void {
    if (this.#storageReady) return;
    for (const ddl of SCHEMA) this.#storage.sql.exec(ddl);
    this.#incarnation = ((this.#storage.kv.get("incarnation") as number | undefined) ?? 0) + 1;
    this.#storage.kv.put("incarnation", this.#incarnation);
    this.#storageReady = true;
  }

  /** THE WAKE RECORD — the DO constructor calls this, synchronously, before any door opens (the
   *  apps/os shape). The first incarnation ever appends `stream/created { projectId, path }` — offset
   *  1, the birth certificate — and every incarnation appends `stream/woken { incarnation }`, so the
   *  core reduce knows who it is and which incarnation runs before the first append, read or facet
   *  call. Both are control events: a paused stream still records its wake. */
  wake(): void {
    this.touch();
    const born = this.durableMark() === 0;
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

  /** Read-only (never the write that mints storage — observability probes ride this). */
  currentIncarnation(): number {
    return this.#storageReady
      ? this.#incarnation
      : ((this.#storage.kv.get("incarnation") as number | undefined) ?? 0);
  }

  highestAssignedOffset(): number {
    this.#highestAssignedOffsetCache ??= this.durableMark();
    return this.#highestAssignedOffsetCache;
  }

  /** The durable high-water mark — the highest offset any durable row holds (a non-minting kv read
   *  on a virgin stream). Ephemeral offsets above it exist only in this incarnation's memory. */
  durableMark(): number {
    this.#durableMarkCache ??= (this.#storage.kv.get("maxAssignedOffset") as number) ?? 0;
    return this.#durableMarkCache;
  }

  /** Has the events table been created yet? A virgin stream has none, and READING must never mint
   *  it (see touch()) — so read() probes through here. */
  #eventsTableExists(): boolean {
    return (
      this.#storageReady ||
      this.#storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'")
        .toArray().length > 0
    );
  }

  // ── APPEND: the commit pipeline, top to bottom ──

  /** Commit a batch. Synchronous end to end (sync SQLite), so the steps never interleave:
   *
   *    1. MAY THIS LAND?  well-formed · not paused · idempotency (dedupe or refuse) · expected offsets
   *    2. OFFSETS         one shared sequence, ephemerals included, assigned in memory
   *    3. REDUCE + 4. COMMIT   rows + the high-water mark + the core reduce's checkpoint, ONE transaction
   *                            (an ephemeral-only batch skips this entirely: memory only, zero SQL)
   *    5. AFTER           waiters, then the host's fan-out (every subscriber), then core's live delta
   *
   *  Every refusal happens in step 1, before a single write. THE PRE-BATCH FENCE: both caches (the
   *  assigned head and the durable mark) are read at the top and advanced only AFTER the transaction
   *  returns — inside it the core reduce catches up to `durableMark()`, which must still be the
   *  pre-batch value (kv already holds nextOffset in-txn; reading it there would replay the
   *  just-inserted rows = a double reduce). */
  append(...inputs: StreamEventInput[]): StreamEvent[] {
    if (inputs.length === 0) return []; // a pure no-op: nothing checked, minted, or fanned out
    // 1. may this land?
    assertWellFormed(inputs);
    const paused = this.core().paused; // control events (created/woken/paused/resumed) are exempt
    if (paused && inputs.some((input) => !isCoreControl(input.type)))
      throw codedError("STREAM_PAUSED", `stream paused: ${paused.reason}`);
    this.touch();
    const after = this.highestAssignedOffset();
    // 2. offsets (and the last of step 1: idempotency + expected offsets — decided in memory)
    const { receipts, fresh, nextOffset } = this.#plan(inputs, after);
    if (fresh.length === 0) return receipts; // every input deduped to an existing event
    // 3 + 4. reduce and commit
    if (fresh.every((e) => e.ephemeral)) {
      // THE EPHEMERAL FAST PATH: nothing to store, so no transaction and no high-water write —
      // what lets a flood of ephemerals leave SQLite untouched (the flood proofs measure it).
      this.#highestAssignedOffsetCache = nextOffset; // the durable mark is untouched
    } else {
      this.#storage.transactionSync(() => {
        const createdAt = fresh[0].createdAt;
        for (const e of fresh)
          if (!e.ephemeral)
            this.#storeEvent(
              e.offset,
              JSON.stringify(this.#body(e, createdAt)),
              e.idempotencyKey ?? null,
            );
        // The mark rides the durable rows' transaction — every offset this batch handed out,
        // ephemeral ones included, is covered by this write.
        this.#storage.kv.put("maxAssignedOffset", nextOffset);
        this.#foldCore(fresh, nextOffset);
      });
      this.#highestAssignedOffsetCache = nextOffset;
      this.#durableMarkCache = nextOffset;
    }
    // 5. after the commit
    this.#settleWaiters(fresh); // waiters first: onCommit may append again (a nested commit)
    this.#onCommit(fresh, after, nextOffset);
    this.#publishCoreDelta();
    return receipts;
  }

  /** Decide the batch before writing anything: which inputs are DEDUPED to an existing event (same
   *  key + same body → that event, no offset), which are REFUSED (same key, different body; an
   *  expected `offset` that isn't the next one), and which offset each NEW event takes. */
  #plan(inputs: StreamEventInput[], after: number): Plan {
    const createdAt = new Date().toISOString();
    const receipts: StreamEvent[] = [];
    const fresh: StreamEvent[] = [];
    const byKey = new Map<string, StreamEvent>(); // keys landing earlier in THIS batch
    let nextOffset = after;
    for (const input of inputs) {
      const { offset: expected, ...rest } = input;
      // IDEMPOTENCY: a key already in the log (or earlier in this batch) answers with THAT event
      // and consumes no offset; a different body under the same key is a conflict, refused whole.
      const existing = rest.idempotencyKey
        ? (byKey.get(rest.idempotencyKey) ?? this.#findByKey(rest.idempotencyKey))
        : undefined;
      if (existing) {
        if (!sameIdempotentEvent(existing, rest))
          throw codedError(
            "IDEMPOTENCY_CONFLICT",
            idempotencyConflictMessage(rest.idempotencyKey!, existing.offset),
            { existingOffset: existing.offset },
          );
        if (expected !== undefined && expected !== existing.offset)
          throw codedError(
            "OFFSET_CONFLICT",
            `expected offset ${expected}, but "${rest.idempotencyKey}" already landed at ${existing.offset}`,
            { expected, actual: existing.offset },
          );
        receipts.push(existing);
        continue;
      }
      // EXPECTED OFFSET: an input carrying `offset` lands exactly there or the batch is refused —
      // "nothing has happened since I last looked" (apps/os's optimistic-concurrency shape).
      const offset = nextOffset + 1;
      if (expected !== undefined && expected !== offset)
        throw codedError(
          "OFFSET_CONFLICT",
          `expected offset ${expected}, but the next offset is ${offset}`,
          { expected, actual: offset },
        );
      nextOffset = offset;
      const event = { ...rest, offset, createdAt, path: this.#path } as StreamEvent;
      if (rest.idempotencyKey) byKey.set(rest.idempotencyKey, event);
      receipts.push(event);
      fresh.push(event);
    }
    return { receipts, fresh, nextOffset };
  }

  /** The stored body of an event: the input as written plus `createdAt` — never its offset or path
   *  (the row's own columns / the stream's identity carry those). */
  #body(event: StreamEvent, createdAt: string): StreamEventInput & { createdAt: string } {
    const { offset: _offset, path: _path, ...body } = event;
    return { ...body, createdAt };
  }

  /** The committed event a durable row already carries under `idempotencyKey`, if any (its body may
   *  be chunked — reassembled). Runs only for keyed inputs, so an unkeyed batch pays no SELECT. */
  #findByKey(idempotencyKey: string): StreamEvent | undefined {
    if (!this.#eventsTableExists()) return undefined;
    const hit = this.#storage.sql
      .exec("SELECT offset, body FROM events WHERE idempotency_key = ?", idempotencyKey)
      .toArray()[0];
    if (!hit) return undefined;
    const offset = Number(hit.offset);
    const body = JSON.parse(this.#reassemble(offset, String(hit.body))) as StreamEventInput & {
      createdAt: string;
    };
    return { ...body, offset, path: this.#path } as StreamEvent;
  }

  // ── the core reduce ──

  /** The core state, current as of the last commit — rehydrated (checkpoint, else initial) and
   *  caught up to the durable mark. Synchronous: what the append door, the dispatcher and the
   *  delivery loop read. */
  core(): CoreState {
    return this.#coreEntry().state;
  }

  /** `{ offset, state }` — the `itx.facets.get('core').snapshot()` door. */
  coreSnapshot(): { offset: number; state: CoreState } {
    const entry = this.#coreEntry();
    return { offset: entry.throughOffset, state: entry.state };
  }

  /** The live-state SEED — `{ rev, state }` in step with the deltas the holder emits (the same door
   *  a facet processor's `liveSnapshot()` is). Before the first durable commit of an incarnation
   *  there is no holder yet: rev 0 over the caught-up state, which the first delta (`from: 0`) chains onto. */
  coreLiveSnapshot(): { rev: number; state: CoreState } {
    return this.#coreLive?.snapshot() ?? { rev: 0, state: this.core() };
  }

  #coreEntry(): { state: CoreState; throughOffset: number } {
    const { contract } = this.#core;
    if (!this.#coreCache) {
      const cp = readReduceCheckpoint<CoreState>(
        this.#storage.kv,
        contract.slug,
        contract.version,
        () => contract.initialState(),
      );
      this.#coreCache = cp
        ? { state: cp.state, throughOffset: cp.reducedThroughOffset }
        : { state: contract.initialState(), throughOffset: 0 };
    }
    const entry = this.#coreCache;
    const head = this.durableMark(); // durables only: the mark is the reduce's head, never the in-memory one
    while (entry.throughOffset < head) {
      const page = this.read(entry.throughOffset, 500);
      for (const e of page.events) if (e.offset <= head) this.#reduceCore(entry, e);
      entry.throughOffset = Math.min(page.scannedThroughOffset, head);
      if (page.events.length < 500) break;
    }
    return entry;
  }

  /** Step 3, inside the commit transaction: fold the fresh durables and checkpoint — the cursor
   *  every batch (the transaction is already open, so the put is free), the state on change. */
  #foldCore(fresh: StreamEvent[], nextOffset: number): void {
    const entry = this.#coreEntry(); // caught up to the PRE-batch mark (see the fence in append)
    this.#coreLive ??= new LiveState(
      { append: (e) => this.append(e) },
      this.#core.contract.slug,
      entry.state,
    );
    const before = entry.state;
    for (const e of fresh) if (!e.ephemeral) this.#reduceCore(entry, e);
    entry.throughOffset = nextOffset;
    const changed = entry.state !== before;
    if (changed) this.#coreChangedAtCommit = true; // published in step 5 — never inside the txn
    writeReduceCheckpoint(
      this.#storage.kv,
      this.#core.contract.slug,
      { reducerVersion: this.#core.contract.version, reducedThroughOffset: nextOffset },
      entry.state,
      changed,
    );
  }

  #reduceCore(entry: { state: CoreState }, e: StreamEvent): void {
    if (!consumesEvent(this.#core.contract.consumes, e)) return;
    try {
      entry.state = this.#core.reduce({ event: e, state: entry.state }) ?? entry.state;
    } catch (err) {
      // A malformed/hostile control event must not wedge the stream: record the skip, move on.
      reportIssue("stream.core-reduce", err, { offset: e.offset, type: e.type });
    }
  }

  /** Step 5, after the commit: `set` the changed core state on its LiveState, minting the standard
   *  ephemeral live-state/changed delta through this stream's own append (a nested commit).
   *  LOSSY BY CONTRACT — LiveState.set contains every refusal (a PAUSED stream refuses the delta) as
   *  a revision-chain gap the client heals by re-seeding. No feedback loop: the delta is ephemeral
   *  and changes no core state, so at most one delta chases each changing batch; the flag is
   *  cleared BEFORE the set, so the nested commit's own step 5 finds nothing left to publish. */
  #publishCoreDelta(): void {
    if (!this.#coreChangedAtCommit) return;
    this.#coreChangedAtCommit = false;
    if (this.#coreCache && this.#coreLive) this.#coreLive.set(this.#coreCache.state);
  }

  read(afterOffset = 0, limit = 500): StreamPage {
    limit = Math.max(1, limit); // limit 0 crashed the full-page check (userspace-reachable)
    // A virgin stream has no events table (and reading must not create one — see touch()).
    if (!this.#eventsTableExists()) return { events: [], scannedThroughOffset: this.durableMark() };
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
          ...(JSON.parse(this.#reassemble(offset, String(r.body))) as StreamEventInput & {
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
      events.length === limit ? events[events.length - 1].offset : this.durableMark();
    return { events, scannedThroughOffset };
  }

  /** Resolve with the next event matching `filter` — or the first COMMITTED durable match already
   *  in the log after `filter.afterOffset` (explicitly passed; the default is the head at call
   *  time, so a bare wait means "the next occurrence" — reading history is what read() is for).
   *
   *  CHECK-AND-PARK IS ONE SYNCHRONOUS SLICE: zero awaits between the log scan and waiter
   *  registration (read is sync; an await there would lose a racing commit → spurious
   *  WAIT_TIMEOUT). The initial scan PAGES read() to the head; it rides the non-minting read path
   *  and never touches — a waitForEvent on a virgin stream must leave it virgin. Parked waiters
   *  are fed from `fresh` in append's tail, so EPHEMERAL events resolve waits too (they ride the
   *  fan-out — always-an-event — but are only catchable while parked, since they never hit the
   *  log). Multiple waiters settle FIFO per event; one event can resolve many waiters; a waiter
   *  resolves once, with its first matching event in offset order. */
  waitForEvent(filter: WaitForEventFilter = {}): Promise<StreamEvent> {
    const type = filter.type;
    const afterOffset = filter.afterOffset ?? this.highestAssignedOffset();
    const timeoutMs = Math.min(filter.timeoutMs ?? 30_000, 120_000);
    let cursor = afterOffset;
    for (;;) {
      const page = this.read(cursor, 500);
      for (const e of page.events)
        if (type === undefined || e.type === type) return Promise.resolve(e);
      if (page.events.length < 500) break; // a short page proves the scan reached the head
      cursor = page.scannedThroughOffset;
    }
    return new Promise<StreamEvent>((resolve, reject) => {
      const waiter: EventWaiter = {
        type,
        afterOffset,
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.#waiters.indexOf(waiter);
          if (at !== -1) this.#waiters.splice(at, 1);
          reject(
            codedError(
              "WAIT_TIMEOUT",
              `waitForEvent: no ${type === undefined ? "" : `"${type}" `}event after offset ${afterOffset} within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  /** Feed one committed batch to the parked waiters — fire-and-forget from append's tail, each
   *  resolution armored so a waiter can never delay or fail a commit. */
  #settleWaiters(fresh: StreamEvent[]): void {
    for (const e of fresh) {
      if (this.#waiters.length === 0) return;
      for (const w of [...this.#waiters]) {
        if ((w.type !== undefined && e.type !== w.type) || e.offset <= w.afterOffset) continue;
        this.#waiters.splice(this.#waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        try {
          w.resolve(e);
        } catch (err) {
          reportIssue("stream.wait-for-event", err, { type: e.type, offset: e.offset });
        }
      }
    }
  }

  /** Insert one durable event row. A body over EVENT_CHUNK_SIZE rides `event_chunks` behind an
   *  empty marker cell; both writes are the caller's transaction, so a later throw rolls back the
   *  chunk rows with the event row (no orphans, no half a body). */
  #storeEvent(offset: number, serialized: string, idempotencyKey: string | null): void {
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

  /** The full body for an event row: the cell itself when single-cell, else its chunk rows joined
   *  in order (an EMPTY cell is the chunked marker — a real body is never empty JSON). */
  #reassemble(offset: number, cell: string): string {
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
    if (this.#armedForMs !== null && this.#armedForMs <= atMs) return;
    this.#armedForMs = atMs;
    // Not awaited: the native output gate owns the write and turns an async failure into an
    // invocation failure — and a lost memo just re-arms on the next alarm() pass.
    void this.#storage.setAlarm(atMs);
  }

  markFired(): void {
    this.#armedForMs = null;
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
