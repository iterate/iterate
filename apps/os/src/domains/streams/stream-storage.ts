// The stream's append log — and its delivery cursors — in Durable Object SQLite.
//
// Storage is normalized into two tables: `events` is the offset-ordered
// metadata/index, and `event_chunks` holds the full event JSON as bounded
// UTF-8 byte rows. Durable Object SQLite caps each string/blob/row cell at
// ~2 MB; BLOB columns do not raise that ceiling, and SQL-side substr(?)
// chunking would still require binding the oversized value first, so event
// JSON is chunked in JS.
//
// A third table, `subscriptions`, holds the delivery spine's cursor rows (see
// stream-subscribers.ts). They live in the same SQLite as the log on purpose:
// a cursor advance and the events it acknowledges commit under the same
// output gate, so the cursor can never disagree with the log it points into.
// Cursor rows are STORAGE, not facts — per-batch acks must not double the
// journal — while park/resume transitions are facts appended to the log
// (streams README: "acked offsets are storage, not facts; park and resume are
// facts, not storage").
//
// Every method here is synchronous and must stay that way: the Stream
// Durable Object's append commit point assigns offsets, reduces state, and
// persists the batch in one await-free turn.

import type { StreamEvent } from "./schemas.ts";
import { StreamEvent as StreamEventSchema } from "./schemas.ts";

const EVENT_CHUNK_SIZE = 512 * 1024;
const textEncoder = new TextEncoder();

export class StreamEventLog {
  constructor(
    readonly sql: SqlStorage,
    readonly path: string,
  ) {
    this.sql.exec(`
      -- Stream-owned append log metadata. Full event JSON is stored in event_chunks.
      -- offset is the replay cursor; idempotency_key's unique constraint is its lookup index.
      create table if not exists events (
        offset integer primary key autoincrement,
        type text not null,
        created_at text not null,
        idempotency_key text unique
      )
    `);
    this.sql.exec(`
      -- Full committed event JSON split into ordered byte chunks. The WITHOUT ROWID
      -- primary key is the lookup index used by point reads and range replay.
      create table if not exists event_chunks (
        offset integer not null,
        chunk_index integer not null,
        chunk_bytes blob not null,
        primary key (offset, chunk_index),
        foreign key (offset) references events(offset) on delete cascade
      ) without rowid
    `);
  }

  highestOffset(): number {
    return (
      this.sql
        .exec<{ offset: number | null }>("select max(offset) as offset from events")
        .toArray()[0]?.offset ?? 0
    );
  }

  insert(events: readonly StreamEvent[]): void {
    for (const event of events) {
      this.sql.exec(
        "insert into events (offset, type, created_at, idempotency_key) values (?, ?, ?, ?)",
        event.offset,
        event.type,
        event.createdAt,
        event.idempotencyKey ?? null,
      );
      const rawJsonBytes = textEncoder.encode(JSON.stringify(event));
      for (const [chunkIndex, chunk] of chunkBytes(rawJsonBytes, EVENT_CHUNK_SIZE)) {
        this.sql.exec(
          "insert into event_chunks (offset, chunk_index, chunk_bytes) values (?, ?, ?)",
          event.offset,
          chunkIndex,
          chunk,
        );
      }
    }
  }

  getByOffset(offset: number): StreamEvent | undefined {
    const row = this.sql
      .exec<{ offset: number }>("select offset from events where offset = ? limit 1", offset)
      .toArray()[0];
    return row === undefined ? undefined : this.#readEventFromChunks(row.offset);
  }

  getByIdempotencyKey(idempotencyKey: string): StreamEvent | undefined {
    const row = this.sql
      .exec<{ offset: number }>(
        "select offset from events where idempotency_key = ? limit 1",
        idempotencyKey,
      )
      .toArray()[0];
    return row === undefined ? undefined : this.#readEventFromChunks(row.offset);
  }

