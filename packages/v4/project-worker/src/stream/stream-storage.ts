// Typed SQL persistence for event rows/chunks, incarnation metadata, subscription cursors and the
// core checkpoint. An empty event body marks a chunked body; real JSON event bodies are never empty.

import { ReduceCheckpointTable, type SqlStorageHandle } from "./reduce-checkpoint.ts";

/** The DurableObject storage surface required by Stream and its node:sqlite stand-in. */
export type DurableObjectStorageSlice = {
  sql: SqlStorageHandle;
  transactionSync<T>(closure: () => T): T;
  setAlarm(scheduledTime: number | Date): Promise<void>;
};

/** Split before SQLite's text-cell ceiling; smaller bodies remain one row. */
const EVENT_CHUNK_SIZE = 512 * 1024;

/** Durable progress and retry state for a cursor-delivered subscription. */
export type SubscriptionCursor = {
  confirmedOffset: number;
  attempt: number;
  nextAttemptAtMs?: number;
  resumeAppliedAtOffset?: number;
};

/** One durable row as stored: its offset and its serialized body, reassembled. */
export type StoredEventRow = { offset: number; body: string; estimatedDecodedBytes?: number };
export type StreamResourceHalt = { offset: number; estimatedBytes: number };

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
    // Unlike the original tables this was added after stores already existed, so its idempotent
    // CREATE runs for every incarnation until all stores have crossed the schema boundary.
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS stream_resource_halts (id INTEGER PRIMARY KEY CHECK (id = 1), offset INTEGER NOT NULL, estimated_bytes INTEGER NOT NULL)",
    );
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

  /** The last durable head whose fan-out an external public door activated. Constructor wake facts
   * deliberately do not move it, so an alarm cannot consume its own new wake after eviction. */
  readActivityHead(): number | undefined {
    const row = this.#sql
      .exec<{ value: string }>("SELECT value FROM stream_meta WHERE key = 'activity-head'")
      .toArray()[0];
    return row ? Number(row.value) : undefined;
  }

  writeActivityHead(offset: number): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO stream_meta (key, value) VALUES ('activity-head', ?)",
      String(offset),
    );
  }

  readResourceHalt(): StreamResourceHalt | undefined {
    const row = this.#sql
      .exec<{ offset: number; estimated_bytes: number }>(
        "SELECT offset, estimated_bytes FROM stream_resource_halts WHERE id = 1",
      )
      .toArray()[0];
    return row && { offset: Number(row.offset), estimatedBytes: Number(row.estimated_bytes) };
  }

  writeResourceHalt(halt: StreamResourceHalt): void {
    this.#sql.exec(
      "INSERT OR IGNORE INTO stream_resource_halts (id, offset, estimated_bytes) VALUES (1, ?, ?)",
      halt.offset,
      halt.estimatedBytes,
    );
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
    parsedBudgetBytes: number,
  ): { rows: StoredEventRow[]; bytes: number; nextRowDidNotFit: boolean } {
    const rows: StoredEventRow[] = [];
    let pageBytes = 0;
    let parsedBytes = 0;
    for (const row of this.#sql.exec<{ offset: number; body: string; body_bytes: number }>(
      `SELECT offset, body,
              length(CAST(body AS BLOB)) + COALESCE((SELECT SUM(length(CAST(chunk AS BLOB)))
                FROM event_chunks WHERE event_chunks.offset = events.offset), 0) AS body_bytes
         FROM events WHERE offset > ? ORDER BY offset LIMIT ?`,
      afterOffset,
      limit,
    )) {
      const bodyBytes = Number(row.body_bytes);
      if (rows.length > 0 && pageBytes + bodyBytes > budgetBytes)
        return { rows, bytes: pageBytes, nextRowDidNotFit: true }; // the cursor is left undrained (workerd frees the statement with it)
      const offset = Number(row.offset);
      const body = this.#reassembleBody(offset, String(row.body));
      const estimatedParsedBytes = this.#estimateParsedBytes(body);
      // A byte-sized body can expand by an order of magnitude when parsed into many tiny objects.
      // Never strand the first row: a single unprocessable event must still advance to its offset.
      if (rows.length > 0 && parsedBytes + estimatedParsedBytes > parsedBudgetBytes)
        return { rows, bytes: pageBytes, nextRowDidNotFit: true };
      pageBytes += bodyBytes;
      parsedBytes += estimatedParsedBytes;
      rows.push({ offset, body, estimatedDecodedBytes: body.length * 2 + estimatedParsedBytes });
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

  /** JSON.parse allocated about 96 bytes for each container in the dense-array memory proof.
   *  The scanner skips quoted delimiters, so valid JSON string content does not distort the estimate. */
  #estimateParsedBytes(body: string): number {
    let containers = 0;
    let quoted = false;
    let escaped = false;
    for (const char of body) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") containers++;
    }
    return containers * 96;
  }
}
