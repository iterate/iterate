// The stream's append log — and its delivery cursors — in Durable Object SQLite.
//
// Storage is normalized into two tables: `events` is the offset-ordered
// metadata/index plus common event JSON inline, and `event_chunks` holds
// oversized event JSON as bounded UTF-8 byte rows. Durable Object
// SQLite caps each string/blob/row cell at ~2 MB; BLOB columns do not raise
// that ceiling, and SQL-side substr(?) chunking would still require binding
// the oversized value first, so JSON above the conservative 512 KiB inline
// ceiling is chunked in JS.
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
import type { StreamEvent } from "./schemas.ts";

const EVENT_CHUNK_SIZE = 512 * 1024;
const CURRENT_STREAM_STORAGE_SCHEMA_VERSION = 5;
// Durable Object SQL currently permits at most 100 bound parameters per query.
// Keep generated multi-row inserts at that ceiling and bound pending BLOB
// memory independently: small events fill the row budget, large events flush
// after at most two full chunks.
const MAX_SQL_BINDINGS = 100;
const MAX_PENDING_INSERT_BYTES = EVENT_CHUNK_SIZE * 2;
// Retain at most one bounded lookahead when it crosses a metadata batch. This
// avoids serializing medium/large events twice without ever pinning a second
// arbitrarily large event next to the batch being written.
const MAX_CARRIED_INSERT_BYTES = MAX_PENDING_INSERT_BYTES;
const EVENT_INSERT_ROW_WIDTH = 5;
const CHUNK_INSERT_ROW_WIDTH = 3;
const MAX_EVENT_ROWS_PER_INSERT = Math.floor(MAX_SQL_BINDINGS / EVENT_INSERT_ROW_WIDTH);
const MAX_CHUNK_ROWS_PER_INSERT = Math.floor(MAX_SQL_BINDINGS / CHUNK_INSERT_ROW_WIDTH);
const SKIPPED_ACK_ROW_WIDTH = 3;
const MAX_SKIPPED_ACK_ROWS = Math.floor(MAX_SQL_BINDINGS / SKIPPED_ACK_ROW_WIDTH);
const MAX_UNPERSISTED_SKIP_OFFSETS = 64;
const EVENT_INSERT_STATEMENTS = createInsertStatements(
  "insert into events (offset, type, idempotency_key, ephemeral, event_json) values",
  EVENT_INSERT_ROW_WIDTH,
  MAX_EVENT_ROWS_PER_INSERT,
);
const CHUNK_INSERT_STATEMENTS = createInsertStatements(
  "insert into event_chunks (offset, chunk_index, chunk_bytes) values",
  CHUNK_INSERT_ROW_WIDTH,
  MAX_CHUNK_ROWS_PER_INSERT,
);
const SKIPPED_ACK_STATEMENTS = createSkippedAckStatements(MAX_SKIPPED_ACK_ROWS);
const textEncoder = new TextEncoder();

/**
 * A committed event paired with its serialized byte length (the exact bytes
 * stored inline or in `event_chunks`). Delivery batching sizes batches against the byte
 * cap with these instead of re-stringifying every event on every read.
 */
export type SizedStreamEvent = { event: StreamEvent; byteLength: number };
export type StreamOffsetBounds = { highestOffset: number; highestAssignedOffset: number };
type EventChunks = ArrayBuffer | ArrayBuffer[];
type StreamRangeArgs = {
  afterOffset: number;
  beforeOffset: number;
  eventTypes?: readonly string[];
  limit: number;
  /** Include ephemeral rows. Default false — ephemeral is opt-in on every range read. */
  includeEphemeral?: boolean;
};
type TransactionRunner = { transactionSync<T>(callback: () => T): T };

const initializedStreamStorage = new WeakSet<SqlStorage>();

type StreamStorageBootstrap = StreamOffsetBounds & { version: number };

function readStreamStorageBootstrap(sqlStorage: SqlStorage): StreamStorageBootstrap | undefined {
  try {
    return sqlStorage
      .exec<StreamStorageBootstrap>(`
        with event_bounds as (
          select coalesce(max(offset), 0) as highestOffset
          from events
        )
        select version,
               highestOffset,
               max(highestOffset, evicted_offset_floor) as highestAssignedOffset
        from stream_storage_schema, event_bounds
        where singleton = 1
      `)
      .toArray()[0];
  } catch {
    return undefined;
  }
}