  getRange(args: {
    afterOffset: number;
    beforeOffset: number;
    eventTypes?: readonly string[];
    limit: number;
  }): StreamEvent[] {
    if (args.eventTypes?.length === 0) return [];
    const eventTypes =
      args.eventTypes === undefined || args.eventTypes.includes("*") ? undefined : args.eventTypes;
    const eventTypeClause =
      eventTypes === undefined ? "" : `and type in (${eventTypes.map(() => "?").join(", ")})`;
    // One indexed metadata subquery picks the replay window; the join then streams each
    // event's chunks in primary-key order (offset, chunk_index).
    const chunks = this.sql
      .exec<{ offset: number; chunkBytes: ArrayBuffer }>(
        `
          select selected.offset as offset, event_chunks.chunk_bytes as chunkBytes
          from (
            select offset
            from events
            where offset > ?
              and offset < ?
              ${eventTypeClause}
            order by offset asc
            limit ?
          ) selected
          join event_chunks on event_chunks.offset = selected.offset
          order by selected.offset asc, event_chunks.chunk_index asc
        `,
        args.afterOffset,
        args.beforeOffset,
        ...(eventTypes ?? []),
        args.limit,
      )
      .toArray();
    const chunksByOffset = new Map<number, ArrayBuffer[]>();
    for (const chunk of chunks) {
      const eventChunks = chunksByOffset.get(chunk.offset);
      if (eventChunks === undefined) {
        chunksByOffset.set(chunk.offset, [chunk.chunkBytes]);
      } else {
        eventChunks.push(chunk.chunkBytes);
      }
    }
    return [...chunksByOffset.values()].map((eventChunks) => this.#parseEvent(eventChunks));
  }

  #readEventFromChunks(offset: number): StreamEvent {
    // Do not use group_concat here: it would recreate a multi-MiB SQLite result cell.
    // Returning bounded chunk rows and joining in JS keeps SQLite row sizes predictable.
    const chunks = this.sql
      .exec<{ chunkBytes: ArrayBuffer }>(
        "select chunk_bytes as chunkBytes from event_chunks where offset = ? order by chunk_index asc",
        offset,
      )
      .toArray()
      .map((row) => row.chunkBytes);
    return this.#parseEvent(chunks);
  }

  #parseEvent(chunks: ArrayBuffer[]): StreamEvent {
    const parsed = JSON.parse(decodeChunks(chunks)) as unknown;
    return StreamEventSchema.parse(addLegacyEventPath(parsed, this.path));
  }
}

/**
 * One durable subscription's delivery cursor row. `ackedOffset` is exclusive
 * (delivery resumes at +1). For push subscriptions it is the AUTHORITATIVE
 * cursor: it only advances when the receiver's awaited call resolved. For wake
 * subscriptions it is an OBSERVATIONAL watermark: the checkpoint the
 * subscriber reported on the last successful poke, used only for poke
 * coalescing and lag display — the subscriber's own `{offset, state}` snapshot
 * is the truth, and a lost or stale row costs one redundant poke, nothing
 * more.
 */
export type SubscriptionCursorRow = {
  subscriptionKey: string;
  ackedOffset: number;
  /** Consecutive delivery/poke failures since the last success. */
  attempt: number;
  /** Wall-clock ms before which the spine must not retry; null when not backing off. */
  nextAttemptAt: number | null;
  lastError: string | null;
  /**
   * Seek fence. Bumped by every explicit cursor move (`setCursor`) and fresh
   * on every row creation, so an ack fenced on the epoch a drain READ cannot
   * clobber a seek (or a remove+recreate) that landed while its delivery was
   * in flight — `ack`'s monotonic max alone would silently swallow the seek.
   */
  epoch: number;
};

/**
 * The delivery spine's durable rows, behind an interface so the spine's logic
 * is unit-testable with an in-memory twin (stream-subscribers.test.ts). All
 * methods synchronous — same rule as the event log above.
 */
