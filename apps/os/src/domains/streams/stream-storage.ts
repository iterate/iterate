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

  /** The highest DURABLE offset — the tail a default (ephemeral-excluding)
   * catch-up read can actually reach, and so the only head a fold barrier
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
  /** Successor wake for an in-flight remote attempt; null outside an attempt. */
  watchdogAt: number | null;
  /** Policy backoff deadline after a receiver failure; null when not backing off. */
  retryAt: number | null;
  /** Earliest durable successor wake across `watchdogAt` and `retryAt`. */
  nextAttemptAt: number | null;
  lastError: string | null;
  /** Offset currently being confirmed as poison; null outside poison isolation. */
  poisonOffset: number | null;
  /** Durable singleton rejections observed for `poisonOffset`. */
  poisonConfirmations: number;
  /** Poison events skipped since the receiver last accepted a delivery. */
  consecutivePoisonSkips: number;
  /**
   * Seek fence. Bumped by every explicit cursor move (`setCursor`) and fresh
   * on every row creation, so an ack fenced on the epoch a drain READ cannot
   * clobber a seek (or a remove+recreate) that landed while its delivery was
   * in flight — `ack`'s monotonic max alone would silently swallow the seek.
   */
  epoch: number;
};

/** Cursor incarnation captured before an attempt crosses a remote boundary. */
export type SubscriptionCursorFence = {
  subscriptionKey: string;
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
  /** Administrative/configuration ack: advance and clear all attempt state. */
  ack(subscriptionKey: string, ackedOffset: number): void;
  /** Attempt-owned ack, fenced against seek/removal/recreation. */
  ackAttempt(fence: SubscriptionCursorFence, ackedOffset: number): void;
  /**
   * Advance over a locally empty/filtered range without claiming receiver
   * success. Clears the current failure/poison candidate, but preserves the
   * durable consecutive-skip guard until a receiver actually accepts work.
   */
  advanceWithoutDelivery(fence: SubscriptionCursorFence, ackedOffset: number): void;
  /**
   * Advance the wake lane's observational watermark (monotonic) after a poke
   * whose checkpoint did NOT progress. Clears the retry schedule (the poke
   * consumed it; a live connection has no pending retry to arm) but KEEPS the
   * failure streak — a successful handshake proves the host is reachable, not
   * that deliveries succeed, and resetting the counter here is what let a
   * deterministically failing subscriber spin forever without ever parking.
   */
  advanceWatermark(fence: SubscriptionCursorFence, ackedOffset: number): void;
  /**
   * Begin a remote attempt: consume any due retry and persist its crash
   * watchdog without changing the failure count/error. Returns whether the
   * fenced row was mutated, so callers need no fallible read before the
   * durable obligation exists.
   */
  beginAttempt(fence: SubscriptionCursorFence, watchdogAt: number): boolean;
  /** Consume only the in-flight watchdog (for an immediate local transition). */
  clearWatchdog(fence: SubscriptionCursorFence): void;
  /**
   * Local infrastructure failure: schedule a successor without charging or
   * clearing receiver/poison policy state.
   */
  deferInfrastructure(
    fence: SubscriptionCursorFence,
    args: { nextAttemptAt: number; error: string },
  ): boolean;
  /** Failed delivery: record the consecutive attempt count and when to retry. */
  nack(
    fence: SubscriptionCursorFence,
    args: { attempt: number; nextAttemptAt: number; error: string },
  ): void;
  /** Failed singleton poison confirmation, independently of outage attempts. */
  nackPoison(
    fence: SubscriptionCursorFence,
    args: {
      attempt: number;
      nextAttemptAt: number;
      error: string;
      poisonOffset: number;
      poisonConfirmations: number;
    },
  ): void;
  /** Irreversibly step over one confirmed poison event and persist the skip streak. */
  skipPoison(fence: SubscriptionCursorFence, ackedOffset: number): void;
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
        watchdog_at integer,
        retry_at integer,
        last_error text,
        poison_offset integer,
        poison_confirmations integer not null default 0,
        consecutive_poison_skips integer not null default 0,
        epoch integer not null default 0,
        updated_at text not null
      );
    `,
    migrations: [
      {
        // Production is recreated for this breaking schema. This is the one
        // supported shape; a stale database must fail loudly and be erased,
        // never be mistaken for a compatible current-schema database.
        name: "20260718000001_create_subscriptions",
        content: sql`
          create table subscriptions (
            subscription_key text primary key,
            acked_offset integer not null,
            attempt integer not null default 0,
            watchdog_at integer,
            retry_at integer,
            last_error text,
            poison_offset integer,
            poison_confirmations integer not null default 0,
            consecutive_poison_skips integer not null default 0,
            epoch integer not null default 0,
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
        select subscription_key, acked_offset, attempt, watchdog_at, retry_at, last_error,
          poison_offset, poison_confirmations, consecutive_poison_skips, epoch
        from subscriptions
        where subscription_key = :subscriptionKey
      `,
      list: sql.many<{ result: SubscriptionCursorRowRecord }>`
        select subscription_key, acked_offset, attempt, watchdog_at, retry_at, last_error,
          poison_offset, poison_confirmations, consecutive_poison_skips, epoch
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
        set acked_offset = max(acked_offset, :ackedOffset), attempt = 0,
          watchdog_at = null, retry_at = null, last_error = null,
          poison_offset = null, poison_confirmations = 0, consecutive_poison_skips = 0,
          updated_at = :updatedAt
        where subscription_key = :subscriptionKey
      `,
      ackAttempt: sql.run<{
        parameters: {
          subscriptionKey: string;
          ackedOffset: number;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set acked_offset = max(acked_offset, :ackedOffset), attempt = 0,
          watchdog_at = null, retry_at = null, last_error = null,
          poison_offset = null, poison_confirmations = 0, consecutive_poison_skips = 0,
          updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      advanceWithoutDelivery: sql.run<{
        parameters: {
          subscriptionKey: string;
          ackedOffset: number;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set acked_offset = max(acked_offset, :ackedOffset), attempt = 0,
          watchdog_at = null, retry_at = null, last_error = null,
          poison_offset = null, poison_confirmations = 0, updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      advanceWatermark: sql.run<{
        parameters: {
          subscriptionKey: string;
          ackedOffset: number;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set acked_offset = max(acked_offset, :ackedOffset), watchdog_at = null, retry_at = null, updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      beginAttempt: sql.nullableOne<{
        parameters: {
          subscriptionKey: string;
          watchdogAt: number;
          epoch: number;
          updatedAt: string;
        };
        result: { epoch: number };
      }>`
        update subscriptions
        set watchdog_at = :watchdogAt, retry_at = null, updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
        returning epoch
      `,
      clearWatchdog: sql.run<{
        parameters: {
          subscriptionKey: string;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set watchdog_at = null, updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      deferInfrastructure: sql.nullableOne<{
        parameters: {
          subscriptionKey: string;
          nextAttemptAt: number;
          error: string;
          epoch: number;
          updatedAt: string;
        };
        result: { epoch: number };
      }>`
        update subscriptions
        set watchdog_at = null, retry_at = :nextAttemptAt, last_error = :error,
          updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
        returning epoch
      `,
      nack: sql.run<{
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
        set attempt = :attempt, watchdog_at = null, retry_at = :nextAttemptAt,
          last_error = :error, poison_offset = null, poison_confirmations = 0,
          updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      nackPoison: sql.run<{
        parameters: {
          subscriptionKey: string;
          attempt: number;
          nextAttemptAt: number;
          error: string;
          poisonOffset: number;
          poisonConfirmations: number;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set attempt = :attempt, watchdog_at = null, retry_at = :nextAttemptAt,
          last_error = :error, poison_offset = :poisonOffset,
          poison_confirmations = :poisonConfirmations, updated_at = :updatedAt
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      skipPoison: sql.run<{
        parameters: {
          subscriptionKey: string;
          ackedOffset: number;
          epoch: number;
          updatedAt: string;
        };
      }>`
        update subscriptions
        set acked_offset = max(acked_offset, :ackedOffset), attempt = 0,
          watchdog_at = null, retry_at = null, last_error = null,
          poison_offset = null, poison_confirmations = 0,
          consecutive_poison_skips = consecutive_poison_skips + 1,
          updated_at = :updatedAt
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
        set acked_offset = :ackedOffset, attempt = 0, watchdog_at = null,
          retry_at = null, last_error = null, poison_offset = null,
          poison_confirmations = 0, consecutive_poison_skips = 0,
          epoch = :epoch, updated_at = :updatedAt
        where subscription_key = :subscriptionKey
      `,
      delete: sql.run<{ parameters: { subscriptionKey: string } }>`
        delete from subscriptions where subscription_key = :subscriptionKey
      `,
      minNextAttemptAt: sql.one<{ result: { next: number | null } }>`
        select min(deadline) as next
        from (
          select watchdog_at as deadline from subscriptions where watchdog_at is not null
          union all
          select retry_at as deadline from subscriptions where retry_at is not null
        )
      `,
    },
  });

  /** Monotonic within this instance; wall-clock floor covers restarts. */
  #lastEpoch = 0;

  #db: ReturnType<
    typeof SqliteSubscriptionCursorStore.db<ReturnType<typeof createDurableObjectClient>>
  >;

  constructor(sql: SqlStorage) {
    // This store has one current-schema creation migration. There is
    // intentionally no live-shape adoption: production is recreated for
    // breaking stream-storage changes, and stale databases fail loudly.
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

  ack(subscriptionKey: string, ackedOffset: number): void {
    this.#db.ack({ subscriptionKey, ackedOffset, updatedAt: new Date().toISOString() });
  }

  ackAttempt(fence: SubscriptionCursorFence, ackedOffset: number): void {
    this.#db.ackAttempt({ ...fence, ackedOffset, updatedAt: new Date().toISOString() });
  }

  advanceWithoutDelivery(fence: SubscriptionCursorFence, ackedOffset: number): void {
    this.#db.advanceWithoutDelivery({
      ...fence,
      ackedOffset,
      updatedAt: new Date().toISOString(),
    });
  }

  advanceWatermark(fence: SubscriptionCursorFence, ackedOffset: number): void {
    this.#db.advanceWatermark({ ...fence, ackedOffset, updatedAt: new Date().toISOString() });
  }

  beginAttempt(fence: SubscriptionCursorFence, watchdogAt: number): boolean {
    return (
      this.#db.beginAttempt({
        ...fence,
        watchdogAt,
        updatedAt: new Date().toISOString(),
      }) !== null
    );
  }

  clearWatchdog(fence: SubscriptionCursorFence): void {
    this.#db.clearWatchdog({ ...fence, updatedAt: new Date().toISOString() });
  }

  deferInfrastructure(
    fence: SubscriptionCursorFence,
    args: { nextAttemptAt: number; error: string },
  ): boolean {
    return (
      this.#db.deferInfrastructure({
        ...fence,
        nextAttemptAt: args.nextAttemptAt,
        error: args.error.slice(0, 2_000),
        updatedAt: new Date().toISOString(),
      }) !== null
    );
  }

  nack(
    fence: SubscriptionCursorFence,
    args: { attempt: number; nextAttemptAt: number; error: string },
  ): void {
    const params = {
      ...fence,
      attempt: args.attempt,
      nextAttemptAt: args.nextAttemptAt,
      // Bound the stored error so a pathological message cannot bloat the row.
      error: args.error.slice(0, 2_000),
      updatedAt: new Date().toISOString(),
    };
    this.#db.nack(params);
  }

  nackPoison(
    fence: SubscriptionCursorFence,
    args: {
      attempt: number;
      nextAttemptAt: number;
      error: string;
      poisonOffset: number;
      poisonConfirmations: number;
    },
  ): void {
    this.#db.nackPoison({
      ...fence,
      ...args,
      error: args.error.slice(0, 2_000),
      updatedAt: new Date().toISOString(),
    });
  }

  skipPoison(fence: SubscriptionCursorFence, ackedOffset: number): void {
    this.#db.skipPoison({ ...fence, ackedOffset, updatedAt: new Date().toISOString() });
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
 * deadlines would arm alarms forever), and a surviving row's backoff
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
    } else if (
      row.attempt !== 0 ||
      row.nextAttemptAt !== null ||
      row.lastError !== null ||
      row.poisonOffset !== null ||
      row.poisonConfirmations !== 0 ||
      row.consecutivePoisonSkips !== 0
    ) {
      // ack at the row's own offset: keeps the cursor, clears attempt/backoff.
      store.ack(row.subscriptionKey, row.ackedOffset);
    }
  }
}

type SubscriptionCursorRowRecord = {
  subscription_key: string;
  acked_offset: number;
  attempt: number;
  watchdog_at: number | null;
  retry_at: number | null;
  last_error: string | null;
  poison_offset: number | null;
  poison_confirmations: number;
  consecutive_poison_skips: number;
  epoch: number;
};

function rowFromRecord(record: SubscriptionCursorRowRecord): SubscriptionCursorRow {
  const nextAttemptAt = earliestDeadline(record.watchdog_at, record.retry_at);
  return {
    subscriptionKey: record.subscription_key,
    ackedOffset: record.acked_offset,
    attempt: record.attempt,
    watchdogAt: record.watchdog_at,
    retryAt: record.retry_at,
    nextAttemptAt,
    lastError: record.last_error,
    poisonOffset: record.poison_offset,
    poisonConfirmations: record.poison_confirmations,
    consecutivePoisonSkips: record.consecutive_poison_skips,
    epoch: record.epoch,
  };
}

function earliestDeadline(...deadlines: Array<number | null>): number | null {
  let earliest: number | null = null;
  for (const deadline of deadlines) {
    if (deadline !== null && (earliest === null || deadline < earliest)) earliest = deadline;
  }
  return earliest;
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