function initializeStreamStorage(sqlStorage: SqlStorage): StreamOffsetBounds | undefined {
  if (initializedStreamStorage.has(sqlStorage)) return undefined;
  const bootstrap = readStreamStorageBootstrap(sqlStorage);
  const schemaVersion = bootstrap?.version ?? 0;
  if (schemaVersion === CURRENT_STREAM_STORAGE_SCHEMA_VERSION) {
    initializedStreamStorage.add(sqlStorage);
    return bootstrap;
  }
  if (schemaVersion !== 0) {
    throw new Error(`Unsupported stream storage schema version: ${schemaVersion}`);
  }
  sqlStorage.exec(`
    -- Stream-owned append log metadata. Bounded JSON is inline; oversized JSON is chunked.
    -- offset is the replay cursor; the partial index below owns keyed dedup/lookups.
    -- createdAt stays solely in event_json: no query filters or orders on it, so a
    -- duplicate column would consume one binding and one SQLite field per append.
    -- ephemeral marks second-class rows: range reads exclude them unless asked, and
    -- the stream may evict them in the future. Eviction keeps offsets consumed
    -- in stream_storage_schema but forgets their idempotency keys.
    create table events (
      offset integer primary key,
      type text not null,
      idempotency_key text,
      ephemeral integer not null default 0,
      event_json blob
    )
  `);
  sqlStorage.exec(`
    -- Most facts have no idempotency key. A partial index preserves exact
    -- uniqueness and point lookups for keyed facts without writing a null
    -- index entry for every ordinary append.
    create unique index events_idempotency_key
    on events(idempotency_key)
    where idempotency_key is not null
  `);
  sqlStorage.exec(`
    -- Full committed event JSON split into ordered byte chunks. The WITHOUT ROWID
    -- primary key is the lookup index used by point reads and range replay.
    create table event_chunks (
      offset integer not null,
      chunk_index integer not null,
      chunk_bytes blob not null,
      primary key (offset, chunk_index),
      foreign key (offset) references events(offset) on delete cascade
    ) without rowid
  `);
  sqlStorage.exec(`
    create table subscriptions (
      subscription_key text primary key,
      acked_offset integer not null,
      attempt integer not null default 0,
      next_attempt_at integer,
      last_error text,
      epoch integer not null default 0
    )
  `);
  sqlStorage.exec(`
    create table stream_storage_schema (
      singleton integer primary key check (singleton = 1),
      version integer not null,
      evicted_offset_floor integer not null
    )
  `);
  sqlStorage.exec(
    "insert into stream_storage_schema (singleton, version, evicted_offset_floor) values (1, ?, 0)",
    CURRENT_STREAM_STORAGE_SCHEMA_VERSION,
  );
  initializedStreamStorage.add(sqlStorage);
  return { highestOffset: 0, highestAssignedOffset: 0 };
}

export class StreamEventLog {
  #bootstrapOffsetBounds: StreamOffsetBounds | undefined;

  constructor(
    readonly sql: SqlStorage,
    _path: string,
  ) {
    this.#bootstrapOffsetBounds = initializeStreamStorage(this.sql);
  }

  highestOffset(): number {
    return (
      this.sql
        .exec<{ offset: number | null }>("select max(offset) as offset from events")
        .toArray()[0]?.offset ?? 0
    );
  }

  /**
   * The highest surviving or explicitly evicted offset. Eviction advances a
   * durable floor in the same transaction that removes rows; ordinary appends
   * avoid an allocator-metadata write because their rows already carry the
   * recovery floor. This prevents a rebuild from reissuing an offset that live
   * subscribers saw before its ephemeral row was evicted.
   */
  highestAssignedOffset(): number {
    return this.offsetBounds().highestAssignedOffset;
  }

  /** Consume the schema check's event bounds, or query when another storage owner initialized first. */
  takeBootstrapOffsetBounds(): StreamOffsetBounds {
    const bounds = this.#bootstrapOffsetBounds;
    this.#bootstrapOffsetBounds = undefined;
    return bounds === undefined
      ? this.offsetBounds()
      : {
          highestOffset: bounds.highestOffset,
          highestAssignedOffset: bounds.highestAssignedOffset,
        };
  }

  /** One bootstrap snapshot for replay head and never-reuse allocation floor. */
  offsetBounds(): StreamOffsetBounds {
    return this.sql
      .exec<StreamOffsetBounds>(`
        with event_bounds as (
          select coalesce(max(offset), 0) as highestOffset
          from events
        )
        select highestOffset,
               max(
                 highestOffset,
                 (select evicted_offset_floor
                  from stream_storage_schema
                  where singleton = 1)
               ) as highestAssignedOffset
        from event_bounds
      `)
      .toArray()[0]!;
  }

