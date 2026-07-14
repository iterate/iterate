// The stream's append log and shared schema in Durable Object SQLite.
//
// Storage is normalized into two tables: `events` is the offset-ordered
// metadata/index plus common event JSON inline, and `event_chunks` holds
// oversized event JSON as bounded UTF-8 byte rows. The enclosing stream path
// is the Durable Object's identity, so stored JSON omits that repeated field
// and reads restore it. Durable Object
// SQLite caps each string/blob/row cell at ~2 MB; BLOB columns do not raise
// that ceiling, and SQL-side substr(?) chunking would still require binding
// the oversized value first, so JSON above the conservative 1 MiB inline
// ceiling is split into 512 KiB chunks in JS.
//
// Every method here is synchronous and must stay that way: the Stream
// Durable Object's append commit point assigns offsets, reduces state, and
// persists the batch in one await-free turn.

import type { StreamEvent } from "./schemas.ts";

const EVENT_CHUNK_SIZE = 512 * 1024;
const MAX_INLINE_EVENT_BYTES = 1024 * 1024;
const CURRENT_STREAM_STORAGE_SCHEMA_VERSION = 9;
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
const KEYLESS_DURABLE_EVENT_INSERT_ROW_WIDTH = 3;
const DERIVED_KEYLESS_DURABLE_EVENT_FIXED_BINDINGS = 2;
const CHUNK_INSERT_ROW_WIDTH = 3;
const MAX_EVENT_ROWS_PER_INSERT = Math.floor(MAX_SQL_BINDINGS / EVENT_INSERT_ROW_WIDTH);
const MAX_KEYLESS_DURABLE_EVENT_ROWS_PER_INSERT = Math.floor(
  MAX_SQL_BINDINGS / KEYLESS_DURABLE_EVENT_INSERT_ROW_WIDTH,
);
// Above the direct VALUES capacity, contiguous rows of one type can bind the
// base offset and type once, leaving one binding per serialized event.
const MAX_DERIVED_KEYLESS_DURABLE_EVENT_ROWS_PER_INSERT =
  MAX_SQL_BINDINGS - DERIVED_KEYLESS_DURABLE_EVENT_FIXED_BINDINGS;
const MAX_CHUNK_ROWS_PER_INSERT = Math.floor(MAX_SQL_BINDINGS / CHUNK_INSERT_ROW_WIDTH);
const EVENT_INSERT_STATEMENTS = createInsertStatements(
  "insert into events (offset, type, idempotency_key, ephemeral, event_json) values",
  EVENT_INSERT_ROW_WIDTH,
  MAX_EVENT_ROWS_PER_INSERT,
);
// Durable rows without an idempotency key inherit the schema's null/zero
// defaults, fitting 33 rows under the same 100-binding ceiling instead of 20.
const KEYLESS_DURABLE_EVENT_INSERT_STATEMENTS = createInsertStatements(
  "insert into events (offset, type, event_json) values",
  KEYLESS_DURABLE_EVENT_INSERT_ROW_WIDTH,
  MAX_KEYLESS_DURABLE_EVENT_ROWS_PER_INSERT,
);
const DERIVED_KEYLESS_DURABLE_EVENT_INSERT_STATEMENTS = createDerivedEventInsertStatements(
  MAX_DERIVED_KEYLESS_DURABLE_EVENT_ROWS_PER_INSERT,
);
const CHUNK_INSERT_STATEMENTS = createInsertStatements(
  "insert into event_chunks (offset, chunk_index, chunk_bytes) values",
  CHUNK_INSERT_ROW_WIDTH,
  MAX_CHUNK_ROWS_PER_INSERT,
);
const textEncoder = new TextEncoder();
const TYPE_PROPERTY_PREFIX_BYTE_LENGTH = textEncoder.encode(',"type":').byteLength;
const OFFSET_PROPERTY_PREFIX_BYTE_LENGTH = textEncoder.encode(',"offset":').byteLength;
const IDEMPOTENCY_KEY_PROPERTY_PREFIX_BYTE_LENGTH =
  textEncoder.encode(',"idempotencyKey":').byteLength;