export type SubscriptionCursorStore = {
  get(subscriptionKey: string): SubscriptionCursorRow | undefined;
  list(): SubscriptionCursorRow[];
  /** Create the row if absent (configure); never resets an existing cursor. */
  ensure(subscriptionKey: string, ackedOffset: number): void;
  /**
   * Successful delivery: advance the cursor (monotonic), clear failure state.
   * With `epoch`, the ack is FENCED: it no-ops unless the row's epoch still
   * matches the one the caller read before dialing — a seek that landed while
   * the delivery was in flight wins over the delivery's ack.
   */
  ack(subscriptionKey: string, ackedOffset: number, epoch?: number): void;
  /**
   * Advance the wake lane's observational watermark (monotonic) after a poke
   * whose checkpoint did NOT progress. Clears the retry schedule (the poke
   * consumed it; a live connection has no pending retry to arm) but KEEPS the
   * failure streak — a successful handshake proves the host is reachable, not
   * that deliveries succeed, and resetting the counter here is what let a
   * deterministically failing subscriber spin forever without ever parking.
   */
  advanceWatermark(subscriptionKey: string, ackedOffset: number): void;
  /** Failed delivery: record the consecutive attempt count and when to retry. */
  nack(
    subscriptionKey: string,
    args: { attempt: number; nextAttemptAt: number; error: string },
  ): void;
  /** Explicit seek (cursor-set / resume-with-afterOffset). Clears failure state, bumps the epoch. */
  setCursor(subscriptionKey: string, ackedOffset: number): void;
  delete(subscriptionKey: string): void;
  /** Earliest pending retry across all rows, for arming the DO alarm. */
  minNextAttemptAt(): number | null;
};

/** SQLite-backed {@link SubscriptionCursorStore}, sharing the stream's own database. */
export class SqliteSubscriptionCursorStore implements SubscriptionCursorStore {
  /** Monotonic within this instance; wall-clock floor covers restarts. */
  #lastEpoch = 0;

  constructor(readonly sql: SqlStorage) {
    this.sql.exec(`
      -- Delivery cursors for durable subscriptions (the spine's rows). One row
      -- per subscriptionKey; created on subscription-configured, dropped on
      -- subscription-removed. See stream-subscribers.ts for the state machine.
      create table if not exists subscriptions (
        subscription_key text primary key,
        acked_offset integer not null,
        attempt integer not null default 0,
        next_attempt_at integer,
        last_error text,
        epoch integer not null default 0,
        updated_at text not null
      )
    `);
    const subscriptionColumns = new Set(
      this.sql
        .exec<{ name: string }>("pragma table_info(subscriptions)")
        .toArray()
        .map((column) => column.name),
    );
    if (!subscriptionColumns.has("epoch")) {
      this.sql.exec("alter table subscriptions add column epoch integer not null default 0");
    }
  }

  #nextEpoch(): number {
    this.#lastEpoch = Math.max(this.#lastEpoch + 1, Date.now());
    return this.#lastEpoch;
  }

  get(subscriptionKey: string): SubscriptionCursorRow | undefined {
    return this.sql
      .exec<SubscriptionCursorRowRecord>(
        "select subscription_key, acked_offset, attempt, next_attempt_at, last_error, epoch from subscriptions where subscription_key = ?",
        subscriptionKey,
      )
      .toArray()
      .map(rowFromRecord)[0];
  }

  list(): SubscriptionCursorRow[] {
    return this.sql
      .exec<SubscriptionCursorRowRecord>(
        "select subscription_key, acked_offset, attempt, next_attempt_at, last_error, epoch from subscriptions",
      )
      .toArray()
      .map(rowFromRecord);
  }

  ensure(subscriptionKey: string, ackedOffset: number): void {
    this.sql.exec(
      "insert into subscriptions (subscription_key, acked_offset, epoch, updated_at) values (?, ?, ?, ?) on conflict (subscription_key) do nothing",
      subscriptionKey,
      ackedOffset,
      // Fresh rows get a fresh epoch, so an ack fenced on a DELETED row's
      // epoch cannot land on a same-key recreation (the remove+recreate
      // deliver:"all" clobber).
      this.#nextEpoch(),
      new Date().toISOString(),
    );
  }

  ack(subscriptionKey: string, ackedOffset: number, epoch?: number): void {
    this.sql.exec(
      `update subscriptions set acked_offset = max(acked_offset, ?), attempt = 0, next_attempt_at = null, last_error = null, updated_at = ? where subscription_key = ?${epoch === undefined ? "" : " and epoch = ?"}`,
      ...(epoch === undefined
        ? [ackedOffset, new Date().toISOString(), subscriptionKey]
        : [ackedOffset, new Date().toISOString(), subscriptionKey, epoch]),
    );
  }

  advanceWatermark(subscriptionKey: string, ackedOffset: number): void {
    this.sql.exec(
      "update subscriptions set acked_offset = max(acked_offset, ?), next_attempt_at = null, updated_at = ? where subscription_key = ?",
      ackedOffset,
      new Date().toISOString(),
      subscriptionKey,
    );
  }

  nack(
    subscriptionKey: string,
    args: { attempt: number; nextAttemptAt: number; error: string },
  ): void {
    this.sql.exec(
      "update subscriptions set attempt = ?, next_attempt_at = ?, last_error = ?, updated_at = ? where subscription_key = ?",
      args.attempt,
      args.nextAttemptAt,
      // Bound the stored error so a pathological message cannot bloat the row.
      args.error.slice(0, 2_000),
      new Date().toISOString(),
      subscriptionKey,
    );
  }

  setCursor(subscriptionKey: string, ackedOffset: number): void {
    this.sql.exec(
      "update subscriptions set acked_offset = ?, attempt = 0, next_attempt_at = null, last_error = null, epoch = ?, updated_at = ? where subscription_key = ?",
      ackedOffset,
      this.#nextEpoch(),
      new Date().toISOString(),
      subscriptionKey,
    );
  }

  delete(subscriptionKey: string): void {
    this.sql.exec("delete from subscriptions where subscription_key = ?", subscriptionKey);
  }

  minNextAttemptAt(): number | null {
    return (
      this.sql
        .exec<{ next: number | null }>(
          "select min(next_attempt_at) as next from subscriptions where next_attempt_at is not null",
        )
        .toArray()[0]?.next ?? null
    );
  }
}