  /**
   * Evict second-class rows up to an inclusive offset without making their
   * offsets reusable. Floor advancement, chunk cleanup, and row deletion are
   * one transaction so interruption leaves either the complete old or new
   * state. Direct DELETEs are unsupported because they bypass this invariant.
   */
  evictEphemeralThrough(maxOffsetInclusive: number, transactionRunner: TransactionRunner): void {
    if (!Number.isSafeInteger(maxOffsetInclusive) || maxOffsetInclusive < 0) {
      throw new Error(`Invalid ephemeral eviction offset: ${maxOffsetInclusive}`);
    }
    transactionRunner.transactionSync(() => {
      this.sql.exec(
        `update stream_storage_schema
         set evicted_offset_floor = max(
           evicted_offset_floor,
           coalesce(
             (select max(offset)
              from events
              where ephemeral = 1 and offset <= ?),
             0
           )
         )
         where singleton = 1`,
        maxOffsetInclusive,
      );
      // Do not depend on a connection-level foreign_keys pragma for cleanup.
      this.sql.exec(
        `delete from event_chunks
         where offset in (
           select offset from events where ephemeral = 1 and offset <= ?
         )`,
        maxOffsetInclusive,
      );
      this.sql.exec("delete from events where ephemeral = 1 and offset <= ?", maxOffsetInclusive);
    });
  }

  /**
   * Returns each event's serialized byte length (the exact bytes written to
   * SQLite), so the commit path can hand delivery fan-out a sized
   * fresh tail without anyone re-stringifying what was just serialized here.
   */
  insert(
    events: readonly StreamEvent[],
    transactionRunner?: TransactionRunner,
  ): SizedStreamEvent[] {
    let carriedSerialization: { eventIndex: number; bytes: Uint8Array } | undefined;
    let serializedPrefix: Uint8Array[] | undefined;
    if (events.length === 1) {
      const event = events[0]!;
      const bytes = textEncoder.encode(JSON.stringify(event));
      if (bytes.byteLength <= EVENT_CHUNK_SIZE) {
        // This is the entire commit in one atomic SQLite statement. An
        // explicit transaction would add begin/commit work without widening
        // the failure boundary; multi-statement paths below still use it.
        this.sql.exec(
          EVENT_INSERT_STATEMENTS[1]!,
          event.offset,
          event.type,
          event.idempotencyKey ?? null,
          event.ephemeral === true ? 1 : 0,
          exactArrayBuffer(bytes),
        );
        return [{ event, byteLength: bytes.byteLength }];
      }
      // Preserve the large-event path's single-serialization guarantee.
      carriedSerialization = { eventIndex: 0, bytes };
    } else if (events.length <= MAX_EVENT_ROWS_PER_INSERT) {
      const candidate = [] as Uint8Array[];
      let candidateByteLength = 0;
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        const bytes = textEncoder.encode(JSON.stringify(events[eventIndex]!));
        if (
          bytes.byteLength > EVENT_CHUNK_SIZE ||
          candidateByteLength + bytes.byteLength > MAX_PENDING_INSERT_BYTES
        ) {
          if (bytes.byteLength <= MAX_CARRIED_INSERT_BYTES) {
            carriedSerialization = { eventIndex, bytes };
          }
          break;
        }
        candidate.push(bytes);
        candidateByteLength += bytes.byteLength;
      }

      if (candidate.length === events.length) {
        const eventBindings: SqlStorageValue[] = [];
        const sizedEvents: SizedStreamEvent[] = [];
        for (let index = 0; index < events.length; index += 1) {
          const event = events[index]!;
          const bytes = candidate[index]!;
          eventBindings.push(
            event.offset,
            event.type,
            event.idempotencyKey ?? null,
            event.ephemeral === true ? 1 : 0,
            exactArrayBuffer(bytes),
          );
          sizedEvents.push({ event, byteLength: bytes.byteLength });
        }
        this.sql.exec(EVENT_INSERT_STATEMENTS[events.length]!, ...eventBindings);
        return sizedEvents;
      }
      if (candidate.length > 0) serializedPrefix = candidate;
    }

