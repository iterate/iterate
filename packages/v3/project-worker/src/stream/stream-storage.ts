// stream-storage.ts — THE STREAM'S TABLES, typed: every SQL statement the stream runs lives here
// behind methods that take and return real types (the apps/os `StreamEventLog` shape), over the
// ONE platform handle — `ctx.storage.sql` (sync SQLite, a lazy cursor), `transactionSync` (the
// savepoint that rolls a commit back on a throw) and `setAlarm`. Workerd's kv is itself a SQLite
// table, so the stream keeps none of its own: its incarnation counter, its core checkpoint and its
// subscription cursors are rows in tables it owns, the whole seam is SQL, and a node:sqlite
// stand-in satisfies it in a screen (node-sqlite-durable-object-storage.ts).
//
//   events                offset · body · idempotency_key   one row per durable event
//   event_chunks          offset · chunk_index · chunk      a body over EVENT_CHUNK_SIZE, sliced —
//                         the events row keeps an EMPTY body as the chunked marker (a real body is
//                         never empty JSON); reads and the idempotency lookup reassemble it
//   stream_meta           key · value                       the incarnation counter
//   subscription_cursors  name · cursor (JSON)              the delivery loop's at-least-once cursors
//   reduce_checkpoints    reduce-checkpoint.ts              the core reduce's checkpoint (a facet host
//                                                           keeps its own, in its own storage)

import { ReduceCheckpointTable, type SqlStorageHandle } from "./reduce-checkpoint.ts";

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

export class StreamStorage {
  readonly #storage: DurableObjectStorageSlice;
  readonly #sql: SqlStorageHandle;
  /** The core reduce's checkpoint (reduce-checkpoint.ts), in this store. */
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
   *  is built and then dropped; a page always carries ≥ 1 row. `bytes` is what the page holds;
   *  `nextRowDidNotFit` says the budget, not the log, ended the page. */
  readEventPage(
    afterOffset: number,
    limit: number,
    budgetBytes: number,
  ): { rows: StoredEventRow[]; bytes: number; nextRowDidNotFit: boolean } {
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
        return { rows, bytes: pageBytes, nextRowDidNotFit: true }; // the cursor is left undrained (workerd frees the statement with it)
      pageBytes += Number(row.body_bytes);
      const offset = Number(row.offset);
      rows.push({ offset, body: this.#reassembleBody(offset, String(row.body)) });
    }
    return { rows, bytes: pageBytes, nextRowDidNotFit: false };
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
