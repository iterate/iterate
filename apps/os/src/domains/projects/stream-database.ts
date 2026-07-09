/** What `touch` records about a delivered batch — named fields because three of them are strings. */
export type TouchInput = {
  path: string;
  /** When the batch's latest event happened (`createdAt` of its last event). */
  at: string;
  /** Type of the batch's latest event. */
  type: string;
  /** The stream's max offset as stamped on the batch — monotonic, redelivery-safe. */
  maxOffset: number;
};

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
 * projection mirrors it and is what feeds `itx.liveState`. Updates are
 * COPY-ON-WRITE — a touch swaps exactly one row's reference — so the live-state
 * diff stays O(changed): one active stream yields one row-patch, every other
 * row keeps its identity (and the ⌘K list doesn't re-render).
 *
 * ONE merge, in JS: the DO is single-threaded and the projection is loaded from
 * SQLite at construction, so between writes the projection IS the current row
 * set. Every write computes the merged row here and stores it with a dumb
 * REPLACE — there is no second merge in SQL to keep in step (an earlier
 * `ON CONFLICT` twin of this logic diverged once already, on `lastType`).
 */
export class StreamDatabase {
  readonly #sql: SqlStorage;
  #projection: Record<string, StreamIndexRow>;

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
   * Record activity on a stream from a delivered batch. FULLY idempotent:
   * `maxOffset` is the stream's highest offset (monotonic, 1-based) and drives
   * `eventCount` through max, recency only ever advances, and a batch that
   * advances neither is a pure no-op — no write, same projection identity. So a
   * redelivered or retried batch can neither move recency backwards, clobber
   * `lastType` with an older event's type, nor inflate the count. (Offsets are
   * sequential, so the max offset IS the event count.)
   */
  touch({ path, at, type, maxOffset }: TouchInput): void {
    const prev = this.#projection[path];
    const advancesRecency = prev === undefined || at > prev.lastActivityAt;
    const eventCount = Math.max(prev?.eventCount ?? 0, maxOffset);
    if (prev !== undefined && !advancesRecency && eventCount === prev.eventCount) return;
    const row: StreamIndexRow = {
      path,
      createdAt: prev?.createdAt ?? at,
      lastActivityAt: advancesRecency ? at : prev.lastActivityAt,
      lastType: advancesRecency ? type : prev.lastType,
      eventCount,
    };
    this.#store(row);
    this.#projection = { ...this.#projection, [path]: row };
  }

  /**
   * Backfill index rows for folded-catalog streams that have no row yet, so
   * streams that predate the index — OR were added to the catalog since — appear
   * even without fresh activity. Insert-missing only: real activity via `touch`
   * always wins, and a stream already in the projection is skipped by a cheap
   * hash lookup (no SQL, no reload). Called on every live-state assembly, NOT
   * once — a one-shot flag would leave every stream created after the first call
   * absent from ⌘K until its first event batch. Copy-on-write like `touch`, so a
   * reassembly that backfills nothing keeps the projection's identity and the
   * live-state diff bails out.
   */
  seedMissing(catalog: readonly { path: string; createdAt: string }[]): void {
    let next = this.#projection;
    for (const stream of catalog) {
      if (next[stream.path] !== undefined) continue;
      const row: StreamIndexRow = {
        path: stream.path,
        createdAt: stream.createdAt,
        lastActivityAt: stream.createdAt,
        lastType: "events.iterate.com/stream/created",
        eventCount: 0,
      };
      this.#store(row);
      if (next === this.#projection) next = { ...this.#projection }; // fork once, on first insert
      next[stream.path] = row;
    }
    this.#projection = next;
  }

  /** Persist one merged row — REPLACE, because the merge already happened in JS. */
  #store(row: StreamIndexRow): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO streams (path, created_at, last_activity_at, last_type, event_count)
       VALUES (?, ?, ?, ?, ?)`,
      row.path,
      row.createdAt,
      row.lastActivityAt,
      row.lastType,
      row.eventCount,
    );
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