    const insertBatched = () => {
      const sizedEvents: SizedStreamEvent[] = [];
      let batchStart = 0;

      while (batchStart < events.length) {
        const serializedEvents: Uint8Array[] = [];
        const eventBindings: SqlStorageValue[] = [];
        let serializedByteLength = 0;
        let batchEnd = batchStart;
        let hasChunkedEvents = false;

        while (batchEnd < events.length && serializedEvents.length < MAX_EVENT_ROWS_PER_INSERT) {
          const event = events[batchEnd]!;
          const carried =
            carriedSerialization?.eventIndex === batchEnd ? carriedSerialization : null;
          const bytes =
            serializedPrefix?.[batchEnd] ??
            carried?.bytes ??
            textEncoder.encode(JSON.stringify(event));
          if (carried !== null) carriedSerialization = undefined;
          if (
            serializedEvents.length > 0 &&
            serializedByteLength + bytes.byteLength > MAX_PENDING_INSERT_BYTES
          ) {
            if (bytes.byteLength <= MAX_CARRIED_INSERT_BYTES) {
              carriedSerialization = { eventIndex: batchEnd, bytes };
            }
            break;
          }
          serializedEvents.push(bytes);
          eventBindings.push(
            event.offset,
            event.type,
            event.idempotencyKey ?? null,
            event.ephemeral === true ? 1 : 0,
            bytes.byteLength <= EVENT_CHUNK_SIZE ? exactArrayBuffer(bytes) : null,
          );
          if (bytes.byteLength > EVENT_CHUNK_SIZE) hasChunkedEvents = true;
          sizedEvents.push({ event, byteLength: bytes.byteLength });
          serializedByteLength += bytes.byteLength;
          batchEnd += 1;
        }

        this.sql.exec(EVENT_INSERT_STATEMENTS[serializedEvents.length]!, ...eventBindings);

        if (!hasChunkedEvents) {
          batchStart = batchEnd;
          continue;
        }

        let chunkBindings: SqlStorageValue[] = [];
        let chunkRows = 0;
        let chunkByteLength = 0;
        const flushChunks = () => {
          if (chunkRows === 0) return;
          this.sql.exec(CHUNK_INSERT_STATEMENTS[chunkRows]!, ...chunkBindings);
          chunkBindings = [];
          chunkRows = 0;
          chunkByteLength = 0;
        };

        for (let index = 0; index < serializedEvents.length; index += 1) {
          const rawJsonBytes = serializedEvents[index]!;
          const event = events[batchStart + index]!;
          if (rawJsonBytes.byteLength <= EVENT_CHUNK_SIZE) continue;

          let chunkIndex = 0;
          for (let start = 0; start < rawJsonBytes.byteLength; start += EVENT_CHUNK_SIZE) {
            const end = Math.min(start + EVENT_CHUNK_SIZE, rawJsonBytes.byteLength);
            const chunk = new ArrayBuffer(end - start);
            new Uint8Array(chunk).set(rawJsonBytes.subarray(start, end));
            if (
              chunkRows === MAX_CHUNK_ROWS_PER_INSERT ||
              (chunkRows > 0 && chunkByteLength + chunk.byteLength > MAX_PENDING_INSERT_BYTES)
            ) {
              flushChunks();
            }
            chunkBindings.push(event.offset, chunkIndex, chunk);
            chunkRows += 1;
            chunkByteLength += chunk.byteLength;
            chunkIndex += 1;
          }
        }
        flushChunks();
        batchStart = batchEnd;
      }
      return sizedEvents;
    };

