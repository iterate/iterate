// stream/stream.ts — THE STREAM, a simple dependency-injected JS class:
// SQLite rows + one kv high-water mark, idempotency at the door, one shared offset sequence,
// chunked large bodies, the append validation + the pause check, the wake record, waitForEvent, and
// the alarm armer. The DurableObject holds a `Stream` and drives it; everything the stream needs
// from its host arrives through the enumerated constructor deps — `paused` (the core reduce's
// pause slice), `reduceAtCommit` (the core reduce, IN-txn), `onCommit` (the post-commit fan-out) —
// so nothing here reaches back into the DO.
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
import { isCoreControl } from "./core-processor.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./events.ts";

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
  /** The core reduce's pause slice, read at the append door: a paused stream refuses every
   *  non-control append with STREAM_PAUSED (the one `if` in `append`). */
  paused: () => { reason: string } | null;
  /** The core reduce, run INSIDE the commit transaction (the routing table and the pause state are
   *  atomically exact as of the last committed event — the pump-races-the-provide class is
   *  unspellable, not carefully avoided). */
  reduceAtCommit: (justCommitted: StreamEvent[], afterOffset: number, nextOffset: number) => void;
  /** The post-commit fan-out, called once per offset-advancing commit with `fresh` — the FULL
   *  in-range distinct batch, INCLUDING events.iterate.com/live-state/changed (the host derives
   *  delivery loop and the waitForEvent waiters both feed from `fresh`). */
  onCommit: (fresh: StreamEvent[], afterOffset: number, nextOffset: number) => void;
}

/** THE STREAM — the commit point: SQLite rows + ONE kv high-water mark, idempotency at the door,
 *  offsets assigned from one shared sequence (ephemeral events consume offsets, never rows — after
 *  a reboot their offsets survive as valid gaps). A body over EVENT_CHUNK_SIZE is chunked into
 *  `event_chunks` rows keyed (offset, chunk_index) — INVISIBLE to the events table, so a chunked
 *  event is still ONE row at ONE offset (dense allocation, honest read paging); reads and
 *  idempotency-dedupe reassemble it, and the one transactionSync rolls back every chunk row with
 *  its event row on any mid-batch throw. */
export class Stream {
  readonly #storage: DurableObjectStorage;
  readonly #path: string;
  readonly #projectId: string;
  readonly #paused: StreamDeps["paused"];
  readonly #reduceAtCommit: StreamDeps["reduceAtCommit"];
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

  constructor(deps: StreamDeps) {
    this.#storage = deps.storage;
    this.#path = deps.path;
    this.#projectId = deps.projectId;
    this.#paused = deps.paused;
    this.#reduceAtCommit = deps.reduceAtCommit;
    this.#onCommit = deps.onCommit;
  }