/**
 * Reconciles the spine's cursor rows against a freshly REBUILT config fold
 * (core state version mismatch). Rows are storage and survive the KV state,
 * so after a rebuild they can describe a world the new fold no longer
 * derives: a row whose config event no longer parses is orphaned (its
 * `next_attempt_at` would arm alarms forever), and a surviving row's backoff
 * may blame code the new version replaced. Progress is kept — `ackedOffset`
 * is monotonic truth about the same immutable log — while failure state is
 * cleared so every survivor gets an immediate fresh try under the new fold.
 */
export function reconcileSubscriptionCursorRows(
  store: SubscriptionCursorStore,
  configuredKeys: ReadonlySet<string>,
): void {
  for (const row of store.list()) {
    if (!configuredKeys.has(row.subscriptionKey)) {
      store.delete(row.subscriptionKey);
    } else if (row.attempt !== 0 || row.nextAttemptAt !== null || row.lastError !== null) {
      // ack at the row's own offset: keeps the cursor, clears attempt/backoff.
      store.ack(row.subscriptionKey, row.ackedOffset);
    }
  }
}

type SubscriptionCursorRowRecord = {
  subscription_key: string;
  acked_offset: number;
  attempt: number;
  next_attempt_at: number | null;
  last_error: string | null;
  epoch: number;
};

function rowFromRecord(record: SubscriptionCursorRowRecord): SubscriptionCursorRow {
  return {
    subscriptionKey: record.subscription_key,
    ackedOffset: record.acked_offset,
    attempt: record.attempt,
    nextAttemptAt: record.next_attempt_at,
    lastError: record.last_error,
    epoch: record.epoch,
  };
}

function addLegacyEventPath(value: unknown, path: string): unknown {
  if (value !== null && typeof value === "object" && !("path" in value)) {
    return { ...value, path };
  }
  return value;
}

function* chunkBytes(value: Uint8Array, chunkSize: number): Generator<[number, ArrayBuffer]> {
  let chunkIndex = 0;
  for (let start = 0; start < value.byteLength; start += chunkSize) {
    const end = Math.min(start + chunkSize, value.byteLength);
    const chunk = new ArrayBuffer(end - start);
    new Uint8Array(chunk).set(value.subarray(start, end));
    yield [chunkIndex, chunk];
    chunkIndex += 1;
  }
  if (chunkIndex === 0) yield [0, new ArrayBuffer(0)];
}

function decodeChunks(chunks: ArrayBuffer[]): string {
  const textDecoder = new TextDecoder();
  let value = "";
  for (const chunk of chunks) value += textDecoder.decode(chunk, { stream: true });
  return value + textDecoder.decode();
}