    return transactionRunner === undefined
      ? insertBatched()
      : transactionRunner.transactionSync(insertBatched);
  }

  getByOffset(offset: number): StreamEvent | undefined {
    const row = this.sql
      .exec<{ eventJson: string | null }>(
        "select cast(event_json as text) as eventJson from events where offset = ?",
        offset,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    if (row.eventJson !== null) return this.#parseEvent(row.eventJson, 0);
    const chunked = this.#readChunkedEvents([offset]).get(offset);
    return chunked === undefined ? undefined : this.#parseEvent(chunked.chunks, chunked.byteLength);
  }

  getByIdempotencyKey(idempotencyKey: string): StreamEvent | undefined {
    const row = this.sql
      .exec<{ offset: number; eventJson: string | null }>(
        "select offset, cast(event_json as text) as eventJson from events where idempotency_key = ?",
        idempotencyKey,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    if (row.eventJson !== null) return this.#parseEvent(row.eventJson, 0);
    const chunked = this.#readChunkedEvents([row.offset]).get(row.offset);
    return chunked === undefined ? undefined : this.#parseEvent(chunked.chunks, chunked.byteLength);
  }

  /**
   * Resolves an append batch's durable idempotency hits with one query per 100
   * keys. Missing keys return no rows; common hits parse directly from the
   * metadata rows and only oversized hits need a chunk query.
   */
  getByIdempotencyKeys(idempotencyKeys: readonly string[]): Map<string, StreamEvent> {
    if (idempotencyKeys.length === 1) {
      const idempotencyKey = idempotencyKeys[0]!;
      const event = this.getByIdempotencyKey(idempotencyKey);
      return event === undefined ? new Map() : new Map([[idempotencyKey, event]]);
    }
    const events = new Map<string, StreamEvent | undefined>();
    for (let start = 0; start < idempotencyKeys.length; start += MAX_SQL_BINDINGS) {
      const keys = idempotencyKeys.slice(start, start + MAX_SQL_BINDINGS);
      let chunkedRows: Array<[number, string]> | undefined;
      for (const row of this.sql
        .exec(
          `
            select offset, idempotency_key as idempotencyKey,
              cast(event_json as text) as eventJson
            from events
            where idempotency_key in (${keys.map(() => "?").join(", ")})
            order by offset asc
          `,
          ...keys,
        )
        .raw<[number, string, string | null]>()) {
        const [offset, idempotencyKey, eventJson] = row;
        if (eventJson === null) {
          // Establish insertion order now; replacing this placeholder after
          // chunk hydration keeps the map in durable offset order.
          events.set(idempotencyKey, undefined);
          (chunkedRows ??= []).push([offset, idempotencyKey]);
        } else {
          events.set(idempotencyKey, this.#parseEvent(eventJson, 0));
        }
      }
      if (chunkedRows !== undefined) {
        const chunkedEvents = this.#readChunkedEvents(chunkedRows.map(([offset]) => offset));
        for (const [offset, idempotencyKey] of chunkedRows) {
          const stored = chunkedEvents.get(offset);
          if (stored === undefined) {
            events.delete(idempotencyKey);
          } else {
            events.set(idempotencyKey, this.#parseEvent(stored.chunks, stored.byteLength));
          }
        }
      }
    }
    return events as Map<string, StreamEvent>;
  }

  getRange(args: StreamRangeArgs): StreamEvent[] {
    return this.#readRange(args, false);
  }

  /**
   * `getRange` plus each event's stored byte length, so delivery batching can
   * enforce its byte cap without re-stringifying every event it just parsed.
   */
  getRangeSized(args: StreamRangeArgs): SizedStreamEvent[] {
    return this.#readRange(args, true);
  }

  #readRange(args: StreamRangeArgs, includeByteLength: false): StreamEvent[];
  #readRange(args: StreamRangeArgs, includeByteLength: true): SizedStreamEvent[];
  #readRange(
    args: StreamRangeArgs,
    includeByteLength: boolean,
  ): Array<SizedStreamEvent | StreamEvent> {
    if (args.eventTypes?.length === 0) return [];
    const eventTypes =
      args.eventTypes === undefined || args.eventTypes.includes("*") ? undefined : args.eventTypes;
    const eventTypeClause =
      eventTypes === undefined ? "" : `and type in (${eventTypes.map(() => "?").join(", ")})`;
    const ephemeralClause = args.includeEphemeral === true ? "" : "and ephemeral = 0";
    // Common rows carry their JSON directly. Oversized rows carry their offset
    // in the same positional column and are hydrated from bounded chunks below.
    const byteLengthColumn = includeByteLength ? ", length(event_json) as inlineByteLength" : "";
    const rows = this.sql
      .exec(
        `
          select coalesce(cast(event_json as text), offset) as eventJsonOrOffset${byteLengthColumn}
          from events
          where offset > ?
            and offset < ?
            ${ephemeralClause}
            ${eventTypeClause}
          order by offset asc
          limit ?
        `,
        args.afterOffset,
        args.beforeOffset,
        ...(eventTypes ?? []),
        args.limit,
      )
      .raw<[string | number, number | null]>();
    const events: Array<SizedStreamEvent | StreamEvent | undefined> = [];
    let chunkedRows: number[] | undefined;
    for (const [eventJsonOrOffset, inlineByteLength] of rows) {
      if (typeof eventJsonOrOffset === "number") {
        (chunkedRows ??= []).push(events.length, eventJsonOrOffset);
        events.push(undefined);
        continue;
      }
      const event = this.#parseEvent(eventJsonOrOffset, 0);
      events.push(includeByteLength ? { event, byteLength: inlineByteLength ?? 0 } : event);
    }
    if (chunkedRows === undefined) {
      return events as Array<SizedStreamEvent | StreamEvent>;
    }

    const chunkedOffsets = new Array<number>(chunkedRows.length / 2);
    for (let index = 1; index < chunkedRows.length; index += 2) {
      chunkedOffsets[index >> 1] = chunkedRows[index]!;
    }
    const chunkedEvents = this.#readChunkedEvents(chunkedOffsets);
    let hasMissingChunks = false;
    for (let index = 0; index < chunkedRows.length; index += 2) {
      const resultIndex = chunkedRows[index]!;
      const stored = chunkedEvents.get(chunkedRows[index + 1]!);
      if (stored === undefined) {
        hasMissingChunks = true;
        continue;
      }
      const event = this.#parseEvent(stored.chunks, stored.byteLength);
      events[resultIndex] = includeByteLength ? { event, byteLength: stored.byteLength } : event;
    }
    return hasMissingChunks
      ? events.filter((event) => event !== undefined)
      : (events as Array<SizedStreamEvent | StreamEvent>);
  }

  #readChunkedEvents(
    offsets: readonly number[],
  ): Map<number, { chunks: EventChunks; byteLength: number }> {
    const events = new Map<number, { chunks: EventChunks; byteLength: number }>();
    for (let start = 0; start < offsets.length; start += MAX_SQL_BINDINGS) {
      const batch = offsets.slice(start, start + MAX_SQL_BINDINGS);
      for (const row of this.sql.exec<{ offset: number; chunkBytes: ArrayBuffer }>(
        `
          select offset, chunk_bytes as chunkBytes
          from event_chunks
          where offset in (${batch.map(() => "?").join(", ")})
          order by offset asc, chunk_index asc
        `,
        ...batch,
      )) {
        const current = events.get(row.offset);
        if (current === undefined) {
          events.set(row.offset, { chunks: row.chunkBytes, byteLength: row.chunkBytes.byteLength });
        } else {
          current.chunks = appendEventChunk(current.chunks, row.chunkBytes);
          current.byteLength += row.chunkBytes.byteLength;
        }
      }
    }
    return events;
  }

  /** Decode exact rows produced by append; JSON syntax corruption still fails loudly. */
  #parseEvent(storedJson: string | EventChunks, byteLength: number): StreamEvent {
    const json = typeof storedJson === "string" ? storedJson : decodeChunks(storedJson, byteLength);
    return JSON.parse(json) as StreamEvent;
  }
}

