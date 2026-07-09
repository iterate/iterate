/** One row of the streams index: a stream and its activity, for the ⌘K list and recency sort. */
export type StreamIndexRow = {
  path: string;
  /** First time we saw the stream (its earliest observed activity). */
  createdAt: string;
  /** Most recent activity — the recency sort key. Monotonic (never moves backwards). */
  lastActivityAt: string;
  /** Type of the most recent event. */
  lastType: string;
  /** How many events we've observed on the stream. */
  eventCount: number;
};

/**
 * The project's streams index — a materialized view of every stream and its
 * activity, keyed by path. It is PROJECT state the Durable Object maintains in
 * its own SQLite, with NOTHING to do with the stream processor: activity is
 * recorded from the `processEventBatch` fan-in, and the folded catalog only
 * seeds streams that predate the index.
 *
 * SQLite is the durable truth; an in-memory immutable `{ [path]: row }`
 * projection mirrors it and is what feeds `itx.live`. Updates are COPY-ON-WRITE
 * — a touch swaps exactly one row's reference — so the live-state diff stays
 * O(changed): one active stream yields one row-patch, every other row keeps its
 * identity (and the ⌘K list doesn't re-render).
 */
export class StreamDatabase {
  readonly #sql: SqlStorage;
  #projection: Record<string, StreamIndexRow>;
  #seeded = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS streams (
        path TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        last_type TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0
      )`,
    );
    this.#projection = this.#load();
  }

  /** The index keyed by path — a STABLE reference between writes, so the diff bails out. */
  all(): Record<string, StreamIndexRow> {
    return this.#projection;
  }

  /**
   * Record activity on a stream. Idempotent in the way that matters: replayed
   * batches only ever push `lastActivityAt` forward (SQLite `max`), never back.
   */
  touch(path: string, at: string, type: string, count: number): void {
    this.#sql.exec(
      `INSERT INTO streams (path, created_at, last_activity_at, last_type, event_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         last_activity_at = max(excluded.last_activity_at, streams.last_activity_at),
         last_type = excluded.last_type,
         event_count = streams.event_count + excluded.event_count`,
      path,
      at,
      at,
      type,
      count,
    );
    const prev = this.#projection[path];
    this.#projection = {
      ...this.#projection,
      [path]: {
        path,
        createdAt: prev?.createdAt ?? at,
        lastActivityAt: prev && prev.lastActivityAt > at ? prev.lastActivityAt : at,
        lastType: type,
        eventCount: (prev?.eventCount ?? 0) + count,
      },
    };
  }

  /**
   * One-time seed from the folded stream catalog, so streams that existed before
   * the index (or before this incarnation) appear even without fresh activity.
   * Insert-missing only — real activity via `touch` always wins.
   */
  ensureSeeded(catalog: readonly { path: string; createdAt: string }[]): void {
    if (this.#seeded) return;
    this.#seeded = true;
    for (const stream of catalog) {
      this.#sql.exec(
        `INSERT INTO streams (path, created_at, last_activity_at, last_type, event_count)
         VALUES (?, ?, ?, 'events.iterate.com/stream/created', 0)
         ON CONFLICT(path) DO NOTHING`,
        stream.path,
        stream.createdAt,
        stream.createdAt,
      );
    }
    this.#projection = this.#load();
  }

  #load(): Record<string, StreamIndexRow> {
    const rows: Record<string, StreamIndexRow> = {};
    for (const row of this.#sql.exec(`SELECT * FROM streams`).toArray()) {
      rows[row.path as string] = {
        path: row.path as string,
        createdAt: row.created_at as string,
        lastActivityAt: row.last_activity_at as string,
        lastType: row.last_type as string,
        eventCount: Number(row.event_count),
      };
    }
    return rows;
  }
}