const EPHEMERAL_PROPERTY_BYTE_LENGTH = textEncoder.encode(',"ephemeral":true').byteLength;

/**
 * A committed event paired with its exact full-envelope serialized byte
 * length. Delivery batching sizes batches against the byte cap with these
 * instead of re-stringifying every event on every read.
 */
export type SizedStreamEvent = { event: StreamEvent; byteLength: number };
export type SelectedStreamFrame = {
  events: SizedStreamEvent[];
  scannedRawRows: number;
  rawThroughOffset: number;
  byteLength: number;
  stoppedByByteLimit: boolean;
};
export type StreamOffsetBounds = { highestOffset: number; highestAssignedOffset: number };
type EventChunks = ArrayBuffer | ArrayBuffer[];
type StreamRangeArgs = {
  afterOffset: number;
  beforeOffset: number;
  eventTypes?: readonly string[];
  limit: number;
  order?: "asc" | "desc";
  /** Include ephemeral rows. Default false — ephemeral is opt-in on every range read. */
  includeEphemeral?: boolean;
};
type TransactionRunner = { transactionSync<T>(callback: () => T): T };

const initializedStreamStorage = new WeakSet<SqlStorage>();

type StreamStorageBootstrap = StreamOffsetBounds & { version: number };
type StoredEventColumns = {
  offset: number;
  type: string;
  idempotencyKey: string | null;
  ephemeral: number;
};
type StoredEventRow = StoredEventColumns & { eventJson: string | null };

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

