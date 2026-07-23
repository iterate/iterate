// The stream's append log — and its delivery cursors — in Durable Object SQLite.
//
// Storage is normalized into two tables: `events` is the offset-ordered
// metadata/index, and `event_chunks` holds the full event JSON as bounded
// UTF-8 byte rows. Durable Object SQLite caps each string/blob/row cell at
// ~2 MB; BLOB columns do not raise that ceiling, and SQL-side substr(?)
// chunking would still require binding the oversized value first, so event
// JSON is chunked in JS.
//
// A third table, `subscription_cursors`, holds delivery cursors. A fourth records
// retries when a source cannot send its current cross-post list to a
// receiving stream. They live in the same SQLite as the log on purpose:
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
const REQUIRED_EVENT_COLUMNS = [
  "cross_post_list_source_path",
  "cross_post_list_source_created_at_ms",
  "cross_post_list_source_stream_id",
  "cross_post_list_source_offset",
  "cross_post_list_confirmed_receiving_stream_path",
  "cross_post_list_confirmed_source_offset",
] as const;

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
        ephemeral integer not null default 0,
        cross_post_list_source_path text,
        cross_post_list_source_created_at_ms integer,
        cross_post_list_source_stream_id text,
        cross_post_list_source_offset integer,
        cross_post_list_confirmed_receiving_stream_path text,
        cross_post_list_confirmed_source_offset integer
      )
    `);
    const eventColumns = new Set(
      this.sql
        .exec<{ name: string }>("pragma table_info(events)")
        .toArray()
        .map(({ name }) => name),
    );
    const missingEventColumns = REQUIRED_EVENT_COLUMNS.filter(
      (column) => !eventColumns.has(column),
    );
    if (missingEventColumns.length > 0) {
      throw new Error(
        `stream storage at "${this.path}" predates the cross-post subscription schema (missing events columns: ${missingEventColumns.join(", ")}); erase and recreate this stream before deploying this version`,
      );
    }
    this.sql.exec(`
      -- Empty source lists disappear from reduced state. These metadata fields
      -- retain the source lifetime and offset on the immutable event row,
      -- allowing a delayed RPC from either an older offset or a destroyed
      -- source lifetime to be rejected without retaining an empty cross-post list.
      create index if not exists events_cross_post_list_source_position
      on events (
        cross_post_list_source_path,
        cross_post_list_source_created_at_ms desc,
        cross_post_list_source_stream_id desc,
        cross_post_list_source_offset desc,
        offset desc
      )
      where cross_post_list_source_path is not null
    `);
    this.sql.exec(`
      -- Source-side records retain the receiver event that stored each
      -- complete list. This index makes an already-completed command a
      -- local read even after an empty list removed its reduced-state tracker.
      create index if not exists events_cross_post_list_confirmed_source_offset
      on events (cross_post_list_confirmed_receiving_stream_path, cross_post_list_confirmed_source_offset desc)
      where cross_post_list_confirmed_receiving_stream_path is not null
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

  /** The highest DURABLE offset — the last row a default (ephemeral-excluding)
   * catch-up read can actually reach, and therefore the only maximum offset a fold barrier
   * may wait for. Robust against a future ephemeral-row eviction sweep. */
  highestDurableOffset(): number {
    return (
      this.sql
        .exec<{
          offset: number | null;
        }>("select max(offset) as offset from events where ephemeral = 0")
        .toArray()[0]?.offset ?? 0
    );
  }

  /**
   * The highest offset ever INSERTED, even if its row was since deleted —
   * AUTOINCREMENT's sqlite_sequence row is updated by every insert (explicit
   * offsets included) and survives row deletion. This is the offset
   * allocator's recovery floor: a future ephemeral-row eviction sweep may
   * delete the highest row, and reseeding the allocator from max(offset)
   * would then reissue offsets that open callback connections already saw.
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
   * `event_chunks`), so the commit path can hand the send loops a sized
   * just-committed events without serializing them again.
   */
  insert(events: readonly StreamEvent[]): number[] {
    const byteLengths: number[] = [];
    for (const event of events) {
      const crossPostListRecordedEvent =
        event.type === "events.iterate.com/stream/cross-post-list-recorded" &&
        event.source?.crossPostedFrom === undefined
          ? (event.payload as {
              source: { path: string; streamId: string; streamCreatedAt: string };
              sourceOffset: number;
            })
          : undefined;
      const crossPostListConfirmedEvent =
        event.type === "events.iterate.com/stream/cross-post-list-confirmed" &&
        event.source?.crossPostedFrom === undefined
          ? (event.payload as {
              receivingStreamPath: string;
              sourceOffset: number;
            })
          : undefined;
      this.sql.exec(
        `insert into events (
           offset, type, created_at, idempotency_key, ephemeral,
           cross_post_list_source_path, cross_post_list_source_created_at_ms,
           cross_post_list_source_stream_id, cross_post_list_source_offset,
           cross_post_list_confirmed_receiving_stream_path, cross_post_list_confirmed_source_offset
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.offset,
        event.type,
        event.createdAt,
        event.idempotencyKey ?? null,
        event.ephemeral === true ? 1 : 0,
        crossPostListRecordedEvent?.source.path ?? null,
        crossPostListRecordedEvent === undefined
          ? null
          : Date.parse(crossPostListRecordedEvent.source.streamCreatedAt),
        crossPostListRecordedEvent?.source.streamId ?? null,
        crossPostListRecordedEvent?.sourceOffset ?? null,
        crossPostListConfirmedEvent?.receivingStreamPath ?? null,
        crossPostListConfirmedEvent?.sourceOffset ?? null,
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

  /** Latest complete list of subscriptions recorded from one source stream. */
  getLatestCrossPostListFromSource(sourcePath: string): StreamEvent | undefined {
    const row = this.sql
      .exec<{ offset: number }>(
        `select offset
         from events
         where cross_post_list_source_path = ?
         order by
           cross_post_list_source_created_at_ms desc,
           cross_post_list_source_stream_id desc,
           cross_post_list_source_offset desc,
           offset desc
         limit 1`,
        sourcePath,
      )
      .toArray()[0];
    return row === undefined ? undefined : this.#readEventFromChunks(row.offset);
  }

  /** Latest source-side event recording that one receiving stream stored its cross-post list. */
  getLatestCrossPostListConfirmationForReceivingStream(
    receivingStreamPath: string,
  ): StreamEvent | undefined {
    const row = this.sql
      .exec<{ offset: number }>(
        `select offset
         from events
         where cross_post_list_confirmed_receiving_stream_path = ?
         order by cross_post_list_confirmed_source_offset desc
         limit 1`,
        receivingStreamPath,
      )
      .toArray()[0];
    return row === undefined ? undefined : this.#readEventFromChunks(row.offset);
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
              ${ephemeralClause}
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

/**
 * One stored subscription's delivery cursor row. `acknowledgedOffset` is exclusive
 * (delivery resumes at +1). For cross-post, ITX-call, and webhook subscriptions
 * it is the authoritative cursor: it advances only when the awaited call resolves. For
 * hosted processors it is the checkpoint reported by the processor on its
 * hosted processor reported on the last successful wake, used only to decide
 * whether another wake is needed and to display lag — the processor's
 * own `{offset, state}` snapshot is the truth, and a lost or stale row costs one
 * redundant wake call, nothing
 * more.
 */
export type SubscriptionCursorRow = {
  subscriptionKey: string;
  acknowledgedOffset: number;
  /** Offset of the source configuration this row and its acknowledgement count belong to. */
  configuredAtOffset: number;
  /** Product events acknowledged since this source configuration was appended. */
  acknowledgedEvents: number;
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
  get(subscriptionKey: string): SubscriptionCursorRow | undefined;
  list(): SubscriptionCursorRow[];
  /**
   * Create the row, or move it to a newly appended source configuration at
   * that configuration's declared initial cursor, resetting its counters.
   */
  ensure(subscriptionKey: string, acknowledgedOffset: number, configuredAtOffset: number): void;
  /**
   * Successful delivery: advance the cursor (monotonic), clear failure state.
   * When `cursorChangedAtOffset` is supplied, the acknowledgement is ignored
   * unless the row still names that exact configuration or cursor-set event.
   */
  ack(
    subscriptionKey: string,
    acknowledgedOffset: number,
    options?: {
      cursorChangedAtOffset?: number;
      acknowledgedEvents?: number;
      preserveFailingEventSkips?: boolean;
    },
  ): void;
  /**
   * Atomically step over one confirmed failing event while incrementing the
   * durable consecutive-skip fuse. The configuration/cursor-set event offset
   * must still match, so replacement or seek wins over an in-flight failure.
   */
  ackFailingEventSkipped(
    subscriptionKey: string,
    acknowledgedOffset: number,
    cursorChangedAtOffset: number,
  ): void;
  /**
   * Record a hosted processor's reported checkpoint after a wake response
   * whose checkpoint did NOT progress. Clears the retry schedule (the wake call
   * consumed it; a live connection has no pending retry to arm) but KEEPS the
   * failure streak — a successful wake proves the host is reachable, not
   * that deliveries succeed, and resetting the counter here is what let a
   * deterministically failing processor spin forever without ever halting.
   */
  recordReportedCheckpoint(subscriptionKey: string, acknowledgedOffset: number): void;
  /** Persist one hosted batch's watchdog before invoking its remote callback. */
  markInFlight(
    subscriptionKey: string,
    args: {
      deadlineAt: number;
      connectionGeneration: number;
      cursorChangedAtOffset: number;
    },
  ): void;
  /** Clear a successful hosted batch's watchdog and consecutive failure state. */
  clearInFlight(
    subscriptionKey: string,
    args: { connectionGeneration: number; cursorChangedAtOffset: number },
  ): void;
  /** Failed delivery: record the consecutive attempt count and when to retry. */
  nack(
    subscriptionKey: string,
    args: {
      attempt: number;
      nextAttemptAt: number;
      error: string;
      failingEvent?: { offset: number; attempt: number };
    },
  ): void;
  /** Apply an explicit cursor-set event and clear delivery failure state. */
  setCursor(
    subscriptionKey: string,
    acknowledgedOffset: number,
    cursorSetEventOffset: number,
  ): void;
  delete(subscriptionKey: string): void;
};

/** SQLite-backed {@link SubscriptionCursorStore}, sharing the stream's own database. */
export class SqliteSubscriptionCursorStore implements SubscriptionCursorStore {
  static db = defineConfig({
    // The desired schema now (`sqlfu draft` diffs new migrations against it).
    definitions: sql`
      create table subscription_cursors (
        subscription_key text primary key,
        acknowledged_offset integer not null,
        attempt integer not null default 0,
        next_attempt_at integer,
        in_flight_deadline_at integer,
        in_flight_connection_generation integer,
        last_error text,
        failing_event_offset integer,
        failing_event_attempt integer not null default 0,
        failing_event_skips_since_last_success integer not null default 0,
        cursor_changed_at_offset integer not null,
        configured_at_offset integer not null,
        acknowledged_events integer not null default 0,
        updated_at text not null
      );
    `,
    migrations: [
      {
        name: "20260721000001_create_subscription_cursors",
        content: sql`
          create table subscription_cursors (
            subscription_key text primary key,
            acknowledged_offset integer not null,
            attempt integer not null default 0,
            next_attempt_at integer,
            in_flight_deadline_at integer,
            in_flight_connection_generation integer,
            last_error text,
            failing_event_offset integer,
            failing_event_attempt integer not null default 0,
            failing_event_skips_since_last_success integer not null default 0,
            cursor_changed_at_offset integer not null,
            configured_at_offset integer not null,
            acknowledged_events integer not null default 0,
            updated_at text not null
          );
        `,
      },
    ],
    queries: {
      get: sql.nullableOne<{
        parameters: { subscriptionKey: string };
        result: SubscriptionCursorRowRecord;
      }>`
        select subscription_key, acknowledged_offset, configured_at_offset, acknowledged_events,
               attempt, next_attempt_at, in_flight_deadline_at,
               in_flight_connection_generation, last_error,
               failing_event_offset, failing_event_attempt,
               failing_event_skips_since_last_success, cursor_changed_at_offset
        from subscription_cursors
        where subscription_key = :subscriptionKey
      `,
      list: sql.many<{ result: SubscriptionCursorRowRecord }>`
        select subscription_key, acknowledged_offset, configured_at_offset, acknowledged_events,
               attempt, next_attempt_at, in_flight_deadline_at,
               in_flight_connection_generation, last_error,
               failing_event_offset, failing_event_attempt,
               failing_event_skips_since_last_success, cursor_changed_at_offset
        from subscription_cursors
      `,
      ensure: sql.run<{
        parameters: {
          subscriptionKey: string;
          acknowledgedOffset: number;
          configuredAtOffset: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        insert into subscription_cursors (
          subscription_key, acknowledged_offset, configured_at_offset,
          cursor_changed_at_offset, updated_at
        ) values (
          :subscriptionKey, :acknowledgedOffset, :configuredAtOffset,
          :cursorChangedAtOffset, :updatedAt
        )
        on conflict (subscription_key) do update set
          acknowledged_offset = excluded.acknowledged_offset,
          configured_at_offset = excluded.configured_at_offset,
          acknowledged_events = 0,
          attempt = 0,
          next_attempt_at = null,
          in_flight_deadline_at = null,
          in_flight_connection_generation = null,
          last_error = null,
          failing_event_offset = null,
          failing_event_attempt = 0,
          failing_event_skips_since_last_success = 0,
          cursor_changed_at_offset = excluded.cursor_changed_at_offset,
          updated_at = excluded.updated_at
        where subscription_cursors.configured_at_offset <> excluded.configured_at_offset
      `,
      ack: sql.run<{
        parameters: {
          subscriptionKey: string;
          acknowledgedOffset: number;
          acknowledgedEvents: number;
          preserveFailingEventSkips: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set acknowledged_events = acknowledged_events +
              case when :acknowledgedOffset > acknowledged_offset then :acknowledgedEvents else 0 end,
            acknowledged_offset = max(acknowledged_offset, :acknowledgedOffset),
            attempt = 0, next_attempt_at = null, in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            last_error = null,
            failing_event_offset = null, failing_event_attempt = 0,
            failing_event_skips_since_last_success = case
              when :preserveFailingEventSkips = 1 then failing_event_skips_since_last_success else 0 end,
            updated_at = :updatedAt
        where subscription_key = :subscriptionKey
      `,
      ackIfCursorUnchanged: sql.run<{
        parameters: {
          subscriptionKey: string;
          acknowledgedOffset: number;
          acknowledgedEvents: number;
          preserveFailingEventSkips: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set acknowledged_events = acknowledged_events +
              case when :acknowledgedOffset > acknowledged_offset then :acknowledgedEvents else 0 end,
            acknowledged_offset = max(acknowledged_offset, :acknowledgedOffset),
            attempt = 0, next_attempt_at = null, in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            last_error = null,
            failing_event_offset = null, failing_event_attempt = 0,
            failing_event_skips_since_last_success = case
              when :preserveFailingEventSkips = 1 then failing_event_skips_since_last_success else 0 end,
            updated_at = :updatedAt
        where subscription_key = :subscriptionKey
          and cursor_changed_at_offset = :cursorChangedAtOffset
      `,
      ackFailingEventSkipped: sql.run<{
        parameters: {
          subscriptionKey: string;
          acknowledgedOffset: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set acknowledged_offset = max(acknowledged_offset, :acknowledgedOffset),
            attempt = 0, next_attempt_at = null, in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            last_error = null,
            failing_event_offset = null, failing_event_attempt = 0,
            failing_event_skips_since_last_success = failing_event_skips_since_last_success + 1,
            updated_at = :updatedAt
        where subscription_key = :subscriptionKey
          and cursor_changed_at_offset = :cursorChangedAtOffset
      `,
      recordReportedCheckpoint: sql.run<{
        parameters: { subscriptionKey: string; acknowledgedOffset: number; updatedAt: string };
      }>`
        update subscription_cursors
        set acknowledged_offset = max(acknowledged_offset, :acknowledgedOffset), next_attempt_at = null,
            in_flight_deadline_at = null, in_flight_connection_generation = null,
            updated_at = :updatedAt
        where subscription_key = :subscriptionKey
      `,
      markInFlight: sql.run<{
        parameters: {
          subscriptionKey: string;
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
        where subscription_key = :subscriptionKey
          and cursor_changed_at_offset = :cursorChangedAtOffset
      `,
      clearInFlight: sql.run<{
        parameters: {
          subscriptionKey: string;
          connectionGeneration: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set attempt = 0, next_attempt_at = null, last_error = null,
            in_flight_deadline_at = null, in_flight_connection_generation = null,
            failing_event_offset = null, failing_event_attempt = 0,
            failing_event_skips_since_last_success = 0,
            updated_at = :updatedAt
        where subscription_key = :subscriptionKey
          and cursor_changed_at_offset = :cursorChangedAtOffset
          and in_flight_connection_generation = :connectionGeneration
      `,
      nack: sql.run<{
        parameters: {
          subscriptionKey: string;
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
            in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            failing_event_offset = :failingEventOffset, failing_event_attempt = :failingEventAttempt,
            updated_at = :updatedAt
        where subscription_key = :subscriptionKey
      `,
      setCursor: sql.run<{
        parameters: {
          subscriptionKey: string;
          acknowledgedOffset: number;
          cursorChangedAtOffset: number;
          updatedAt: string;
        };
      }>`
        update subscription_cursors
        set acknowledged_offset = :acknowledgedOffset, attempt = 0, next_attempt_at = null, last_error = null,
            in_flight_deadline_at = null,
            in_flight_connection_generation = null,
            failing_event_offset = null, failing_event_attempt = 0, failing_event_skips_since_last_success = 0,
            cursor_changed_at_offset = :cursorChangedAtOffset, updated_at = :updatedAt
        where subscription_key = :subscriptionKey
      `,
      delete: sql.run<{ parameters: { subscriptionKey: string } }>`
        delete from subscription_cursors where subscription_key = :subscriptionKey
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

  get(subscriptionKey: string): SubscriptionCursorRow | undefined {
    const record = this.#db.get({ subscriptionKey });
    return record ? rowFromRecord(record) : undefined;
  }

  list(): SubscriptionCursorRow[] {
    return this.#db.list().map(rowFromRecord);
  }

  ensure(subscriptionKey: string, acknowledgedOffset: number, configuredAtOffset: number): void {
    this.#db.ensure({
      subscriptionKey,
      acknowledgedOffset,
      configuredAtOffset,
      // The immutable configuration event offset also distinguishes a
      // remove+recreate using the same key.
      cursorChangedAtOffset: configuredAtOffset,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  ack(
    subscriptionKey: string,
    acknowledgedOffset: number,
    options: {
      cursorChangedAtOffset?: number;
      acknowledgedEvents?: number;
      preserveFailingEventSkips?: boolean;
    } = {},
  ): void {
    const params = {
      subscriptionKey,
      acknowledgedOffset,
      acknowledgedEvents: options.acknowledgedEvents ?? 0,
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

  ackFailingEventSkipped(
    subscriptionKey: string,
    acknowledgedOffset: number,
    cursorChangedAtOffset: number,
  ): void {
    this.#db.ackFailingEventSkipped({
      subscriptionKey,
      acknowledgedOffset,
      cursorChangedAtOffset,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  recordReportedCheckpoint(subscriptionKey: string, acknowledgedOffset: number): void {
    this.#db.recordReportedCheckpoint({
      subscriptionKey,
      acknowledgedOffset,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  markInFlight(
    subscriptionKey: string,
    args: {
      deadlineAt: number;
      connectionGeneration: number;
      cursorChangedAtOffset: number;
    },
  ): void {
    this.#db.markInFlight({
      subscriptionKey,
      ...args,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  clearInFlight(
    subscriptionKey: string,
    args: { connectionGeneration: number; cursorChangedAtOffset: number },
  ): void {
    this.#db.clearInFlight({
      subscriptionKey,
      ...args,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  nack(
    subscriptionKey: string,
    args: {
      attempt: number;
      nextAttemptAt: number;
      error: string;
      failingEvent?: { offset: number; attempt: number };
    },
  ): void {
    this.#db.nack({
      subscriptionKey,
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

  setCursor(
    subscriptionKey: string,
    acknowledgedOffset: number,
    cursorSetEventOffset: number,
  ): void {
    this.#db.setCursor({
      subscriptionKey,
      acknowledgedOffset,
      cursorChangedAtOffset: cursorSetEventOffset,
      updatedAt: new Date().toISOString(),
    });
    this.#onMutation();
  }

  delete(subscriptionKey: string): void {
    this.#db.delete({ subscriptionKey });
    this.#onMutation();
  }
}

/**
 * Clear stale failure state after rebuilding reduced configuration from the
 * event log (core state version mismatch). Cursor rows survive the KV state,
 * so after a rebuild they can describe a world the new fold no longer
 * derives: a row whose config event no longer parses is orphaned (its
 * `next_attempt_at` would arm alarms forever), and a surviving row's backoff
 * may blame code the new version replaced. Progress is kept — `acknowledgedOffset`
 * is monotonic truth about the same immutable log — while failure state is
 * cleared so every survivor gets an immediate fresh try under the new fold.
 * Delivery-halted subscriptions keep their failure evidence in the durable
 * halt event, so their mutable cursor rows can be cleaned in the same way as
 * active subscriptions.
 */
export function clearSubscriptionCursorFailuresAfterStateRebuild(
  store: SubscriptionCursorStore,
  configuredSubscriptionKeys: ReadonlySet<string>,
): void {
  for (const row of store.list()) {
    if (
      configuredSubscriptionKeys.has(row.subscriptionKey) &&
      (row.attempt !== 0 ||
        row.nextAttemptAt !== null ||
        row.inFlightDeadlineAt !== null ||
        row.lastError !== null ||
        row.failingEventOffset !== null ||
        row.failingEventAttempt !== 0 ||
        row.failingEventSkipsSinceLastSuccess !== 0)
    ) {
      // ack at the row's own offset: keeps the cursor, clears attempt/backoff.
      store.ack(row.subscriptionKey, row.acknowledgedOffset);
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
  configuredSubscriptionKeys: ReadonlySet<string>,
): void {
  for (const row of store.list()) {
    if (!configuredSubscriptionKeys.has(row.subscriptionKey)) store.delete(row.subscriptionKey);
  }
}

type SubscriptionCursorRowRecord = {
  subscription_key: string;
  acknowledged_offset: number;
  configured_at_offset: number;
  acknowledged_events: number;
  attempt: number;
  next_attempt_at: number | null;
  in_flight_deadline_at: number | null;
  in_flight_connection_generation: number | null;
  last_error: string | null;
  failing_event_offset: number | null;
  failing_event_attempt: number;
  failing_event_skips_since_last_success: number;
  cursor_changed_at_offset: number;
};

function rowFromRecord(record: SubscriptionCursorRowRecord): SubscriptionCursorRow {
  return {
    subscriptionKey: record.subscription_key,
    acknowledgedOffset: record.acknowledged_offset,
    configuredAtOffset: record.configured_at_offset,
    acknowledgedEvents: record.acknowledged_events,
    attempt: record.attempt,
    nextAttemptAt: record.next_attempt_at,
    inFlightDeadlineAt: record.in_flight_deadline_at,
    inFlightConnectionGeneration: record.in_flight_connection_generation,
    lastError: record.last_error,
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
