// The stream's append log — and its delivery cursors — in Durable Object SQLite.
//
// Storage is normalized into four tables. `events` is the offset-ordered
// durable metadata/index; `event_chunks` holds the full durable event JSON as
// bounded UTF-8 byte rows. Durable Object SQLite caps each string/blob/row
// cell at ~2 MB; BLOB columns do not raise that ceiling, and SQL-side substr(?)
// chunking would still require binding the oversized value first, so event JSON
// is chunked in JS. `stream_metadata` durably preserves the shared durable +
// ephemeral offset allocator's high-water mark without storing ephemeral event
// bodies. `subscription_cursors` holds delivery cursors.
//
// The delivery cursors live in the same SQLite as the log on purpose:
// a cursor advance and the events it acknowledges commit under the same
// output gate, so the cursor can never disagree with the log it points into.
// Cursor rows are mutable STORAGE — per-batch acknowledgements must not double
// the event log — while halt/resume transitions are events appended to that log.
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
 * A committed event paired with its exact serialized byte length. Durable
 * event bytes are stored in `event_chunks`; ephemeral event bytes are held in
 * memory. Delivery batching uses this instead of repeatedly serializing.
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
    this.sql.exec(`
      -- The offset sequence includes memory-only ephemeral events, so it cannot
      -- be derived from the durable event rows. This singleton is the durable
      -- allocator floor; event bodies remain memory-only.
      create table if not exists stream_metadata (
        singleton integer primary key check (singleton = 1),
        highest_assigned_offset integer not null
      )
    `);

    const highestStoredOffset = this.highestOffset();
    const sqliteSequence =
      this.sql
        .exec<{ seq: number | null }>("select seq from sqlite_sequence where name = 'events'")
        .toArray()[0]?.seq ?? 0;
    const initialAssignedOffset = Math.max(highestStoredOffset, sqliteSequence);
    this.sql.exec(
      "insert or ignore into stream_metadata (singleton, highest_assigned_offset) values (1, ?)",
      initialAssignedOffset,
    );
    this.advanceHighestAssignedOffset(initialAssignedOffset);
  }

  highestOffset(): number {
    return (
      this.sql
        .exec<{ offset: number | null }>("select max(offset) as offset from events")
        .toArray()[0]?.offset ?? 0
    );
  }

  /** The highest durable offset — the last row a durable catch-up read can reach. */
  highestDurableOffset(): number {
    return (
      this.sql
        .exec<{
          offset: number | null;
        }>("select max(offset) as offset from events")
        .toArray()[0]?.offset ?? 0
    );
  }

  /**
   * The highest offset assigned to either a durable or ephemeral event.
   * Ephemeral bodies are absent from SQLite, so this explicit durable floor is
   * what prevents their offsets from being reissued after an incarnation ends.
   */
  highestAssignedOffset(): number {
    return (
      this.sql
        .exec<{ offset: number }>(
          "select highest_assigned_offset as offset from stream_metadata where singleton = 1",
        )
        .toArray()[0]?.offset ?? 0
    );
  }

  /** Persist the allocator floor without storing an ephemeral event body. */
  advanceHighestAssignedOffset(offset: number): void {
    this.sql.exec(
      `update stream_metadata
       set highest_assigned_offset = max(highest_assigned_offset, ?)
       where singleton = 1`,
      offset,
    );
  }

  /**
   * Returns each event's serialized byte length (the exact bytes written to
   * `event_chunks`), so the commit path can hand the send loops a sized
   * just-committed event without serializing it again. The insert also
   * advances the shared offset allocator floor through the last durable event.
   */
  insert(events: readonly StreamEvent[]): number[] {
    const byteLengths: number[] = [];
    for (const event of events) {
      if (event.ephemeral === true) {
        throw new Error("ephemeral events must not be written to the durable event log");
      }
      this.sql.exec(
        `insert into events (offset, type, created_at, idempotency_key)
         values (?, ?, ?, ?)`,
        event.offset,
        event.type,
        event.createdAt,
        event.idempotencyKey ?? null,
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
    const highestInsertedOffset = events.reduce(
      (highest, event) => Math.max(highest, event.offset),
      0,
    );
    if (highestInsertedOffset > 0) {
      this.advanceHighestAssignedOffset(highestInsertedOffset);
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
  }): SizedStreamEvent[] {
    if (args.eventTypes?.length === 0) return [];
    const eventTypes =
      args.eventTypes === undefined || args.eventTypes.includes("*") ? undefined : args.eventTypes;
    const eventTypeClause =
      eventTypes === undefined ? "" : `and type in (${eventTypes.map(() => "?").join(", ")})`;
    // One indexed metadata subquery picks the replay window; the join then streams each
    // event's chunks in primary-key order (offset, chunk_index).
    const chunks = this.sql
      .exec<{ offset: number; chunkIndex: number | null; chunkBytes: ArrayBuffer | null }>(
        `
          select
            selected.offset as offset,
            event_chunks.chunk_index as chunkIndex,
            event_chunks.chunk_bytes as chunkBytes
          from (
            select offset
            from events
            where offset > ?
              and offset < ?
              ${eventTypeClause}
            order by offset asc
            limit ?
          ) selected
          left join event_chunks on event_chunks.offset = selected.offset
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
      if (chunk.chunkIndex === null || chunk.chunkBytes === null) {
        throw new Error(`stream event at path "${this.path}", offset ${chunk.offset} has no body`);
      }
      const eventChunks = chunksByOffset.get(chunk.offset);
      if (eventChunks === undefined) {
        if (chunk.chunkIndex !== 0) {
          throw new Error(
            `stream event at path "${this.path}", offset ${chunk.offset} starts at body chunk ${chunk.chunkIndex}`,
          );
        }
        chunksByOffset.set(chunk.offset, [chunk.chunkBytes]);
      } else {
        if (chunk.chunkIndex !== eventChunks.length) {
          throw new Error(
            `stream event at path "${this.path}", offset ${chunk.offset} is missing body chunk ${eventChunks.length}`,
          );
        }
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
    return StreamEventSchema.parse(parsed);
  }
}

/** Delivery status of one cursor row, mirrored level-triggered from reduced state. */
export type SubscriptionCursorStatus = "active" | "halted";

/**
 * One stored subscription's delivery cursor row. The polymorphic single offset
 * is gone: ONE column whose meaning never varies by receiver kind.
 *
 * `confirmedOffset` (exclusive): the far side durably claims through here —
 * the awaited push acknowledgement (copy/itx/webhook), or the reported
 * checkpoint for hosted processors.
 *
 * The one scheduling rule, for every kind: delivery RESUMES after
 * `confirmedOffset`. Redelivery of anything sent-but-unconfirmed is the
 * at-least-once contract; receivers dedupe by (streamId, offset).
 */
export type SubscriptionCursorRow = {
  /** The subscription's opaque per-stream name (the row's primary key). */
  name: string;
  /** Exclusive: the receiver durably claims through this offset. */
  confirmedOffset: number;
  /** `active` delivers; `halted` = delivery gave up after the retry ladder. */
  status: SubscriptionCursorStatus;
  /** Offset of the source configuration this row belongs to. */
  configuredAtOffset: number;
  /** Consecutive delivery or hosted-processor wake failures since the last success. */
  attempt: number;
  /** Source offset whose receiver-specific failure is being confirmed. */
  failingEventOffset: number | null;
  /** Failures attributable to that exact event, independent of receiver outages. */
  failingEventAttempt: number;
  /**
   * Confirmed failing events skipped without an intervening successful
   * delivery. Durable because eviction must not reset the mass-skip fuse.
   */
  failingEventSkipsSinceLastSuccess: number;
  /** Wall-clock ms before which delivery must not retry; null when not backing off. */
  nextAttemptAt: number | null;
  /**
   * Deadline for one dispatched hosted-processor batch that has not acknowledged yet.
   * Persisted before the callback leaves the source DO, so eviction turns a
   * vanished in-memory connection into a bounded delivery failure on the next alarm.
   */
  inFlightDeadlineAt: number | null;
  /** Live connection generation that owns the watchdog; ignores a late older result. */
  inFlightConnectionGeneration: number | null;
  lastError: string | null;
  /** When `lastError` was recorded (ISO). Null with a non-null `lastError`
   * means the row predates the column — unknown age, not "just now". */
  lastErrorAt: string | null;
  /**
   * Offset of the configuration or cursor-set event that most recently chose
   * this cursor. A delivery remembers this offset before calling its receiver;
   * its late acknowledgement is ignored if an operator moved the cursor or
   * replaced the subscription while the call was running.
   */
  cursorChangedAtOffset: number;
};

/**
 * Durable delivery cursor rows. All methods are synchronous — the same
 * transaction boundary as the event log above.
 */
export type SubscriptionCursorStore = {
  get(name: string): SubscriptionCursorRow | undefined;
  list(): SubscriptionCursorRow[];
  /**
   * Create the row, or move it to a newly appended source configuration at
   * that configuration's declared initial cursor, resetting its counters
   * (`confirmedOffset = initialOffset`, status `active`).
   */
  ensure(name: string, initialOffset: number, configuredAtOffset: number): void;
  /**
   * Full push acknowledgement: the awaited receiver call resolved, so the far
   * side durably has the batch. Advances `confirmedOffset` (monotonic) and
   * clears failure state. When `cursorChangedAtOffset` is supplied, the
   * acknowledgement is ignored unless the row still names that exact
   * configuration or cursor-set event.
   */
  ack(
    name: string,
    offset: number,
    options?: {
      cursorChangedAtOffset?: number;
      preserveFailingEventSkips?: boolean;
    },
  ): void;
  /**
   * Atomically step over one confirmed failing event while incrementing the
   * durable consecutive-skip fuse. The configuration/cursor-set event offset
   * must still match, so replacement or seek wins over an in-flight failure.
   */
  ackFailingEventSkipped(name: string, offset: number, cursorChangedAtOffset: number): void;
  /**
   * The receiver's durable claim through `offset`: a hosted processor's
   * reported checkpoint. Advances `confirmedOffset` (monotonic) and always
   * clears the retry schedule and watchdog — the report proves the receiver
   * is reachable. The failure streak clears ONLY on confirmed progress: a
   * reachable receiver whose deliveries keep failing must still exhaust the
   * ladder instead of spinning forever.
   */
  confirm(name: string, offset: number, options?: { cursorChangedAtOffset?: number }): void;
  /** Persist one hosted batch's watchdog before invoking its remote callback. */
  markInFlight(
    name: string,
    args: {
      deadlineAt: number;
      connectionGeneration: number;
      cursorChangedAtOffset: number;
    },
  ): void;
  /**
   * Clear a successful hosted batch's watchdog and consecutive failure state.
   * The cursor is deliberately untouched: confirmation advances only on
   * reported checkpoints, so an eviction redelivers anything unconfirmed
   * (at-least-once).
   */
  clearInFlight(
    name: string,
    args: {
      connectionGeneration: number;
      cursorChangedAtOffset: number;
    },
  ): void;
  /** Failed delivery: record the consecutive attempt count and when to retry. */
  nack(
    name: string,
    args: {
      attempt: number;
      nextAttemptAt: number;
      error: string;
      failingEvent?: { offset: number; attempt: number };
    },
  ): void;
  /** Apply an explicit cursor-set event and clear delivery failure state. */
  setCursor(name: string, offset: number, cursorSetEventOffset: number): void;
  /** Mirror the reduced-state delivery status (active/halted) onto the row. */
  setStatus(name: string, status: SubscriptionCursorStatus): void;
  delete(name: string): void;
};

/** SQLite-backed {@link SubscriptionCursorStore}, sharing the stream's own database. */
export class SqliteSubscriptionCursorStore implements SubscriptionCursorStore {
  static db = defineConfig({
    // The desired schema now (`sqlfu draft` diffs new migrations against it).
    // Subscription-model redesign (CORE_STATE_VERSION 30): `name` primary key,
    // ONE cursor, and the mirrored delivery status. The cursor column is
    // `processed_through_offset` (v2/v3 named it `confirmed_offset`; the v4
    // migration renames it — the domain field stays `confirmedOffset`).
    definitions: sql`
      create table subscription_cursors (
        name text primary key,
        configured_at_offset integer not null,
        cursor_changed_at_offset integer not null,
        processed_through_offset integer not null,
        status text not null default 'active',
        attempt integer not null default 0,
        next_attempt_at integer,
        failing_event_offset integer,
        failing_event_attempt integer not null default 0,
        failing_event_skips_since_last_success integer not null default 0,
        last_error text,
        last_error_at text,
        in_flight_deadline_at integer,
        in_flight_connection_generation integer,
        updated_at text not null
      );
    `,
    migrations: [
      {
        // Byte-identical to the text preview/dev Stream DOs already applied —
        // sqlfu checksums applied migrations, so this entry may never change.
        // The diet's shape changes land in _v3 below (drop + recreate), which
        // is correct from ANY prior state; prd is erased at deploy regardless.
        name: "20260803000001_create_subscription_cursors_v2",
        content: sql`
          create table subscription_cursors (
            name text primary key,
            configured_at_offset integer not null,
            cursor_changed_at_offset integer not null,
            delivered_offset integer not null,
            confirmed_offset integer not null,
            state text not null default 'active',
            attempt integer not null default 0,
            next_attempt_at integer,
            failing_event_offset integer,
            failing_event_attempt integer not null default 0,
            failing_event_skips_since_last_success integer not null default 0,
            last_error text,
            in_flight_deadline_at integer,
            in_flight_connection_generation integer,
            updated_at text not null
          );
        `,
      },
      {
        // The diet's final shape: one confirmed cursor, status vocabulary.
        // Drop + recreate rather than alter: cursor rows are resumable
        // bookkeeping (processor checkpoints are authoritative; source-owned
        // kinds redeliver from their configured start), so rebuilding from
        // empty on already-deployed preview/dev streams is safe and keeps
        // this migration valid from any prior state.
        name: "20260806000001_create_subscription_cursors_v3",
        content: sql`
          drop table if exists subscription_cursors;
          create table subscription_cursors (
            name text primary key,
            configured_at_offset integer not null,
            cursor_changed_at_offset integer not null,
            confirmed_offset integer not null,
            status text not null default 'active',
            attempt integer not null default 0,
            next_attempt_at integer,
            failing_event_offset integer,
            failing_event_attempt integer not null default 0,
            failing_event_skips_since_last_success integer not null default 0,
            last_error text,
            in_flight_deadline_at integer,
            in_flight_connection_generation integer,
            updated_at text not null
          );
        `,
      },
      {
        // The internal cursor column is named for what it stores: the offset
        // the receiver has processed through. The domain field stays
        // `confirmedOffset` (the delivery contract's word). RENAME COLUMN is
        // valid from the v3 state and preserves the live rows, so it is safe
        // to add after the flag-day deploy already applied v2 + v3.
        name: "20260807000001_rename_confirmed_offset_to_processed_through_offset",
        content: sql`
          alter table subscription_cursors
          rename column confirmed_offset to processed_through_offset;
        `,
      },
      {
        // Error age beside the error: the skip policy leaves last_error
        // standing with zero lag, so health surfaces need to know how stale
        // it is. Null on rows written before this column = unknown age.
        name: "20260825000001_add_last_error_at",
        content: sql`
          alter table subscription_cursors add column last_error_at text;
        `,
      },
    ],
    queries: {
      get: sql.nullableOne<{
        parameters: { name: string };
        result: SubscriptionCursorRowRecord;
      }>`
        select name, processed_through_offset, status, configured_at_offset,
               attempt, next_attempt_at, in_flight_deadline_at,
               in_flight_connection_generation, last_error, last_error_at,
               failing_event_offset, failing_event_attempt,
               failing_event_skips_since_last_success, cursor_changed_at_offset
        from subscription_cursors
        where name = :name
      `,
      list: sql.many<{ result: SubscriptionCursorRowRecord }>`
        select name, processed_through_offset, status, configured_at_offset,
               attempt, next_attempt_at, in_flight_deadline_at,
               in_flight_connection_generation, last_error, last_error_at,
               failing_event_offset, failing_event_attempt,
               failing_event_skips_since_last_success, cursor_changed_at_offset
        from subscription_cursors
      `,
      ensure: sql.run<{
        parameters: {
          name: string;
          initialOffset: number;
          configuredAtOffset: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        insert into subscription_cursors (
          name, processed_through_offset, configured_at_offset,
          cursor_changed_at_offset, updated_at
        ) values (
          :name, :initialOffset, :configuredAtOffset,
          :cursorChangedAtOffset, :updatedAt
        )
        on conflict (name) do update set
          processed_through_offset = excluded.processed_through_offset,
          status = 'active',
          configured_at_offset = excluded.configured_at_offset,
          attempt = 0,
          next_attempt_at = null,
          in_flight_deadline_at = null,
          in_flight_connection_generation = null,
          last_error = null, last_error_at = null,
          failing_event_offset = null,
          failing_event_attempt = 0,
          failing_event_skips_since_last_success = 0,
          cursor_changed_at_offset = excluded.cursor_changed_at_offset,
          updated_at = excluded.updated_at
        where subscription_cursors.configured_at_offset <> excluded.configured_at_offset
      `,
      ack: sql.run<{
        parameters: {
          name: string;
          offset: number;
          preserveFailingEventSkips: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set processed_through_offset = max(processed_through_offset, :offset),
            attempt = 0, next_attempt_at = null, in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            last_error = null, last_error_at = null,
            failing_event_offset = null, failing_event_attempt = 0,
            failing_event_skips_since_last_success = case
              when :preserveFailingEventSkips = 1 then failing_event_skips_since_last_success else 0 end,
            updated_at = :updatedAt
        where name = :name
      `,
      ackIfCursorUnchanged: sql.run<{
        parameters: {
          name: string;
          offset: number;
          preserveFailingEventSkips: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set processed_through_offset = max(processed_through_offset, :offset),
            attempt = 0, next_attempt_at = null, in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            last_error = null, last_error_at = null,
            failing_event_offset = null, failing_event_attempt = 0,
            failing_event_skips_since_last_success = case
              when :preserveFailingEventSkips = 1 then failing_event_skips_since_last_success else 0 end,
            updated_at = :updatedAt
        where name = :name
          and cursor_changed_at_offset = :cursorChangedAtOffset
      `,
      ackFailingEventSkipped: sql.run<{
        parameters: {
          name: string;
          offset: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set processed_through_offset = max(processed_through_offset, :offset),
            attempt = 0, next_attempt_at = null, in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            last_error = null, last_error_at = null,
            failing_event_offset = null, failing_event_attempt = 0,
            failing_event_skips_since_last_success = failing_event_skips_since_last_success + 1,
            updated_at = :updatedAt
        where name = :name
          and cursor_changed_at_offset = :cursorChangedAtOffset
      `,
      // Every column reference on the right-hand side reads the PRE-update
      // row, so the progress comparisons and the monotonic max are all
      // against the same consistent snapshot.
      confirm: sql.run<{
        parameters: { name: string; offset: number; updatedAt: string };
      }>`
        update subscription_cursors
        set attempt = case when :offset > processed_through_offset then 0 else attempt end,
            last_error = case when :offset > processed_through_offset then null else last_error end,
            last_error_at = case when :offset > processed_through_offset then null else last_error_at end,
            failing_event_offset = case when :offset > processed_through_offset then null else failing_event_offset end,
            failing_event_attempt = case when :offset > processed_through_offset then 0 else failing_event_attempt end,
            failing_event_skips_since_last_success = case
              when :offset > processed_through_offset then 0 else failing_event_skips_since_last_success end,
            next_attempt_at = null,
            in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            processed_through_offset = max(processed_through_offset, :offset),
            updated_at = :updatedAt
        where name = :name
      `,
      confirmIfCursorUnchanged: sql.run<{
        parameters: {
          name: string;
          offset: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set attempt = case when :offset > processed_through_offset then 0 else attempt end,
            last_error = case when :offset > processed_through_offset then null else last_error end,
            last_error_at = case when :offset > processed_through_offset then null else last_error_at end,
            failing_event_offset = case when :offset > processed_through_offset then null else failing_event_offset end,
            failing_event_attempt = case when :offset > processed_through_offset then 0 else failing_event_attempt end,
            failing_event_skips_since_last_success = case
              when :offset > processed_through_offset then 0 else failing_event_skips_since_last_success end,
            next_attempt_at = null,
            in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            processed_through_offset = max(processed_through_offset, :offset),
            updated_at = :updatedAt
        where name = :name
          and cursor_changed_at_offset = :cursorChangedAtOffset
      `,
      markInFlight: sql.run<{
        parameters: {
          name: string;
          deadlineAt: number;
          connectionGeneration: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set in_flight_deadline_at = :deadlineAt,
            in_flight_connection_generation = :connectionGeneration,
            updated_at = :updatedAt
        where name = :name
          and cursor_changed_at_offset = :cursorChangedAtOffset
      `,
      clearInFlight: sql.run<{
        parameters: {
          name: string;
          connectionGeneration: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set attempt = 0, next_attempt_at = null, last_error = null, last_error_at = null,
            in_flight_deadline_at = null, in_flight_connection_generation = null,
            failing_event_offset = null, failing_event_attempt = 0,
            failing_event_skips_since_last_success = 0,
            updated_at = :updatedAt
        where name = :name
          and cursor_changed_at_offset = :cursorChangedAtOffset
          and in_flight_connection_generation = :connectionGeneration
      `,
      nack: sql.run<{
        parameters: {
          name: string;
          attempt: number;
          nextAttemptAt: number;
          error: string;
          failingEventOffset: number | null;
          failingEventAttempt: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set attempt = :attempt, next_attempt_at = :nextAttemptAt, last_error = :error,
            last_error_at = :updatedAt,
            in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            failing_event_offset = :failingEventOffset, failing_event_attempt = :failingEventAttempt,
            updated_at = :updatedAt
        where name = :name
      `,
      setCursor: sql.run<{
        parameters: {
          name: string;
          offset: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set processed_through_offset = :offset,
            attempt = 0, next_attempt_at = null, last_error = null, last_error_at = null,
            in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            failing_event_offset = null, failing_event_attempt = 0, failing_event_skips_since_last_success = 0,
            cursor_changed_at_offset = :cursorChangedAtOffset, updated_at = :updatedAt
        where name = :name
      `,
      setStatus: sql.run<{
        parameters: { name: string; status: string; updatedAt: string };
      }>`
        update subscription_cursors
        set status = :status, updated_at = :updatedAt
        where name = :name
      `,
      delete: sql.run<{ parameters: { name: string } }>`
        delete from subscription_cursors where name = :name
      `,
    },
  });

  #db: ReturnType<
    typeof SqliteSubscriptionCursorStore.db<ReturnType<typeof createDurableObjectClient>>
  >;
  readonly #onMutation: () => void;

  constructor(sql: SqlStorage, options: { onMutation?: () => void } = {}) {
    this.#onMutation = options.onMutation ?? (() => undefined);
    // {sql} without transactionSync: this store only holds SqlStorage. That
    // forgoes sqlfu's per-migration transaction, which is fine here — the
    // constructor is await-free, and Durable Object SQLite commits all writes
    // in one event-loop task atomically, so a crash mid-migration cannot
    // persist a half-applied state.
    this.#db = SqliteSubscriptionCursorStore.db(createDurableObjectClient({ sql }));
    this.#db.migrate();
  }

  get(name: string): SubscriptionCursorRow | undefined {
    const record = this.#db.get({ name });
    return record ? rowFromRecord(record) : undefined;
  }

  list(): SubscriptionCursorRow[] {
    return this.#db.list().map(rowFromRecord);
  }

  ensure(name: string, initialOffset: number, configuredAtOffset: number): void {
    this.#db.ensure({
      name,
      initialOffset,
      configuredAtOffset,
      // The immutable configuration event offset also distinguishes a
      // remove+recreate using the same name.
      cursorChangedAtOffset: configuredAtOffset,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  ack(
    name: string,
    offset: number,
    options: {
      cursorChangedAtOffset?: number;
      preserveFailingEventSkips?: boolean;
    } = {},
  ): void {
    const params = {
      name,
      offset,
      preserveFailingEventSkips: options.preserveFailingEventSkips === true ? 1 : 0,
      updatedAt: new Date().toISOString(),
    };
    if (options.cursorChangedAtOffset === undefined) {
      this.#db.ack(params);
    } else {
      this.#db.ackIfCursorUnchanged({
        ...params,
        cursorChangedAtOffset: options.cursorChangedAtOffset,
      });
    }
    this.#onMutation();
  }

  ackFailingEventSkipped(name: string, offset: number, cursorChangedAtOffset: number): void {
    this.#db.ackFailingEventSkipped({
      name,
      offset,
      cursorChangedAtOffset,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  confirm(name: string, offset: number, options: { cursorChangedAtOffset?: number } = {}): void {
    const params = { name, offset, updatedAt: new Date().toISOString() };
    if (options.cursorChangedAtOffset === undefined) {
      this.#db.confirm(params);
    } else {
      this.#db.confirmIfCursorUnchanged({
        ...params,
        cursorChangedAtOffset: options.cursorChangedAtOffset,
      });
    }
    this.#onMutation();
  }

  markInFlight(
    name: string,
    args: {
      deadlineAt: number;
      connectionGeneration: number;
      cursorChangedAtOffset: number;
    },
  ): void {
    this.#db.markInFlight({
      name,
      ...args,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  clearInFlight(
    name: string,
    args: {
      connectionGeneration: number;
      cursorChangedAtOffset: number;
    },
  ): void {
    this.#db.clearInFlight({
      name,
      ...args,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  nack(
    name: string,
    args: {
      attempt: number;
      nextAttemptAt: number;
      error: string;
      failingEvent?: { offset: number; attempt: number };
    },
  ): void {
    this.#db.nack({
      name,
      attempt: args.attempt,
      nextAttemptAt: args.nextAttemptAt,
      // Bound the stored error so a pathological message cannot bloat the row.
      error: args.error.slice(0, 2_000),
      failingEventOffset: args.failingEvent?.offset ?? null,
      failingEventAttempt: args.failingEvent?.attempt ?? 0,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  setCursor(name: string, offset: number, cursorSetEventOffset: number): void {
    this.#db.setCursor({
      name,
      offset,
      cursorChangedAtOffset: cursorSetEventOffset,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  setStatus(name: string, status: SubscriptionCursorStatus): void {
    this.#db.setStatus({ name, status, updatedAt: new Date().toISOString() });
    this.#onMutation();
  }

  delete(name: string): void {
    this.#db.delete({ name });
    this.#onMutation();
  }
}

/**
 * Clear stale failure state after rebuilding reduced configuration from the
 * event log (core state version mismatch). Cursor rows survive the KV state,
 * so after a rebuild they can describe a world the new fold no longer
 * derives: a row whose config event no longer parses is orphaned (its
 * `next_attempt_at` would arm alarms forever), and a surviving row's backoff
 * may blame code the new version replaced. Progress is kept — the confirmed
 * offset is monotonic truth about the same immutable log — while failure
 * state is cleared so every survivor gets an immediate fresh try under the
 * new fold. Delivery-halted subscriptions keep their failure evidence in the
 * durable halt event, so their mutable cursor rows can be cleaned in the same
 * way as active subscriptions.
 */
export function clearSubscriptionCursorFailuresAfterStateRebuild(
  store: SubscriptionCursorStore,
  configuredSubscriptionNames: ReadonlySet<string>,
): void {
  for (const row of store.list()) {
    if (
      configuredSubscriptionNames.has(row.name) &&
      (row.attempt !== 0 ||
        row.nextAttemptAt !== null ||
        row.inFlightDeadlineAt !== null ||
        row.lastError !== null ||
        row.failingEventOffset !== null ||
        row.failingEventAttempt !== 0 ||
        row.failingEventSkipsSinceLastSuccess !== 0)
    ) {
      // Acknowledge at the row's own confirmed position: keeps the cursor,
      // clears attempt/backoff without inventing a confirmation the receiver
      // never made (the monotonic max makes an equal-offset ack a no-move).
      store.ack(row.name, row.confirmedOffset);
    }
  }
}

/**
 * Remove rows with no configured subscription. Run on every boot: a
 * lifecycle interruption may land after the removal event commits but before
 * its post-commit row deletion side effect.
 */
export function pruneOrphanedSubscriptionCursorRows(
  store: SubscriptionCursorStore,
  configuredSubscriptionNames: ReadonlySet<string>,
): void {
  for (const row of store.list()) {
    if (!configuredSubscriptionNames.has(row.name)) store.delete(row.name);
  }
}

type SubscriptionCursorRowRecord = {
  name: string;
  processed_through_offset: number;
  status: string;
  configured_at_offset: number;
  attempt: number;
  next_attempt_at: number | null;
  in_flight_deadline_at: number | null;
  in_flight_connection_generation: number | null;
  last_error: string | null;
  last_error_at: string | null;
  failing_event_offset: number | null;
  failing_event_attempt: number;
  failing_event_skips_since_last_success: number;
  cursor_changed_at_offset: number;
};

function rowFromRecord(record: SubscriptionCursorRowRecord): SubscriptionCursorRow {
  return {
    name: record.name,
    confirmedOffset: record.processed_through_offset,
    // Safe: the TEXT column is written exclusively by this store from typed
    // SubscriptionCursorRow values, so it only ever holds
    // SubscriptionCursorStatus members; SQLite just can't express the union.
    status: record.status as SubscriptionCursorStatus,
    configuredAtOffset: record.configured_at_offset,
    attempt: record.attempt,
    nextAttemptAt: record.next_attempt_at,
    inFlightDeadlineAt: record.in_flight_deadline_at,
    inFlightConnectionGeneration: record.in_flight_connection_generation,
    lastError: record.last_error,
    lastErrorAt: record.last_error_at,
    failingEventOffset: record.failing_event_offset,
    failingEventAttempt: record.failing_event_attempt,
    failingEventSkipsSinceLastSuccess: record.failing_event_skips_since_last_success,
    cursorChangedAtOffset: record.cursor_changed_at_offset,
  };
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