/** Bootstrap the append-log and delivery-cursor tables once per storage handle. */
export function initializeStreamStorage(sqlStorage: SqlStorage): StreamOffsetBounds | undefined {
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
    -- Stream-owned append log metadata. Bounded body JSON is inline; oversized JSON is chunked.
    -- offset is the replay cursor; the partial index below owns keyed dedup/lookups.
    -- event_json stores only createdAt plus user payload/metadata/source. Indexed
    -- envelope fields live once in their authoritative columns and are restored on
    -- reads. path is omitted because every row belongs to this DO's one path.
    -- Chunked rows retain their serialized body length beside null event_json so
    -- delivery sizing never reads chunks it may exclude at the frame boundary.
    -- ephemeral marks second-class rows: range reads exclude them unless asked, and
    -- the stream may evict them in the future. Eviction keeps offsets consumed
    -- in stream_storage_schema but forgets their idempotency keys.
    create table events (
      offset integer primary key,
      type text not null,
      idempotency_key text,
      ephemeral integer not null default 0,
      event_json blob,
      chunked_json_byte_length integer
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
    -- Committed event body JSON split into ordered byte chunks. The WITHOUT ROWID
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
      epoch integer not null default 0,
      pending_through_offset integer,
      pending_stream_max_offset integer,
      pending_attempt integer,
      pending_recovery_at integer,
      check ((pending_through_offset is null) = (pending_stream_max_offset is null)),
      check ((pending_through_offset is null) = (pending_attempt is null)),
      check (pending_through_offset is null or pending_stream_max_offset >= pending_through_offset),
      check (pending_attempt is null or pending_attempt >= 1),
      check (pending_recovery_at is null or pending_attempt is not null)
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
  readonly #path: string;
  readonly #pathPropertyByteLength: number;
  readonly #typeJsonByteLengths = new Map<string, number>();

  constructor(
    readonly sql: SqlStorage,
    path: string,
  ) {
    this.#path = path;
    this.#pathPropertyByteLength = textEncoder.encode(`,"path":${JSON.stringify(path)}`).byteLength;
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
   * Returns each event's exact full-envelope serialized byte length, so the
   * commit path can hand delivery fan-out a sized fresh tail without anyone
   * re-stringifying what was just serialized here. SQLite omits the invariant
   * stream path; #serializedEventByteLength restores that property's byte cost.
   */
  insert(
    events: readonly StreamEvent[],
    transactionRunner?: TransactionRunner,
  ): SizedStreamEvent[] {
    const firstEvent = events[0];
    let useKeylessDurableInsert =
      firstEvent!.idempotencyKey === undefined && firstEvent!.ephemeral !== true;
    let useDerivedKeylessDurableInsert =
      useKeylessDurableInsert && events.length > MAX_KEYLESS_DURABLE_EVENT_ROWS_PER_INSERT;
    for (let index = 1; index < events.length && useKeylessDurableInsert; index += 1) {
      const event = events[index]!;
      if (event.idempotencyKey !== undefined || event.ephemeral === true) {
        useKeylessDurableInsert = false;
        useDerivedKeylessDurableInsert = false;
      } else if (event.type !== firstEvent!.type || event.offset !== firstEvent!.offset + index) {
        useDerivedKeylessDurableInsert = false;
      }
    }
    const eventInsertStatements = useDerivedKeylessDurableInsert
      ? DERIVED_KEYLESS_DURABLE_EVENT_INSERT_STATEMENTS
      : useKeylessDurableInsert
        ? KEYLESS_DURABLE_EVENT_INSERT_STATEMENTS
        : EVENT_INSERT_STATEMENTS;
    const maxEventRowsPerInsert = useDerivedKeylessDurableInsert
      ? MAX_DERIVED_KEYLESS_DURABLE_EVENT_ROWS_PER_INSERT
      : useKeylessDurableInsert
        ? MAX_KEYLESS_DURABLE_EVENT_ROWS_PER_INSERT
        : MAX_EVENT_ROWS_PER_INSERT;
    let carriedSerialization: { eventIndex: number; bytes: Uint8Array } | undefined;
    let serializedPrefix: Uint8Array[] | undefined;
    if (events.length === 1) {
      const event = events[0]!;
      const bytes = this.#serializeEventBody(event);
      if (bytes.byteLength <= MAX_INLINE_EVENT_BYTES) {
        // This is the entire commit in one atomic SQLite statement. An
        // explicit transaction would add begin/commit work without widening
        // the failure boundary; multi-statement paths below still use it.
        const eventJson = exactArrayBuffer(bytes);
        if (useKeylessDurableInsert) {
          this.sql.exec(eventInsertStatements[1]!, event.offset, event.type, eventJson);
        } else {
          this.sql.exec(
            eventInsertStatements[1]!,
            event.offset,
            event.type,
            event.idempotencyKey ?? null,
            event.ephemeral === true ? 1 : 0,
            eventJson,
          );
        }
        return [{ event, byteLength: this.#serializedEventByteLength(bytes.byteLength, event) }];
      }
      // Preserve the large-event path's single-serialization guarantee.
      carriedSerialization = { eventIndex: 0, bytes };
    } else if (events.length <= maxEventRowsPerInsert) {
      const candidate = [] as Uint8Array[];
      let candidateByteLength = 0;
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        const bytes = this.#serializeEventBody(events[eventIndex]!);
        if (
          bytes.byteLength > MAX_INLINE_EVENT_BYTES ||
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
        const eventBindings: SqlStorageValue[] = useDerivedKeylessDurableInsert
          ? [firstEvent!.offset, firstEvent!.type]
          : [];
        const sizedEvents: SizedStreamEvent[] = [];
        for (let index = 0; index < events.length; index += 1) {
          const event = events[index]!;
          const bytes = candidate[index]!;
          if (useDerivedKeylessDurableInsert) {
            eventBindings.push(exactArrayBuffer(bytes));
          } else if (useKeylessDurableInsert) {
            eventBindings.push(event.offset, event.type, exactArrayBuffer(bytes));
          } else {
            eventBindings.push(
              event.offset,
              event.type,
              event.idempotencyKey ?? null,
              event.ephemeral === true ? 1 : 0,
              exactArrayBuffer(bytes),
            );
          }
          sizedEvents.push({
            event,
            byteLength: this.#serializedEventByteLength(bytes.byteLength, event),
          });
        }
        this.sql.exec(eventInsertStatements[events.length]!, ...eventBindings);
        return sizedEvents;
      }
      if (candidate.length > 0) serializedPrefix = candidate;
    }

    const insertBatched = () => {
      const sizedEvents: SizedStreamEvent[] = [];
      let batchStart = 0;

      while (batchStart < events.length) {
        const serializedEvents: Uint8Array[] = [];
        const eventBindings: SqlStorageValue[] = useDerivedKeylessDurableInsert
          ? [events[batchStart]!.offset, firstEvent!.type]
          : [];
        let serializedByteLength = 0;
        let batchEnd = batchStart;
        let chunkedEvent: { byteLength: number; offset: number } | undefined;

        while (batchEnd < events.length && serializedEvents.length < maxEventRowsPerInsert) {
          const event = events[batchEnd]!;
          const carried =
            carriedSerialization?.eventIndex === batchEnd ? carriedSerialization : null;
          const bytes =
            serializedPrefix?.[batchEnd] ?? carried?.bytes ?? this.#serializeEventBody(event);
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
          const eventJson =
            bytes.byteLength <= MAX_INLINE_EVENT_BYTES ? exactArrayBuffer(bytes) : null;
          if (useDerivedKeylessDurableInsert) {
            eventBindings.push(eventJson);
          } else if (useKeylessDurableInsert) {
            eventBindings.push(event.offset, event.type, eventJson);
          } else {
            eventBindings.push(
              event.offset,
              event.type,
              event.idempotencyKey ?? null,
              event.ephemeral === true ? 1 : 0,
              eventJson,
            );
          }
          if (bytes.byteLength > MAX_INLINE_EVENT_BYTES) {
            if (chunkedEvent !== undefined) {
              throw new Error("Stream insert batch exceeded one chunked event");
            }
            chunkedEvent = { byteLength: bytes.byteLength, offset: event.offset };
          }
          sizedEvents.push({
            event,
            byteLength: this.#serializedEventByteLength(bytes.byteLength, event),
          });
          serializedByteLength += bytes.byteLength;
          batchEnd += 1;
        }

        this.sql.exec(eventInsertStatements[serializedEvents.length]!, ...eventBindings);

        if (chunkedEvent === undefined) {
          batchStart = batchEnd;
          continue;
        }
        this.sql.exec(
          "update events set chunked_json_byte_length = ? where offset = ?",
          chunkedEvent.byteLength,
          chunkedEvent.offset,
        );

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
          if (rawJsonBytes.byteLength <= MAX_INLINE_EVENT_BYTES) continue;

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
      .exec<StoredEventRow>(
        `select offset, type, idempotency_key as idempotencyKey, ephemeral,
                cast(event_json as text) as eventJson
         from events where offset = ?`,
        offset,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    if (row.eventJson !== null) return this.#parseEvent(row.eventJson, 0, row);
    const chunked = this.#readChunkedEvents([offset]).get(offset);
    return chunked === undefined
      ? undefined
      : this.#parseEvent(chunked.chunks, chunked.byteLength, row);
  }

  getByIdempotencyKey(idempotencyKey: string): StreamEvent | undefined {
    const row = this.sql
      .exec<StoredEventRow>(
        `select offset, type, idempotency_key as idempotencyKey, ephemeral,
                cast(event_json as text) as eventJson
         from events where idempotency_key = ?`,
        idempotencyKey,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    if (row.eventJson !== null) return this.#parseEvent(row.eventJson, 0, row);
    const chunked = this.#readChunkedEvents([row.offset]).get(row.offset);
    return chunked === undefined
      ? undefined
      : this.#parseEvent(chunked.chunks, chunked.byteLength, row);
  }

  /** Resolve a void append's duplicate without materializing its stored event. */
  getOffsetByIdempotencyKey(idempotencyKey: string): number | undefined {
    return this.sql
      .exec<{ offset: number }>(
        "select offset from events where idempotency_key = ?",
        idempotencyKey,
      )
      .toArray()[0]?.offset;
  }

  /** Batched counterpart to getOffsetByIdempotencyKey for variadic void appends. */
  getOffsetsByIdempotencyKeys(idempotencyKeys: readonly string[]): Map<string, number> {
    if (idempotencyKeys.length === 1) {
      const idempotencyKey = idempotencyKeys[0]!;
      const offset = this.getOffsetByIdempotencyKey(idempotencyKey);
      return offset === undefined ? new Map() : new Map([[idempotencyKey, offset]]);
    }
    const offsets = new Map<string, number>();
    for (let start = 0; start < idempotencyKeys.length; start += MAX_SQL_BINDINGS) {
      const keys = idempotencyKeys.slice(start, start + MAX_SQL_BINDINGS);
      for (const [idempotencyKey, offset] of this.sql
        .exec(
          `
            select idempotency_key as idempotencyKey, offset
            from events
            where idempotency_key in (${keys.map(() => "?").join(", ")})
          `,
          ...keys,
        )
        .raw<[string, number]>()) {
        offsets.set(idempotencyKey, offset);
      }
    }
    return offsets;
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
      let chunkedRows: StoredEventColumns[] | undefined;
      for (const row of this.sql
        .exec(
          `
            select offset, type, idempotency_key as idempotencyKey, ephemeral,
              cast(event_json as text) as eventJson
            from events
            where idempotency_key in (${keys.map(() => "?").join(", ")})
          `,
          ...keys,
        )
        .raw<[number, string, string, number, string | null]>()) {
        const [offset, type, idempotencyKey, ephemeral, eventJson] = row;
        const columns = { offset, type, idempotencyKey, ephemeral };
        if (eventJson === null) {
          // Reserve the key now so chunk hydration can replace it in place.
          events.set(idempotencyKey, undefined);
          (chunkedRows ??= []).push(columns);
        } else {
          events.set(idempotencyKey, this.#parseEvent(eventJson, 0, columns));
        }
      }
      if (chunkedRows !== undefined) {
        const chunkedEvents = this.#readChunkedEvents(chunkedRows.map((row) => row.offset));
        for (const row of chunkedRows) {
          const stored = chunkedEvents.get(row.offset);
          if (stored === undefined) {
            events.delete(row.idempotencyKey!);
          } else {
            events.set(
              row.idempotencyKey!,
              this.#parseEvent(stored.chunks, stored.byteLength, row),
            );
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
   * `getRange` plus each event's full-envelope byte length, so delivery
   * batching can enforce its byte cap without re-stringifying every event it
   * just parsed.
   */
  getRangeSized(args: StreamRangeArgs): SizedStreamEvent[] {
    return this.#readRange(args, true);
  }

  /**
   * Scan a bounded raw offset range while materializing only durable rows with
   * one of the requested types. The raw cursor still advances over every row,
   * so a caller can acknowledge selector misses without parsing their JSON.
   */
  scanPushEventTypesFrame(args: {
    afterOffset: number;
    throughOffset: number;
    eventTypes: readonly string[];
    rawLimit: number;
    selectedByteLimit: number;
  }): SelectedStreamFrame {
    const eventTypesJson = JSON.stringify([...new Set(args.eventTypes)]);
    const rows = this.sql
      .exec(
        `
          with raw_bounds as materialized (
            select count(*) as raw_row_count,
                   max(offset) as raw_last_offset
            from (
              select offset
              from events
              where offset > ?
                and offset <= ?
              order by offset asc
              limit ?
            )
          ),
          boundary as materialized (
            select raw_row_count,
                   case
                     when raw_row_count < ? then ?
                     else coalesce(raw_last_offset, ?)
                   end as raw_through_offset
            from raw_bounds
          ),
          selected as not materialized (
            select events.offset,
                   coalesce(length(event_json), chunked_json_byte_length)
                     + ${TYPE_PROPERTY_PREFIX_BYTE_LENGTH}
                     + length(cast(json_quote(type) as blob))
                     + ${OFFSET_PROPERTY_PREFIX_BYTE_LENGTH}
                     + length(cast(offset as text))
                     + case
                         when idempotency_key is null then 0
                         else ${IDEMPOTENCY_KEY_PROPERTY_PREFIX_BYTE_LENGTH}
                           + length(cast(json_quote(idempotency_key) as blob))
                       end
                     + case
                         when ephemeral = 1 then ${EPHEMERAL_PROPERTY_BYTE_LENGTH}
                         else 0
                       end
                     + ? as byte_length
            from events
            cross join boundary
            where events.offset > ?
              and events.offset <= boundary.raw_through_offset
              and ephemeral = 0
              and type in (select value from json_each(?))
          ),
          ranked as materialized (
            select offset,
                   byte_length,
                   row_number() over (order by offset) as selected_index,
                   sum(byte_length) over (
                     order by offset rows between unbounded preceding and current row
                   ) as cumulative_bytes
            from selected
          ),
          cut as materialized (
            select min(offset) as first_excluded_offset
            from ranked
            where selected_index > 1
              and cumulative_bytes > ?
          ),
          consumed_stats as materialized (
            select count(events.offset) as scanned_raw_rows,
                   max(events.offset) as raw_last_offset
            from cut
            left join events
              on cut.first_excluded_offset is not null
             and events.offset > ?
             and events.offset < cut.first_excluded_offset
          ),
          scan as materialized (
            select case
                     when cut.first_excluded_offset is null then boundary.raw_through_offset
                     else coalesce(consumed_stats.raw_last_offset, ?)
                   end as raw_through_offset,
                   case
                     when cut.first_excluded_offset is null then boundary.raw_row_count
                     else consumed_stats.scanned_raw_rows
                   end as scanned_raw_rows,
                   cut.first_excluded_offset is not null as stopped_by_byte_limit
            from cut
            cross join boundary
            cross join consumed_stats
          )
          select 0 as kind,
                 raw_through_offset as row_offset,
                 scanned_raw_rows,
                 stopped_by_byte_limit,
                 null as event_type,
                 null as idempotency_key,
                 null as ephemeral,
                 null as event_json_or_offset,
                 null as byte_length
          from scan
          union all
          select 1,
                 ranked.offset,
                 null,
                 null,
                 events.type,
                 events.idempotency_key,
                 events.ephemeral,
                 coalesce(cast(events.event_json as text), ranked.offset),
                 ranked.byte_length
          from ranked
          join events using (offset)
          cross join cut
          where cut.first_excluded_offset is null
             or ranked.offset < cut.first_excluded_offset
          order by kind, row_offset
        `,
        args.afterOffset,
        args.throughOffset,
        args.rawLimit,
        args.rawLimit,
        args.throughOffset,
        args.afterOffset,
        this.#pathPropertyByteLength,
        args.afterOffset,
        eventTypesJson,
        args.selectedByteLimit,
        args.afterOffset,
        args.afterOffset,
      )
      .raw<
        [
          number,
          number,
          number | null,
          number | null,
          string | null,
          string | null,
          number | null,
          string | number | null,
          number | null,
        ]
      >();

    const events: Array<SizedStreamEvent | undefined> = [];
    let chunkedRows:
      | Array<{ resultIndex: number; columns: StoredEventColumns; byteLength: number }>
      | undefined;
    let rawThroughOffset: number | undefined;
    let scannedRawRows: number | undefined;
    let stoppedByByteLimit: boolean | undefined;
    for (const [
      kind,
      offset,
      rawRows,
      stopped,
      type,
      idempotencyKey,
      ephemeral,
      eventJsonOrOffset,
      byteLength,
    ] of rows) {
      if (kind === 0) {
        rawThroughOffset = offset;
        scannedRawRows = rawRows ?? 0;
        stoppedByByteLimit = stopped === 1;
        continue;
      }
      if (
        type === null ||
        ephemeral === null ||
        eventJsonOrOffset === null ||
        byteLength === null
      ) {
        continue;
      }
      const columns = { offset, type, idempotencyKey, ephemeral };
      if (typeof eventJsonOrOffset === "number") {
        (chunkedRows ??= []).push({ resultIndex: events.length, columns, byteLength });
        events.push(undefined);
      } else {
        events.push({ event: this.#parseEvent(eventJsonOrOffset, 0, columns), byteLength });
      }
    }
    if (
      rawThroughOffset === undefined ||
      scannedRawRows === undefined ||
      stoppedByByteLimit === undefined
    ) {
      throw new Error("Selected stream frame did not return scan metadata");
    }

    if (chunkedRows !== undefined) {
      const chunkedOffsets = chunkedRows.map((row) => row.columns.offset);
      const chunkedEvents = this.#readChunkedEvents(chunkedOffsets);
      for (const row of chunkedRows) {
        const stored = chunkedEvents.get(row.columns.offset);
        if (stored === undefined) continue;
        events[row.resultIndex] = {
          event: this.#parseEvent(stored.chunks, stored.byteLength, row.columns),
          byteLength: row.byteLength,
        };
      }
    }

    const completeEvents = events.filter((event) => event !== undefined);
    return {
      events: completeEvents,
      scannedRawRows,
      rawThroughOffset,
      byteLength: completeEvents.reduce((total, event) => total + event.byteLength, 0),
      stoppedByByteLimit,
    };
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
    const order = args.order ?? "asc";
    // Common rows carry their JSON directly. Oversized rows carry their offset
    // in the same positional column and are hydrated from bounded chunks below.
    const byteLengthColumn = includeByteLength ? ", length(event_json) as inlineByteLength" : "";
    const rows = this.sql
      .exec(
        `
          select offset, type, idempotency_key, ephemeral,
                 coalesce(cast(event_json as text), offset) as eventJsonOrOffset${byteLengthColumn}
          from events
          where offset > ?
            and offset < ?
            ${ephemeralClause}
            ${eventTypeClause}
          order by offset ${order}
          limit ?
        `,
        args.afterOffset,
        args.beforeOffset,
        ...(eventTypes ?? []),
        args.limit,
      )
      .raw<[number, string, string | null, number, string | number, number | null]>();
    const events: Array<SizedStreamEvent | StreamEvent | undefined> = [];
    let chunkedRows: Array<{ resultIndex: number; columns: StoredEventColumns }> | undefined;
    for (const [
      offset,
      type,
      idempotencyKey,
      ephemeral,
      eventJsonOrOffset,
      inlineByteLength,
    ] of rows) {
      const columns = { offset, type, idempotencyKey, ephemeral };
      if (typeof eventJsonOrOffset === "number") {
        (chunkedRows ??= []).push({ resultIndex: events.length, columns });
        events.push(undefined);
        continue;
      }
      const event = this.#parseEvent(eventJsonOrOffset, 0, columns);
      events.push(
        includeByteLength
          ? {
              event,
              byteLength: this.#serializedEventByteLength(inlineByteLength ?? 0, event),
            }
          : event,
      );
    }
    if (chunkedRows === undefined) {
      return events as Array<SizedStreamEvent | StreamEvent>;
    }

    const chunkedOffsets = chunkedRows.map((row) => row.columns.offset);
    const chunkedEvents = this.#readChunkedEvents(chunkedOffsets);
    let hasMissingChunks = false;
    for (const row of chunkedRows) {
      const stored = chunkedEvents.get(row.columns.offset);
      if (stored === undefined) {
        hasMissingChunks = true;
        continue;
      }
      const event = this.#parseEvent(stored.chunks, stored.byteLength, row.columns);
      events[row.resultIndex] = includeByteLength
        ? { event, byteLength: this.#serializedEventByteLength(stored.byteLength, event) }
        : event;
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

  /** Decode body JSON, then restore the authoritative indexed envelope columns. */
  #parseEvent(
    storedJson: string | EventChunks,
    byteLength: number,
    columns: StoredEventColumns,
  ): StreamEvent {
    const json = typeof storedJson === "string" ? storedJson : decodeChunks(storedJson, byteLength);
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Stored stream event body must be an object");
    }
    const event = parsed as Partial<StreamEvent>;
    event.type = columns.type;
    event.offset = columns.offset;
    event.path = this.#path;
    if (columns.idempotencyKey === null) {
      delete event.idempotencyKey;
    } else {
      event.idempotencyKey = columns.idempotencyKey;
    }
    if (columns.ephemeral === 1) {
      event.ephemeral = true;
    } else {
      delete event.ephemeral;
    }
    return event as StreamEvent;
  }

  #serializeEventBody(event: StreamEvent): Uint8Array {
    if (event.path !== this.#path) {
      throw new Error(`Cannot store event for path ${event.path} in stream ${this.#path}`);
    }
    const {
      path: _path,
      type: _type,
      offset: _offset,
      idempotencyKey: _idempotencyKey,
      ephemeral: _ephemeral,
      ...storedBody
    } = event;
    return textEncoder.encode(JSON.stringify(storedBody));
  }

  #serializedEventByteLength(storedBodyByteLength: number, event: StreamEvent): number {
    let typeJsonByteLength = this.#typeJsonByteLengths.get(event.type);
    if (typeJsonByteLength === undefined) {
      typeJsonByteLength = textEncoder.encode(JSON.stringify(event.type)).byteLength;
      if (this.#typeJsonByteLengths.size >= 128) this.#typeJsonByteLengths.clear();
      this.#typeJsonByteLengths.set(event.type, typeJsonByteLength);
    }
    return (
      storedBodyByteLength +
      TYPE_PROPERTY_PREFIX_BYTE_LENGTH +
      typeJsonByteLength +
      OFFSET_PROPERTY_PREFIX_BYTE_LENGTH +
      String(event.offset).length +
      (event.idempotencyKey === undefined
        ? 0
        : IDEMPOTENCY_KEY_PROPERTY_PREFIX_BYTE_LENGTH +
          textEncoder.encode(JSON.stringify(event.idempotencyKey)).byteLength) +
      (event.ephemeral === true ? EPHEMERAL_PROPERTY_BYTE_LENGTH : 0) +
      this.#pathPropertyByteLength
    );
  }
}

function createInsertStatements(prefix: string, rowWidth: number, maxRows: number): string[] {
  const row = `(${Array.from({ length: rowWidth }, () => "?").join(", ")})`;
  return Array.from({ length: maxRows + 1 }, (_, rowCount) =>
    rowCount === 0 ? "" : `${prefix} ${Array.from({ length: rowCount }, () => row).join(", ")}`,
  );
}

function createDerivedEventInsertStatements(maxRows: number): string[] {
  return Array.from({ length: maxRows + 1 }, (_, rowCount) =>
    rowCount === 0
      ? ""
      : `insert into events (offset, type, event_json)
         select ? + column1, ?, column2
         from (values ${Array.from({ length: rowCount }, (_, index) => `(${index}, ?)`).join(", ")})`,
  );
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
