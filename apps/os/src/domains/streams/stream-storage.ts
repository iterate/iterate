// The stream's append log in Durable Object SQLite.
//
// Storage is normalized into two tables: `events` is the offset-ordered
// metadata/index, and `event_chunks` holds the full event JSON as bounded
// UTF-8 byte rows. Durable Object SQLite caps each string/blob/row cell at
// ~2 MB; BLOB columns do not raise that ceiling, and SQL-side substr(?)
// chunking would still require binding the oversized value first, so event
// JSON is chunked in JS.
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
