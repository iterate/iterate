/**
 * Stream event model and storage helpers for Durable Object event logs.
 *
 * ## Output gates (why `allowUnconfirmedWrites` exists)
 *
 * On every storage write, Durable Objects can hold back **outgoing** network messages until the
 * write is confirmed — HTTP responses, RPC return values, WebSocket `send()`, `fetch()` from the
 * DO, and chunks on a returned `ReadableStream`. Cloudflare calls this the **output gate**.
 *
 * - Overview: [Durable Objects: Easy, Fast, Correct — Choose three](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
 * - SQLite API default: outgoing messages pause until prior writes flush —
 *   [SQLite-backed storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
 * - `sql.exec()` writes always participate in this model (no `allowUnconfirmed` knob on SQL).
 *
 * "Confirmed" on SQLite-backed DOs means the Storage Relay Service (SRS) has the WAL on ≥3/5
 * follower machines — not yet R2. Gate opens on that quorum ack:
 * [Zero-latency SQLite storage in every Durable Object](https://blog.cloudflare.com/sqlite-in-durable-objects/)
 *
 * ## SQL helpers (`writeEvent`, …)
 *
 * Sync `ctx.storage.sql.exec` — same gate semantics as default KV writes. Every `INSERT` can delay
 * the caller's RPC reply and any concurrent fan-out until the coalesced flush completes (writes
 * coalesce to O(1) SRS round-trips per event loop turn even across `await`s).
 *
 * ## KV helpers (`writeEventFromKv`, …)
 *
 * KV `put`/`get` on SQLite DOs land in the hidden `__cf_kv` table (same DB, same SRS durability):
 * [SQLite storage API — footnote 2](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
 *
 * Reads use sync [`ctx.storage.kv`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#synchronous-kv-api)
 * (`get` returns `T | undefined`, not a Promise).
 *
 * `writeEventFromKv` takes `allowUnconfirmedWrites`:
 *
 * | Value | Write path | Effect on egress |
 * | --- | --- | --- |
 * | `true` (default) | Async [`put` + `allowUnconfirmed: true`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#put), no `await` | Helper returns immediately; **does not** hold the output gate on these writes — fan-out / RPC can proceed while the write buffer flushes |
 * | `false` | Sync [`storage.kv.put`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#synchronous-kv-api) inside [`transactionSync`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync) | Helper still returns synchronously to your code, but the **output gate blocks** subsequent outgoing messages until SRS confirms (similar to SQL / default `put`) |
 *
 * `allowUnconfirmed` is only on the **async** `ctx.storage.put`, not on `storage.kv.put` — so the
 * fast path cannot be expressed with sync KV alone.
 *
 * Optional explicit flush after unconfirmed writes: [`await ctx.storage.sync()`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#sync)
 * (not called by these helpers; use at the DO boundary if the caller must wait for disk).
 *
 * ## Multi-key atomicity (event + idempotency index + meta)
 *
 * Each append touches up to three keys (`event:*`, `idempotency:*`, `maxOffset`).
 *
 * - Every storage method is implicitly transactional, including multi-key access — footnote 1 on
 *   [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
 * - `allowUnconfirmedWrites: false`: all three `kv.put` calls run inside one `transactionSync` callback
 *   ([`transactionSync`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync))
 * - `allowUnconfirmedWrites: true`: idempotency/offset reads in `transactionSync`, then three async
 *   `put`s with no `await` between them — [automatic write coalescing](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#automatic-write-coalescing)
 *   ("either all of the writes will have been stored to disk or none")
 * - Reads followed by writes with no intervening I/O also behave as a transaction —
 *   [`transaction`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)
 *
 * Correctness if a write fails: the DO is reset, queued outgoing messages become errors — applies
 * equally to unconfirmed writes ([`allowUnconfirmed` docs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#put));
 * opting out only skips *waiting*, not durability guarantees.
 */
import { z } from "zod";

export type StreamEventSource = {
  processor?: {
    slug: string;
    version: string;
  };
};

