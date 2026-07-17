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

import { createDurableObjectClient, defineConfig, sql } from "sqlfu";
import type { StreamEvent } from "iterate/processors";
import { StreamEvent as StreamEventSchema } from "iterate/processors";

const EVENT_CHUNK_SIZE = 512 * 1024;
const textEncoder = new TextEncoder();

/**
 * A committed event paired with its serialized byte length (the exact bytes
 * stored in `event_chunks`). Delivery batching sizes batches against the byte
 * cap with these instead of re-stringifying every event on every read.
 */
export type SizedStreamEvent = { event: StreamEvent; byteLength: number };

export class StreamEventLog {
  constructor(
    readonly sql: SqlStorage,
    readonly path: string,
  ) {
    this.sql.exec(`
      -- Stream-owned append log metadata. Full event JSON is stored in event_chunks.
      -- offset is the replay cursor; idempotency_key's unique constraint is its lookup index.
      -- ephemeral marks second-class rows: range reads exclude them unless asked, and
      -- the stream may evict them in the future. Eviction keeps offsets consumed
      -- (highestAssignedOffset reads AUTOINCREMENT's sqlite_sequence, which survives
      -- row deletion) but forgets their idempotency keys.
      create table if not exists events (
        offset integer primary key autoincrement,
        type text not null,
        created_at text not null,
        idempotency_key text unique,
        ephemeral integer not null default 0
      )
    `);
    // Live streams predate the ephemeral column; adopt their table in place.
    // Synchronous and cheap (one pragma per constructor), same posture as the
    // create-if-not-exists DDL above.
    const eventColumns = this.sql.exec<{ name: string }>("pragma table_info(events)").toArray();
    if (!eventColumns.some((column) => column.name === "ephemeral")) {
      this.sql.exec("alter table events add column ephemeral integer not null default 0");
    }
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

  /**
   * The highest offset ever INSERTED, even if its row was since deleted —
   * AUTOINCREMENT's sqlite_sequence row is updated by every insert (explicit
   * offsets included) and survives row deletion. This is the offset
   * allocator's recovery floor: a future ephemeral-row eviction sweep may
   * delete the highest row, and reseeding the allocator from max(offset)
   * would then reissue offsets that live subscribers already saw.
   */
  highestAssignedOffset(): number {
    const sequence =
      this.sql
        .exec<{ seq: number | null }>("select seq from sqlite_sequence where name = 'events'")
        .toArray()[0]?.seq ?? 0;
    return Math.max(this.highestOffset(), sequence);
  }

  /**
   * Returns each event's serialized byte length (the exact bytes written to
   * `event_chunks`), so the commit path can hand delivery fan-out a sized
   * fresh tail without anyone re-stringifying what was just serialized here.
   */
  insert(events: readonly StreamEvent[]): number[] {
    const byteLengths: number[] = [];
    for (const event of events) {
      this.sql.exec(
        "insert into events (offset, type, created_at, idempotency_key, ephemeral) values (?, ?, ?, ?, ?)",
        event.offset,
        event.type,
        event.createdAt,
        event.idempotencyKey ?? null,
        event.ephemeral === true ? 1 : 0,
      );
      const rawJsonBytes = textEncoder.encode(JSON.stringify(event));
      byteLengths.push(rawJsonBytes.byteLength);
      for (const [chunkIndex, chunk] of chunkBytes(rawJsonBytes, EVENT_CHUNK_SIZE)) {
        this.sql.exec(
          "insert into event_chunks (offset, chunk_index, chunk_bytes) values (?, ?, ?)",
          event.offset,
          chunkIndex,
          chunk,
        );
      }
    }
    return byteLengths;
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
    /** Include ephemeral rows. Default false — ephemeral is opt-in on every range read. */
    includeEphemeral?: boolean;
  }): StreamEvent[] {
    return this.getRangeSized(args).map((sized) => sized.event);
  }

