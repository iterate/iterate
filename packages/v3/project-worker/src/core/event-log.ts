// core/event-log.ts — THE COMMIT POINT, isolated from the DO (the apps/os StreamEventLog +
// StreamAlarmArmer, adapted). SQLite rows + one kv high-water mark, idempotency at the door, one
// shared offset sequence, and chunked large bodies. Pure: nothing here reaches back into the DO —
// the DO holds a `StreamEventLog` and drives it.

import { codedError } from "./errors.ts";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./events.ts";

/** ONE alarm write per quiet-period start, never per append (an ephemeral flood arms once) — the
 *  apps/os StreamAlarmArmer, mirrored. Memo-only: a fresh incarnation writes one redundant setAlarm
 *  and a later target may overwrite an earlier one, which is safe because every alarm() pass
 *  re-derives its obligations and re-arms. */
export class StreamAlarmArmer {
  readonly #storage: { setAlarm(atMs: number): Promise<void> };
  #armedForMs: number | null = null;

  constructor(storage: { setAlarm(atMs: number): Promise<void> }) {
    this.#storage = storage;
  }

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

/** A serialized body longer than this (JSON string chars) is split across `event_chunks` rows
 *  instead of one SQLite TEXT cell (which caps around 2MB — SQLITE_TOOBIG). 512KiB matches apps/os;
 *  a body at or under it stays single-cell (the fast path — no chunk join on read). */
const EVENT_CHUNK_SIZE = 512 * 1024;

/** THE EVENT LOG — the commit point (the apps/os StreamEventLog, adapted): SQLite rows + ONE kv
 *  high-water mark, idempotency at the door, offsets assigned from one shared sequence (ephemeral
 *  events consume offsets, never rows — after a reboot their offsets survive as valid gaps). A body
 *  over EVENT_CHUNK_SIZE is chunked into `event_chunks` rows keyed (offset, chunk_index) — INVISIBLE
 *  to the events table, so a chunked event is still ONE row at ONE offset (dense allocation, honest
 *  read paging); reads and idempotency-dedupe reassemble it, and the one transactionSync rolls back
 *  every chunk row with its event row on any mid-batch throw. Deliberately storage-lazy: a log that
 *  never writes must never mint backing storage (workerd auto-deletes empty objects; a probed /state
 *  or typo'd ctx must leave nothing behind — the Kenton PR #6101 doctrine). */
export class StreamEventLog {
  readonly #storage: DurableObjectStorage;
  readonly #path: string;
  #incarnation = 0; // durable, bumped once per incarnation that WRITES — growth across idle ⇒ it hibernated
  #storageReady = false;
  /** The highest offset EVER ASSIGNED — including to ephemeral events whose bodies are gone.
   *  Backed by ONE tiny kv value (the deliberate write that makes a pure-ephemeral append cost
   *  exactly one storage write): offset REUSE after an incarnation dies is a data-corruption
   *  class, because consumers key durable truth by offset. The kv value is the ONE source —
   *  append's transactionSync commits it with the sql rows atomically. */
  #highestAssignedOffsetCache?: number;