  /** First write of this incarnation: the events table + one incarnation bump (the hibernation
   *  tell — workless incarnations don't count, which is the point). Synchronous (the kv API),
   *  so append needs no boot barrier. */
  touch(): void {
    if (this.#storageReady) return;
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

  /** Commit a batch: validate → the pause check → transactionSync → post-commit fan-out.
   *
   *  The transaction is ATOMIC (transactionSync rolls back sql AND kv together): a mid-batch
   *  throw — an idempotency conflict after earlier inserts — must never leave rows above the
   *  recorded max offset, which the next append would re-assign (one offset, two identities).
   *  `reduceAtCommit` runs INSIDE the transaction (the inline processors' checkpoint commits
   *  with the batch). THE PRE-BATCH FENCE: both caches (the assigned head AND the durable mark)
   *  are warmed at the top (`highestAssignedOffset()` warms the mark on the way) and assigned only
   *  AFTER the transaction returns; a throw leaves them untouched and true. Inside reduceAtCommit
   *  the core reduce catches up to `durableMark()`, which must therefore still be the PRE-batch
   *  value (kv already holds nextOffset in-txn; reading kv there would make an inline rehydrate
   *  replay the just-inserted rows = double-reduce = table corruption). */
  append(...inputs: StreamEventInput[]): StreamEvent[] {
    // A ZERO-INPUT append is a PURE no-op: no pause check, no touch, no fan-out.
    if (inputs.length === 0) return [];
    // THE commit door every path funnels through (public stream/contexts/env.ITX + internal):
    // an event must carry a non-blank type, and `ephemeral` is literal `true` or ABSENT — a
    // boolean `false` is a LOUD input error, never a silent synonym for durable (the apps/os
    // contract stream/events.ts declares; every consumer tests truthiness, so an unpoliced `false`
    // would silently commit durable). This runtime guard is the SOLE enforcement (no
    // capnweb-validate boundary).
    for (const input of inputs) {
      if (typeof input.type !== "string" || input.type.trim() === "")
        throw new Error("append: every event needs a non-empty type");
      if ("ephemeral" in input && input.ephemeral !== undefined && input.ephemeral !== true)
        throw new Error(
          `append: ephemeral must be literal true or absent — got ${JSON.stringify(input.ephemeral)} on "${input.type}"`,
        );
    }
    // THE PAUSE CHECK — the core reduce's `paused` slice, read right here: a paused stream refuses
    // every non-control append (control = the platform's own records + the pause/resume pair, so a
    // paused stream always accepts its own resume). Policy that decides WHEN to pause (a breaker, a
    // quota) is a facet processor appending `stream/paused` with its reason — never code here.
    const paused = this.#paused();
    if (paused && inputs.some((input) => !isCoreControl(input.type)))
      throw codedError("STREAM_PAUSED", `stream paused: ${paused.reason}`);
    this.touch();
    const scannedAfterOffset = this.highestAssignedOffset();
    for (const input of inputs)
      if (input.ephemeral && input.idempotencyKey)
        throw codedError(
          "EPHEMERAL_IDEMPOTENCY_KEY",
          "ephemeral events cannot carry an idempotencyKey — nothing idempotent about the unreplayable",
        );
    // THE EPHEMERAL FAST PATH: nothing to store, nothing to look up (ephemerals carry no
    // idempotency key), so no transaction and no high-water write — offsets are handed out from
    // memory and the batch goes straight to the fan-out. This is what lets a 5000 ev/s flood of
    // ephemerals leave SQLite untouched (the flood proofs measure it).
    if (inputs.every((input) => input.ephemeral)) {
      let nextOffset = scannedAfterOffset;
      const createdAt = new Date().toISOString();
      const fresh = inputs.map(
        (input) => ({ ...input, createdAt, offset: ++nextOffset, path: this.#path }) as StreamEvent,
      );
      this.#highestAssignedOffsetCache = nextOffset; // the durable mark is untouched
      this.#settleWaiters(fresh);
      this.#onCommit(fresh, scannedAfterOffset, nextOffset);
      return fresh;
    }
    const createdAt = new Date().toISOString();
    const { committed, distinct, nextOffset } = this.#storage.transactionSync(() => {
      const committed: StreamEvent[] = [];
      let nextOffset = scannedAfterOffset;
      for (const input of inputs) {
        if (input.idempotencyKey) {
          const hit = this.#storage.sql
            .exec("SELECT offset, body FROM events WHERE idempotency_key = ?", input.idempotencyKey)
            .toArray()[0];
          if (hit) {
            // Reassemble the stored body (it may be chunked) before the structural compare.
            const existing = JSON.parse(
              this.#reassemble(Number(hit.offset), String(hit.body)),
            ) as StreamEventInput;
            if (sameIdempotentEvent(existing, input)) {
              committed.push({
                ...existing,
                offset: Number(hit.offset),
                path: this.#path,
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
        const body = { ...input, createdAt };
        if (!input.ephemeral)
          this.#storeEvent(nextOffset, JSON.stringify(body), input.idempotencyKey ?? null);
        committed.push({ ...body, offset: nextOffset, path: this.#path } as StreamEvent);
      }
      // A dedupe hit echoes the OFFSET of the row it matched; when that row was inserted earlier
      // IN THIS batch (a retry beside its original), `committed` holds two entries for one offset.
      // `distinct` keeps one per offset (first wins) so the core reduce AND the delivery loop see
      // each durable event ONCE — while `committed` keeps the per-input
      // shape the RPC answer echoes back (each input still gets its own receipt).
      const seen = new Set<number>();
      const distinct = committed.filter((e) => !seen.has(e.offset) && (seen.add(e.offset), true));
      if (nextOffset > scannedAfterOffset) {
        // The high-water mark rides the durable rows' transaction — this batch stored at least one
        // (an all-ephemeral batch never gets here), so every offset it handed out, ephemeral ones
        // included, is covered by this write.
        this.#storage.kv.put("maxAssignedOffset", nextOffset);
        this.#reduceAtCommit(distinct, scannedAfterOffset, nextOffset);
      }
      return { committed, distinct, nextOffset };
    });
    if (nextOffset > scannedAfterOffset) {
      this.#highestAssignedOffsetCache = nextOffset;
      this.#durableMarkCache = nextOffset; // the mark this transaction just committed
      // A prior-batch idempotency dedupe echoes an ALREADY-DELIVERED below-range offset into
      // `distinct` (see the dedupe note above). Drop it before the fan-out — the range is
      // (after, nextOffset]; a durable at/below the floor was delivered on its own commit.
      // Ephemerals are minted IN range (they can't carry an idempotency key), so this never drops
      // one; it just makes every fan-out consumer match the inline reduce's guard.
      const fresh = distinct.filter((e) => e.offset > scannedAfterOffset);
      // Waiters settle BEFORE the host's fan-out: onCommit may append again (a live-state delta —
      // a nested commit with its own tail), and a waiter must resolve with its FIRST matching
      // event in offset order, not whichever commit's tail ran first.
      this.#settleWaiters(fresh);
      this.#onCommit(fresh, scannedAfterOffset, nextOffset);
    }
    return committed;
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