  /**
   * `getRange` plus each event's serialized byte length, summed from the
   * chunk rows already in hand — so delivery batching can enforce its byte
   * cap without re-stringifying every event it just parsed.
   */
  getRangeSized(args: {
    afterOffset: number;
    beforeOffset: number;
    eventTypes?: readonly string[];
    limit: number;
    includeEphemeral?: boolean;
  }): SizedStreamEvent[] {
    if (args.eventTypes?.length === 0) return [];
    const eventTypes =
      args.eventTypes === undefined || args.eventTypes.includes("*") ? undefined : args.eventTypes;
    const eventTypeClause =
      eventTypes === undefined ? "" : `and type in (${eventTypes.map(() => "?").join(", ")})`;
    const ephemeralClause = args.includeEphemeral === true ? "" : "and ephemeral = 0";
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
              ${ephemeralClause}
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
    return [...chunksByOffset.values()].map((eventChunks) => ({
      event: this.#parseEvent(eventChunks),
      byteLength: eventChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    }));
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
  advanceWatermark(subscriptionKey: string, ackedOffset: number, epoch?: number): void;
  /**
   * Before yielding to a remote push, persist its crash watchdog without
   * changing the failure count/error. Fenced to the row epoch captured by the
   * delivery so a seek or same-key recreation wins.
   */
  armWatchdog(subscriptionKey: string, nextAttemptAt: number, epoch: number): void;
  /** Failed delivery: record the consecutive attempt count and when to retry. */
  nack(
    subscriptionKey: string,
    args: { attempt: number; nextAttemptAt: number; error: string },
    epoch?: number,
  ): void;
  /** Explicit seek (cursor-set / resume-with-afterOffset). Clears failure state, bumps the epoch. */
  setCursor(subscriptionKey: string, ackedOffset: number): void;
  delete(subscriptionKey: string): void;
  /** Earliest pending retry across all rows, for arming the DO alarm. */
  minNextAttemptAt(): number | null;
};

/** SQLite-backed {@link SubscriptionCursorStore}, sharing the stream's own database. */
export class SqliteSubscriptionCursorStore implements SubscriptionCursorStore {
  static db = defineConfig({
    // The desired schema now (`sqlfu draft` diffs new migrations against it).
    definitions: sql`
      create table subscriptions (
        subscription_key text primary key,
        acked_offset integer not null,
        attempt integer not null default 0,
        next_attempt_at integer,
        last_error text,
        epoch integer not null default 0,
        updated_at text not null
      );
    `,
    migrations: [
      {
        // The #1784 table, verbatim. `if not exists` is load-bearing: live DOs
        // created their table from raw constructor DDL before sqlfu owned it,
        // so this migration adopts an existing pre-epoch table as readily as
        // it creates a fresh one.
        name: "20260709000001_create_subscriptions",
        content: sql`
          create table if not exists subscriptions (
            subscription_key text primary key,
            acked_offset integer not null,
            attempt integer not null default 0,
            next_attempt_at integer,
            last_error text,
            updated_at text not null
          );
        `,
      },
      {
        // `epoch` postdates the table (#1784 shipped without it, #1792 queries
        // it). This is a rebuild rather than `alter table add column` because
        // the migration meets THREE live shapes with empty sqlfu history: no
        // table (migration 1 just created it), the pre-epoch #1784 table, and
        // the with-epoch table #1792-era constructors created — a plain ALTER
        // would throw "duplicate column name" on the last one. Rows and
        // cursor progress are preserved; epoch restarts at 0 (the fence value
        // fresh #1784 rows had). Resetting a with-epoch table's fences is
        // safe here: this runs in the DO constructor, and no in-flight
        // delivery (the only reader of a stale epoch) survives a DO restart.
        name: "20260709000002_add_epoch",
        content: sql`
          alter table subscriptions rename to subscriptions_pre_epoch;
          create table subscriptions (
            subscription_key text primary key,
            acked_offset integer not null,
            attempt integer not null default 0,
            next_attempt_at integer,
            last_error text,
            epoch integer not null default 0,
            updated_at text not null
          );
          insert into subscriptions (subscription_key, acked_offset, attempt, next_attempt_at, last_error, updated_at)
          select subscription_key, acked_offset, attempt, next_attempt_at, last_error, updated_at
          from subscriptions_pre_epoch;
          drop table subscriptions_pre_epoch;
        `,
      },
    ],
    queries: {
      get: sql.nullableOne<{
        parameters: { subscriptionKey: string };
        result: SubscriptionCursorRowRecord;
      }>`
        select subscription_key, acked_offset, attempt, next_attempt_at, last_error, epoch
        from subscriptions
        where subscription_key = :subscriptionKey
      `,
      list: sql.many<{ result: SubscriptionCursorRowRecord }>`
        select subscription_key, acked_offset, attempt, next_attempt_at, last_error, epoch
        from subscriptions
      `,
      ensure: sql.run<{
        parameters: {
          subscriptionKey: string;
          ackedOffset: number;
          epoch: number;
          updatedAt: string;
        };
      }>`
        insert into subscriptions (subscription_key, acked_offset, epoch, updated_at)
        values (:subscriptionKey, :ackedOffset, :epoch, :updatedAt)
        on conflict (subscription_key) do nothing
      `,
      ack: sql.run<{
        parameters: { subscriptionKey: string; ackedOffset: number; updatedAt: string };
      }>`
        update subscriptions
        set acked_offset = max(acked_offset, :ackedOffset), attempt = 0, next_attempt_at = null, last_error = null, updated_at = :updatedAt
        where subscription_key = :subscriptionKey
      `,
      ackFenced: sql.run<{
        parameters: {
          subscriptionKey: string;
          ackedOffset: number;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set acked_offset = max(acked_offset, :ackedOffset), attempt = 0, next_attempt_at = null, last_error = null, updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      advanceWatermark: sql.run<{
        parameters: { subscriptionKey: string; ackedOffset: number; updatedAt: string };
      }>`
        update subscriptions
        set acked_offset = max(acked_offset, :ackedOffset), next_attempt_at = null, updated_at = :updatedAt
        where subscription_key = :subscriptionKey
      `,
      advanceWatermarkFenced: sql.run<{
        parameters: {
          subscriptionKey: string;
          ackedOffset: number;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set acked_offset = max(acked_offset, :ackedOffset), next_attempt_at = null, updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      armWatchdog: sql.run<{
        parameters: {
          subscriptionKey: string;
          nextAttemptAt: number;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set next_attempt_at = :nextAttemptAt, updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      nack: sql.run<{
        parameters: {
          subscriptionKey: string;
          attempt: number;
          nextAttemptAt: number;
          error: string;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set attempt = :attempt, next_attempt_at = :nextAttemptAt, last_error = :error, updated_at = :updatedAt
        where subscription_key = :subscriptionKey
      `,
      nackFenced: sql.run<{
        parameters: {
          subscriptionKey: string;
          attempt: number;
          nextAttemptAt: number;
          error: string;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set attempt = :attempt, next_attempt_at = :nextAttemptAt, last_error = :error, updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      setCursor: sql.run<{
        parameters: {
          subscriptionKey: string;
          ackedOffset: number;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set acked_offset = :ackedOffset, attempt = 0, next_attempt_at = null, last_error = null, epoch = :epoch, updated_at = :updatedAt
        where subscription_key = :subscriptionKey
      `,
      delete: sql.run<{ parameters: { subscriptionKey: string } }>`
        delete from subscriptions where subscription_key = :subscriptionKey
      `,
      minNextAttemptAt: sql.one<{ result: { next: number | null } }>`
        select min(next_attempt_at) as next from subscriptions where next_attempt_at is not null
      `,
    },
  });

  /** Monotonic within this instance; wall-clock floor covers restarts. */
  #lastEpoch = 0;

  #db: ReturnType<
    typeof SqliteSubscriptionCursorStore.db<ReturnType<typeof createDurableObjectClient>>
  >;

  constructor(sql: SqlStorage) {
    // {sql} without transactionSync: this store only holds SqlStorage. That
    // forgoes sqlfu's per-migration transaction, which is fine here — the
    // constructor is await-free, and Durable Object SQLite commits all writes
    // in one event-loop task atomically, so a crash mid-migration cannot
    // persist a half-applied state.
    this.#db = SqliteSubscriptionCursorStore.db(createDurableObjectClient({ sql }));
    this.#db.migrate();
  }

  #nextEpoch(): number {
    this.#lastEpoch = Math.max(this.#lastEpoch + 1, Date.now());
    return this.#lastEpoch;
  }

  get(subscriptionKey: string): SubscriptionCursorRow | undefined {
    const record = this.#db.get({ subscriptionKey });
    return record ? rowFromRecord(record) : undefined;
  }

  list(): SubscriptionCursorRow[] {
    return this.#db.list().map(rowFromRecord);
  }

  ensure(subscriptionKey: string, ackedOffset: number): void {
    this.#db.ensure({
      subscriptionKey,
      ackedOffset,
      // Fresh rows get a fresh epoch, so an ack fenced on a DELETED row's
      // epoch cannot land on a same-key recreation (the remove+recreate
      // deliver:"all" clobber).
      epoch: this.#nextEpoch(),
      updatedAt: new Date().toISOString(),
    });
  }

  ack(subscriptionKey: string, ackedOffset: number, epoch?: number): void {
    const params = { subscriptionKey, ackedOffset, updatedAt: new Date().toISOString() };
    if (epoch === undefined) {
      this.#db.ack(params);
    } else {
      this.#db.ackFenced({ ...params, epoch });
    }
  }

  advanceWatermark(subscriptionKey: string, ackedOffset: number, epoch?: number): void {
    const params = { subscriptionKey, ackedOffset, updatedAt: new Date().toISOString() };
    if (epoch === undefined) this.#db.advanceWatermark(params);
    else this.#db.advanceWatermarkFenced({ ...params, epoch });
  }

  armWatchdog(subscriptionKey: string, nextAttemptAt: number, epoch: number): void {
    this.#db.armWatchdog({
      subscriptionKey,
      nextAttemptAt,
      epoch,
      updatedAt: new Date().toISOString(),
    });
  }

  nack(
    subscriptionKey: string,
    args: { attempt: number; nextAttemptAt: number; error: string },
    epoch?: number,
  ): void {
    const params = {
      subscriptionKey,
      attempt: args.attempt,
      nextAttemptAt: args.nextAttemptAt,
      // Bound the stored error so a pathological message cannot bloat the row.
      error: args.error.slice(0, 2_000),
      updatedAt: new Date().toISOString(),
    };
    if (epoch === undefined) this.#db.nack(params);
    else this.#db.nackFenced({ ...params, epoch });
  }

  setCursor(subscriptionKey: string, ackedOffset: number): void {
    this.#db.setCursor({
      subscriptionKey,
      ackedOffset,
      epoch: this.#nextEpoch(),
      updatedAt: new Date().toISOString(),
    });
  }

  delete(subscriptionKey: string): void {
    this.#db.delete({ subscriptionKey });
  }

  minNextAttemptAt(): number | null {
    return this.#db.minNextAttemptAt().next;
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

// Shared across calls: each decode sequence runs synchronously to its final
// flush inside the single-threaded DO, so no two decodes can interleave.
const chunkDecoder = new TextDecoder();

function decodeChunks(chunks: ArrayBuffer[]): string {
  let value = "";
  for (const chunk of chunks) value += chunkDecoder.decode(chunk, { stream: true });
  return value + chunkDecoder.decode();
}