/**
 * One durable subscription's delivery cursor row. `ackedOffset` is exclusive
 * (delivery resumes at +1). For push subscriptions it is the AUTHORITATIVE
 * cursor: delivery offsets advance only when the receiver's awaited call
 * resolved; no-side-effect skips may be durably checkpointed up to 64 offsets
 * behind. For wake subscriptions it is an OBSERVATIONAL watermark: the checkpoint the
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
  /** Create if absent without resetting; return an immutable caller snapshot. */
  ensure(subscriptionKey: string, ackedOffset: number): SubscriptionCursorRow;
  /**
   * Successful delivery: advance the cursor (monotonic), clear failure state.
   * With `epoch`, the ack is FENCED: it no-ops unless the row's epoch still
   * matches the one the caller read before dialing — a seek that landed while
   * the delivery was in flight wins over the delivery's ack.
   */
  ack(subscriptionKey: string, ackedOffset: number, epoch?: number): void;
  /**
   * Advance across a batch that produced no receiver side effect (selector
   * miss / ephemeral-only). The in-memory cursor moves immediately; durable
   * persistence may lag by a bounded window because replaying a skip is safe.
   */
  skip(subscriptionKey: string, ackedOffset: number, epoch: number): void;
  /** Persist pending skip-only cursor progress, when due or unconditionally. */
  flushSkipped(force?: boolean): void;
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
  static db = defineConfig({
    // Current schema used by sqlfu's generated query types.
    definitions: sql`
      create table subscriptions (
        subscription_key text primary key,
        acked_offset integer not null,
        attempt integer not null default 0,
        next_attempt_at integer,
        last_error text,
        epoch integer not null default 0
      );
    `,
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
        };
      }>`
        insert into subscriptions (subscription_key, acked_offset, epoch)
        values (:subscriptionKey, :ackedOffset, :epoch)
        on conflict (subscription_key) do nothing
      `,
      ack: sql.run<{
        parameters: { subscriptionKey: string; ackedOffset: number };
      }>`
        update subscriptions
        set acked_offset = :ackedOffset, attempt = 0, next_attempt_at = null, last_error = null
        where subscription_key = :subscriptionKey
      `,
      ackFenced: sql.run<{
        parameters: {
          subscriptionKey: string;
          ackedOffset: number;
          epoch: number;
        };
      }>`
        update subscriptions
        set acked_offset = :ackedOffset, attempt = 0, next_attempt_at = null, last_error = null
        where subscription_key = :subscriptionKey and epoch = :epoch
      `,
      advanceWatermark: sql.run<{
        parameters: { subscriptionKey: string; ackedOffset: number };
      }>`
        update subscriptions
        set acked_offset = max(acked_offset, :ackedOffset), next_attempt_at = null
        where subscription_key = :subscriptionKey
      `,
      nack: sql.run<{
        parameters: {
          subscriptionKey: string;
          attempt: number;
          nextAttemptAt: number;
          error: string;
        };
      }>`
        update subscriptions
        set attempt = :attempt, next_attempt_at = :nextAttemptAt, last_error = :error
        where subscription_key = :subscriptionKey
      `,
      setCursor: sql.run<{
        parameters: {
          subscriptionKey: string;
          ackedOffset: number;
          epoch: number;
        };
      }>`
        update subscriptions
        set acked_offset = :ackedOffset, attempt = 0, next_attempt_at = null, last_error = null, epoch = :epoch
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
  readonly #sql: SqlStorage;
  #cachedRows: Map<string, SubscriptionCursorRow> | undefined;
  readonly #pendingSkipped = new Map<
    string,
    { ackedOffset: number; epoch: number; persistedOffset: number }
  >();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    initializeStreamStorage(sql);
    this.#db = SqliteSubscriptionCursorStore.db(createDurableObjectClient({ sql }));
  }

  #nextEpoch(): number {
    this.#lastEpoch = Math.max(this.#lastEpoch + 1, Date.now());
    return this.#lastEpoch;
  }

  #rows(): Map<string, SubscriptionCursorRow> {
    if (this.#cachedRows !== undefined) return this.#cachedRows;
    const rows = new Map<string, SubscriptionCursorRow>();
    for (const record of this.#db.list()) {
      const row = rowFromRecord(record);
      rows.set(row.subscriptionKey, row);
      this.#lastEpoch = Math.max(this.#lastEpoch, row.epoch);
    }
    this.#cachedRows = rows;
    return rows;
  }

  get(subscriptionKey: string): SubscriptionCursorRow | undefined {
    const row = this.#rows().get(subscriptionKey);
    return row === undefined ? undefined : { ...row };
  }

  list(): SubscriptionCursorRow[] {
    return [...this.#rows().values()].map((row) => ({ ...row }));
  }

  ensure(subscriptionKey: string, ackedOffset: number): SubscriptionCursorRow {
    const rows = this.#rows();
    const existing = rows.get(subscriptionKey);
    if (existing !== undefined) return { ...existing };
    const epoch = this.#nextEpoch();
    this.#db.ensure({
      subscriptionKey,
      ackedOffset,
      // Fresh rows get a fresh epoch, so an ack fenced on a DELETED row's
      // epoch cannot land on a same-key recreation (the remove+recreate
      // deliver:"all" clobber).
      epoch,
    });
    const row: SubscriptionCursorRow = {
      subscriptionKey,
      ackedOffset,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      epoch,
    };
    rows.set(subscriptionKey, row);
    return { ...row };
  }

  ack(subscriptionKey: string, ackedOffset: number, epoch?: number): void {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined || (epoch !== undefined && row.epoch !== epoch)) return;
    // The cursor cache is write-through and this method is synchronous, so it
    // already owns the monotonic maximum; avoid recomputing it in SQLite.
    const nextOffset = Math.max(row.ackedOffset, ackedOffset);
    if (
      !this.#pendingSkipped.has(subscriptionKey) &&
      nextOffset === row.ackedOffset &&
      row.attempt === 0 &&
      row.nextAttemptAt === null &&
      row.lastError === null
    ) {
      return;
    }
    const params = {
      subscriptionKey,
      ackedOffset: nextOffset,
    };
    if (epoch === undefined) {
      this.#db.ack(params);
    } else {
      this.#db.ackFenced({ ...params, epoch });
    }
    this.#pendingSkipped.delete(subscriptionKey);
    row.ackedOffset = nextOffset;
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
  }

  skip(subscriptionKey: string, ackedOffset: number, epoch: number): void {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined || row.epoch !== epoch || ackedOffset <= row.ackedOffset) return;
    const clearsFailure = row.attempt !== 0 || row.nextAttemptAt !== null || row.lastError !== null;
    const pending = this.#pendingSkipped.get(subscriptionKey);
    this.#pendingSkipped.set(subscriptionKey, {
      ackedOffset,
      epoch,
      persistedOffset: pending?.persistedOffset ?? row.ackedOffset,
    });
    row.ackedOffset = ackedOffset;
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
    // A due retry that found only skips consumed the persisted backoff. Do not
    // leave its old alarm state behind on a quiet stream.
    if (clearsFailure) this.flushSkipped(true);
  }

  flushSkipped(force = false): void {
    if (this.#pendingSkipped.size === 0) return;
    if (!force) {
      let checkpointDue = false;
      for (const pending of this.#pendingSkipped.values()) {
        if (pending.ackedOffset - pending.persistedOffset >= MAX_UNPERSISTED_SKIP_OFFSETS) {
          checkpointDue = true;
          break;
        }
      }
      if (!checkpointDue) return;
    }

    const pending = [...this.#pendingSkipped.entries()];
    for (let start = 0; start < pending.length; start += MAX_SKIPPED_ACK_ROWS) {
      const batch = pending.slice(start, start + MAX_SKIPPED_ACK_ROWS);
      const bindings: SqlStorageValue[] = [];
      for (const [subscriptionKey, row] of batch) {
        bindings.push(subscriptionKey, row.ackedOffset, row.epoch);
      }
      this.#sql.exec(SKIPPED_ACK_STATEMENTS[batch.length]!, ...bindings);
      for (const [subscriptionKey] of batch) this.#pendingSkipped.delete(subscriptionKey);
    }
  }

  advanceWatermark(subscriptionKey: string, ackedOffset: number): void {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined) return;
    const nextOffset = Math.max(row.ackedOffset, ackedOffset);
    if (
      !this.#pendingSkipped.has(subscriptionKey) &&
      nextOffset === row.ackedOffset &&
      row.nextAttemptAt === null
    ) {
      return;
    }
    this.#db.advanceWatermark({
      subscriptionKey,
      ackedOffset: nextOffset,
    });
    this.#pendingSkipped.delete(subscriptionKey);
    row.ackedOffset = nextOffset;
    row.nextAttemptAt = null;
  }

  nack(
    subscriptionKey: string,
    args: { attempt: number; nextAttemptAt: number; error: string },
  ): void {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined) return;
    if (this.#pendingSkipped.has(subscriptionKey)) this.flushSkipped(true);
    const error = args.error.slice(0, 2_000);
    this.#db.nack({
      subscriptionKey,
      attempt: args.attempt,
      nextAttemptAt: args.nextAttemptAt,
      // Bound the stored error so a pathological message cannot bloat the row.
      error,
    });
    row.attempt = args.attempt;
    row.nextAttemptAt = args.nextAttemptAt;
    row.lastError = error;
  }

  setCursor(subscriptionKey: string, ackedOffset: number): void {
    const row = this.#rows().get(subscriptionKey);
    if (row === undefined) return;
    const epoch = this.#nextEpoch();
    this.#db.setCursor({
      subscriptionKey,
      ackedOffset,
      epoch,
    });
    this.#pendingSkipped.delete(subscriptionKey);
    row.ackedOffset = ackedOffset;
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
    row.epoch = epoch;
  }

  delete(subscriptionKey: string): void {
    const rows = this.#rows();
    if (!rows.has(subscriptionKey)) return;
    this.#db.delete({ subscriptionKey });
    this.#pendingSkipped.delete(subscriptionKey);
    rows.delete(subscriptionKey);
  }

  minNextAttemptAt(): number | null {
    let next: number | null = null;
    for (const row of this.#rows().values()) {
      if (row.nextAttemptAt !== null && (next === null || row.nextAttemptAt < next)) {
        next = row.nextAttemptAt;
      }
    }
    return next;
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

function createInsertStatements(prefix: string, rowWidth: number, maxRows: number): string[] {
  const row = `(${Array.from({ length: rowWidth }, () => "?").join(", ")})`;
  return Array.from({ length: maxRows + 1 }, (_, rowCount) =>
    rowCount === 0 ? "" : `${prefix} ${Array.from({ length: rowCount }, () => row).join(", ")}`,
  );
}

function createSkippedAckStatements(maxRows: number): string[] {
  return Array.from({ length: maxRows + 1 }, (_, rowCount) => {
    if (rowCount === 0) return "";
    const rows = Array.from({ length: rowCount }, () => "(?, ?, ?)").join(", ");
    return `
      with skipped(subscription_key, acked_offset, epoch) as (values ${rows})
      update subscriptions as current
      set acked_offset = max(current.acked_offset, skipped.acked_offset),
          attempt = 0,
          next_attempt_at = null,
          last_error = null
      from skipped
      where current.subscription_key = skipped.subscription_key
        and current.epoch = skipped.epoch
    `;
  });
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

// Shared across calls: each decode sequence runs synchronously to its final
// flush inside the single-threaded DO, so no two decodes can interleave.
const chunkDecoder = new TextDecoder();

function appendEventChunk(chunks: EventChunks | undefined, chunk: ArrayBuffer): EventChunks {
  if (chunks === undefined) return chunk;
  if (!Array.isArray(chunks)) return [chunks, chunk];
  chunks.push(chunk);
  return chunks;
}

function decodeChunks(chunks: EventChunks, byteLength: number): string {
  if (!Array.isArray(chunks)) return chunkDecoder.decode(chunks);
  if (chunks.length >= 3) {
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    return chunkDecoder.decode(bytes);
  }
  const parts: string[] = [];
  for (const chunk of chunks) parts.push(chunkDecoder.decode(chunk, { stream: true }));
  parts.push(chunkDecoder.decode());
  return parts.join("");
}