  constructor(storage: DurableObjectStorage, path: string) {
    this.#storage = storage;
    this.#path = path;
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

  /** Read-only (never the write that mints storage — /state probes ride this). */
  currentIncarnation(): number {
    return this.#storageReady
      ? this.#incarnation
      : ((this.#storage.kv.get("incarnation") as number | undefined) ?? 0);
  }

  highestAssignedOffset(): number {
    this.#highestAssignedOffsetCache ??= (this.#storage.kv.get("maxAssignedOffset") as number) ?? 0;
    return this.#highestAssignedOffsetCache;
  }

  /** Has the events table been created yet? A virgin stream has none, and READING must never mint
   *  it (see touch()) — so read()/hasIdempotencyKey() probe through here. */
  #eventsTableExists(): boolean {
    return (
      this.#storageReady ||
      this.#storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'")
        .toArray().length > 0
    );
  }

  /** Commit a batch ATOMICALLY (transactionSync rolls back sql AND kv together): a mid-batch
   *  throw — an idempotency conflict after earlier inserts — must never leave rows above the
   *  recorded max offset, which the next append would re-assign (one offset, two identities).
   *  `reduceAtCommit` runs INSIDE the transaction (the inline processors' checkpoint commits
   *  with the batch). The offset cache is assigned only AFTER the transaction returns; a throw
   *  leaves it untouched and true. */
  append(
    inputs: StreamEventInput[],
    reduceAtCommit: (
      committed: StreamEvent[],
      scannedAfterOffset: number,
      nextOffset: number,
    ) => void,
  ): {
    committed: StreamEvent[];
    distinct: StreamEvent[];
    scannedAfterOffset: number;
    nextOffset: number;
  } {
    this.touch();
    const scannedAfterOffset = this.highestAssignedOffset();
    const { committed, distinct, nextOffset } = this.#storage.transactionSync(() => {
      const committed: StreamEvent[] = [];
      let nextOffset = scannedAfterOffset;
      for (const input of inputs) {
        if (input.ephemeral && input.idempotencyKey)
          throw codedError(
            "EPHEMERAL_IDEMPOTENCY_KEY",
            "ephemeral events cannot carry an idempotencyKey — nothing idempotent about the unreplayable",
          );
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
        const body = { ...input, createdAt: new Date().toISOString() };
        if (!input.ephemeral)
          this.#storeEvent(nextOffset, JSON.stringify(body), input.idempotencyKey ?? null);
        committed.push({ ...body, offset: nextOffset, path: this.#path } as StreamEvent);
      }
      // A dedupe hit echoes the OFFSET of the row it matched; when that row was inserted earlier
      // IN THIS batch (a retry beside its original), `committed` holds two entries for one offset.
      // `distinct` keeps one per offset (first wins) so the inline reduce AND the facet-drive /
      // connected delivery act on each durable event ONCE — while `committed` keeps the per-input
      // shape the RPC answer echoes back (each input still gets its own receipt).
      const seen = new Set<number>();
      const distinct = committed.filter((e) => !seen.has(e.offset) && (seen.add(e.offset), true));
      if (nextOffset > scannedAfterOffset) {
        this.#storage.kv.put("maxAssignedOffset", nextOffset); // THE one deliberate write
        reduceAtCommit(distinct, scannedAfterOffset, nextOffset);
      }
      return { committed, distinct, nextOffset };
    });
    if (nextOffset > scannedAfterOffset) this.#highestAssignedOffsetCache = nextOffset;
    return { committed, distinct, scannedAfterOffset, nextOffset };
  }

  read(afterOffset = 0, limit = 500): { events: StreamEvent[]; scannedThroughOffset: number } {
    limit = Math.max(1, limit); // limit 0 crashed the full-page check (userspace-reachable)
    // A virgin stream has no events table (and reading must not create one — see touch()).
    if (!this.#eventsTableExists())
      return { events: [], scannedThroughOffset: this.highestAssignedOffset() };
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
    // row; a short page proves the read scanned to the HEAD (ephemeral holes and all). Never
    // beyond the head — a beyond-head afterOffset must not fabricate a scan of unassigned
    // offsets (which would let a bad cursor skip everything later assigned there).
    const scannedThroughOffset =
      events.length === limit ? events[events.length - 1].offset : this.highestAssignedOffset();
    return { events, scannedThroughOffset };
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
    for (let i = 0, idx = 0; i < serialized.length; i += EVENT_CHUNK_SIZE, idx++)
      this.#storage.sql.exec(
        "INSERT INTO event_chunks (offset, chunk_index, chunk) VALUES (?, ?, ?)",
        offset,
        idx,
        serialized.slice(i, i + EVENT_CHUNK_SIZE),
      );
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

  /** Does a durable row already carry this idempotencyKey? A cheap existence probe so the breaker
   *  need not tax a retry that will DEDUPE to zero durable growth (never creates the events table —
   *  a virgin stream has no keys). */
  hasIdempotencyKey(key: string): boolean {
    if (!this.#eventsTableExists()) return false;
    return (
      this.#storage.sql
        .exec("SELECT 1 FROM events WHERE idempotency_key = ? LIMIT 1", key)
        .toArray().length > 0
    );
  }
}