/** Append input for a stream event. Generic `Type` / `Payload` are used by stream processors. */
export type StreamEventInput<Type extends string = string, Payload = unknown> = {
  type: Type;
  payload?: Payload;
  metadata?: Record<string, unknown>;
  source?: StreamEventSource;
  idempotencyKey?: string;
  /** Precondition: must equal the next offset when set. */
  offset?: number;
};

/** Committed stream event. The owning stream is clear from context (reduced state). */
export type StreamEvent<Type extends string = string, Payload = unknown> = StreamEventInput<
  Type,
  Payload
> & {
  offset: number;
  createdAt: string;
};

export const StreamEventMetadata = z.record(z.string(), z.unknown());
export const streamEventOffsetSchema = z.number().int().nonnegative();
export const StreamEventCreatedAt = z.string();
export const streamEventCreatedAtIsoSchema = z.iso.datetime({ offset: true });
export const streamEventPathSchema = z.string().trim().min(1);

export const StreamEventInput = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
  metadata: StreamEventMetadata.optional(),
  source: z
    .object({
      processor: z
        .object({
          slug: z.string(),
          version: z.string(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  idempotencyKey: z.string().optional(),
  /** Precondition: must equal the next offset when set. */
  offset: streamEventOffsetSchema.optional(),
});

export const StreamEvent = StreamEventInput.extend({
  offset: streamEventOffsetSchema,
  createdAt: StreamEventCreatedAt,
});

export type StreamEventRow = {
  offset: number;
  type: string;
  idempotency_key: string | null;
  raw_event: string;
};

export type StreamEventSql = DurableObjectStorage["sql"];

/** Sync KV (`ctx.storage.kv`) plus async `put` / `transactionSync` on `ctx.storage`. */
export type StreamEventKvStorage = Pick<DurableObjectStorage, "kv" | "put" | "transactionSync">;

export type StreamEventSyncKv = DurableObjectStorage["kv"];

export const STREAM_EVENTS_SCHEMA = `
  create table if not exists events (
    offset integer primary key autoincrement,
    type text not null,
    idempotency_key text unique,
    raw_event text not null check (json_valid(raw_event))
  )
`;

/** Full `StreamEvent` JSON at `event:{offset}`. */
export const streamEventKvKey = (offset: number) => `event:${offset}`;

/** Idempotency lookup: `idempotency:{key}` → numeric offset (separate key so reads are O(1)). */
export const streamEventIdempotencyKvKey = (idempotencyKey: string) =>
  `idempotency:${idempotencyKey}`;

/** High-water offset; `maxOffsetFromKv` reads this instead of scanning `event:*`. */
export const STREAM_EVENTS_META_MAX_OFFSET_KEY = "maxOffset";

/**
 * Async `put` options for the `allowUnconfirmedWrites: true` path only.
 *
 * - `allowUnconfirmed: true` — opt out of holding the output gate until flush; see
 *   https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#put
 * - `noCache: true` — drop from in-memory cache after flush (append-only log); same section
 */
/** Async `put` options for append-only stream events (`allowUnconfirmed` + `noCache`). */
export const STREAM_EVENT_UNCONFIRMED_KV_PUT = {
  allowUnconfirmed: true,
  noCache: true,
} as const;

export function initStreamEventsTable({ sql }: { sql: StreamEventSql }): void {
  sql.exec(STREAM_EVENTS_SCHEMA);
}

/** No-op for KV backends — there is no DDL. Keys are documented above. */
export function initStreamEventsFromKv(): void {}

export function streamEventInputToCommitted(args: {
  input: StreamEventInput;
  offset: number;
  createdAt: string;
}): StreamEvent {
  const { offset: _precondition, ...input } = args.input;
  return { ...input, offset: args.offset, createdAt: args.createdAt };
}

export function streamEventToRow(event: StreamEvent) {
  return {
    offset: event.offset,
    type: event.type,
    idempotency_key: event.idempotencyKey ?? null,
    raw_event: JSON.stringify(event),
  };
}

export function streamEventRowToEvent(row: { raw_event: string }): StreamEvent {
  return StreamEvent.parse(JSON.parse(row.raw_event));
}

export function countStreamEvents({ sql }: { sql: StreamEventSql }): number {
  return sql.exec<{ c: number }>("select count(*) as c from events").one().c;
}

export function maxOffsetFromKv({ kv }: { kv: StreamEventSyncKv }): number {
  return kv.get<number>(STREAM_EVENTS_META_MAX_OFFSET_KEY) ?? 0;
}

export function readEventByOffset({
  sql,
  offset,
}: {
  sql: StreamEventSql;
  offset: number;
}): StreamEvent | null {
  const row = sql
    .exec<StreamEventRow>(
      "select offset, type, idempotency_key, raw_event from events where offset = ?",
      offset,
    )
    .toArray()[0];
  return row === undefined ? null : streamEventRowToEvent(row);
}

export function readEventByOffsetFromKv({
  kv,
  offset,
}: {
  kv: StreamEventSyncKv;
  offset: number;
}): StreamEvent | null {
  return kv.get<StreamEvent>(streamEventKvKey(offset)) ?? null;
}

export function readEventByIdempotencyKey({
  sql,
  idempotencyKey,
}: {
  sql: StreamEventSql;
  idempotencyKey: string;
}): StreamEvent | null {
  const row = sql
    .exec<StreamEventRow>(
      "select offset, type, idempotency_key, raw_event from events where idempotency_key = ? limit 1",
      idempotencyKey,
    )
    .toArray()[0];
  return row === undefined ? null : streamEventRowToEvent(row);
}

export function readEventByIdempotencyKeyFromKv({
  kv,
  idempotencyKey,
}: {
  kv: StreamEventSyncKv;
  idempotencyKey: string;
}): StreamEvent | null {
  const offset = kv.get<number>(streamEventIdempotencyKvKey(idempotencyKey));
  if (offset === undefined) return null;
  return readEventByOffsetFromKv({ kv, offset });
}

/**
 * Append via SQL `events` table. Synchronous; blocks the output gate on each write (no escape hatch
 * on `sql.exec`). Compare throughput against `writeEventFromKv` + `allowUnconfirmedWrites: true`.
 */
export function writeEvent({
  sql,
  input,
}: {
  sql: StreamEventSql;
  input: StreamEventInput;
}): StreamEvent {
  if (input.idempotencyKey !== undefined) {
    const existing = readEventByIdempotencyKey({ sql, idempotencyKey: input.idempotencyKey });
    if (existing !== null) return existing;
  }

  const latest =
    sql.exec<{ offset: number | null }>("select max(offset) as offset from events").one().offset ??
    0;
  const nextOffset = latest + 1;
  if (input.offset !== undefined && input.offset !== nextOffset) {
    throw new Error(`Offset precondition failed: expected ${nextOffset}, got ${input.offset}`);
  }

  const row = streamEventToRow(
    streamEventInputToCommitted({
      input,
      offset: nextOffset,
      createdAt: new Date().toISOString(),
    }),
  );
  const stored = sql
    .exec<StreamEventRow>(
      "insert into events (offset, type, idempotency_key, raw_event) values (?, ?, ?, ?) returning offset, type, idempotency_key, raw_event",
      row.offset,
      row.type,
      row.idempotency_key,
      row.raw_event,
    )
    .one();
  return streamEventRowToEvent(stored);
}

type StreamEventKvAppendPlan =
  | { kind: "existing"; event: StreamEvent }
  | { kind: "append"; event: StreamEvent; idempotencyKey?: string };

/**
 * Sync append via KV into `__cf_kv`. Pass `ctx.storage` (uses `.kv`, `.put`, `.transactionSync`).
 *
 * ### `allowUnconfirmedWrites: true` (throughput / fan-out friendly)
 *
 * 1. `transactionSync` + sync `kv.get` — idempotency check, read `maxOffset`, allocate
 *    offset ([`transactionSync`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync)).
 * 2. Three `void storage.put(..., { allowUnconfirmed: true, noCache: true })` with **no `await`**
 *    between them — coalesced atomic batch per
 *    [automatic write coalescing](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#automatic-write-coalescing).
 * 3. Returns `StreamEvent` immediately; WebSocket fan-out / RPC reply are **not** held on these puts
 *    ([`allowUnconfirmed`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#put)).
 *
 * ### `allowUnconfirmedWrites: false` (same egress semantics as SQL / default storage)
 *
 * 1. Same `transactionSync` reads as above.
 * 2. All three keys written with sync [`storage.kv.put`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#synchronous-kv-api)
 *    inside the callback — one atomic transaction; output gate applies until SRS confirms.
 * 3. Returns `StreamEvent` synchronously to caller code, but the platform still won't deliver
 *    outgoing messages until the write is confirmed (see file-header output gate section).
 */
export function writeEventFromKv({
  storage,
  input,
  allowUnconfirmedWrites = true,
}: {
  storage: StreamEventKvStorage;
  input: StreamEventInput;
  /**
   * When `true`, use [`allowUnconfirmed`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#put)
   * on async `put` — egress is not blocked on this append.
   * When `false`, hold the [output gate](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
   * until this append is confirmed on SRS followers (sync `kv.put`, like SQL).
   */
  allowUnconfirmedWrites?: boolean;
}): StreamEvent {
  const plan = storage.transactionSync((): StreamEventKvAppendPlan => {
    if (input.idempotencyKey !== undefined) {
      const existingOffset = storage.kv.get<number>(
        streamEventIdempotencyKvKey(input.idempotencyKey),
      );
      if (existingOffset !== undefined) {
        const existing = storage.kv.get<StreamEvent>(streamEventKvKey(existingOffset));
        if (existing !== undefined) return { kind: "existing", event: existing };
        throw new Error(
          `Idempotency index points at missing stream event offset ${existingOffset}`,
        );
      }
    }

    const latest = storage.kv.get<number>(STREAM_EVENTS_META_MAX_OFFSET_KEY) ?? 0;
    const nextOffset = latest + 1;
    if (input.offset !== undefined && input.offset !== nextOffset) {
      throw new Error(`Offset precondition failed: expected ${nextOffset}, got ${input.offset}`);
    }

    const event = streamEventInputToCommitted({
      input,
      offset: nextOffset,
      createdAt: new Date().toISOString(),
    });

    if (!allowUnconfirmedWrites) {
      // Gated path: sync kv.put × 3 in one transactionSync — see function doc above.
      storage.kv.put(streamEventKvKey(nextOffset), event);
      if (input.idempotencyKey !== undefined) {
        storage.kv.put(streamEventIdempotencyKvKey(input.idempotencyKey), nextOffset);
      }
      storage.kv.put(STREAM_EVENTS_META_MAX_OFFSET_KEY, nextOffset);
    }

    return { kind: "append", event, idempotencyKey: input.idempotencyKey };
  });

  if (plan.kind === "existing") return plan.event;

  if (allowUnconfirmedWrites) {
    // Fast path: async put × 3, no await — atomic batch + allowUnconfirmed (links in file header).
    void storage.put(
      streamEventKvKey(plan.event.offset),
      plan.event,
      STREAM_EVENT_UNCONFIRMED_KV_PUT,
    );
    if (plan.idempotencyKey !== undefined) {
      void storage.put(
        streamEventIdempotencyKvKey(plan.idempotencyKey),
        plan.event.offset,
        STREAM_EVENT_UNCONFIRMED_KV_PUT,
      );
    }
    void storage.put(
      STREAM_EVENTS_META_MAX_OFFSET_KEY,
      plan.event.offset,
      STREAM_EVENT_UNCONFIRMED_KV_PUT,
    );
  }

  return plan.event;
}
