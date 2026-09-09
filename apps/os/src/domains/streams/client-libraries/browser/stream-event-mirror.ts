import type { StreamEventBatch } from "iterate/processors";
import type { SqlClient } from "./stream-browser-db.ts";

/** Copies selected events verbatim. Normal browser subscriptions select only durable events. */
// Raw rows use INT_MAX as their tie-breaker to follow pretty rows at the same offset.
export async function openStreamEventMirror(
  sql: SqlClient,
  source: { streamId: string; streamMaxOffset: number },
) {
  await sql.batch(
    [
      {
        sql: `CREATE TABLE IF NOT EXISTS stream_sync (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          stream_id TEXT NOT NULL,
          through_offset INTEGER NOT NULL CHECK (through_offset >= 0),
          owner TEXT NOT NULL
        )`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS events (
          local_index INTEGER PRIMARY KEY,
          raw_jsonb BLOB NOT NULL,
          offset INTEGER GENERATED ALWAYS AS (json_extract(raw_jsonb, '$.offset')) STORED NOT NULL UNIQUE,
          type TEXT GENERATED ALWAYS AS (json_extract(raw_jsonb, '$.type')) STORED NOT NULL,
          idempotency_key TEXT GENERATED ALWAYS AS (json_extract(raw_jsonb, '$.idempotencyKey')) STORED,
          created_at TEXT GENERATED ALWAYS AS (json_extract(raw_jsonb, '$.createdAt')) STORED NOT NULL,
          inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      },
      { sql: `CREATE INDEX IF NOT EXISTS events_type_local_index ON events(type, local_index)` },
      {
        sql: `CREATE INDEX IF NOT EXISTS events_feed_revision ON events(
          json_extract(raw_jsonb, '$.payload.item.id'),
          json_extract(raw_jsonb, '$.payload.revisionOffset')
        ) WHERE type = 'events.iterate.com/feed/item-published'`,
      },
      {
        sql: `CREATE VIEW IF NOT EXISTS feed_items AS
          SELECT (SELECT MIN(original.offset) FROM events AS original
              WHERE original.type = 'events.iterate.com/feed/item-published'
                AND json_extract(original.raw_jsonb, '$.payload.item.id') = json_extract(item.raw_jsonb, '$.payload.item.id')
            ) AS local_index,
            json_extract(raw_jsonb, '$.payload.ordinal') AS ordinal,
            'agent.' || json_extract(raw_jsonb, '$.payload.item.kind') AS kind,
            json_extract(raw_jsonb, '$.payload.firstOffset') AS first_offset,
            json_extract(raw_jsonb, '$.payload.revisionOffset') AS last_offset,
            jsonb_extract(raw_jsonb, '$.payload.item') AS data
          FROM events AS item WHERE type = 'events.iterate.com/feed/item-published'
            AND NOT EXISTS (
              SELECT 1 FROM events AS newer
              WHERE newer.type = 'events.iterate.com/feed/item-published'
                AND json_extract(newer.raw_jsonb, '$.payload.item.id') = json_extract(item.raw_jsonb, '$.payload.item.id')
                AND (json_extract(newer.raw_jsonb, '$.payload.revisionOffset') > json_extract(item.raw_jsonb, '$.payload.revisionOffset')
                  OR (json_extract(newer.raw_jsonb, '$.payload.revisionOffset') = json_extract(item.raw_jsonb, '$.payload.revisionOffset')
                    AND newer.offset > item.offset))
            )
          UNION ALL
          SELECT offset AS local_index, 2147483647 AS ordinal,
            CASE type
              WHEN 'events.iterate.com/stream/created' THEN 'raw.stream.created'
              WHEN 'events.iterate.com/stream/woken' THEN 'raw.stream.woken'
              WHEN 'events.iterate.com/stream/child-stream-created' THEN 'raw.stream.child-stream-created'
              ELSE 'raw.event' END AS kind,
            offset AS first_offset, offset AS last_offset,
            raw_jsonb AS data
          FROM events`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS event_type_counts (
          type TEXT PRIMARY KEY, n INTEGER NOT NULL
        ) WITHOUT ROWID`,
      },
      {
        sql: `CREATE TRIGGER IF NOT EXISTS events_before_insert BEFORE INSERT ON events BEGIN
          SELECT CASE
            WHEN EXISTS (SELECT 1 FROM events WHERE offset = NEW.offset)
              THEN RAISE(ABORT, 'stream event replay changed an existing offset')
            WHEN NEW.offset <= COALESCE((SELECT MAX(offset) FROM events), 0)
              THEN RAISE(ABORT, 'stream event offsets must increase')
          END;
        END`,
      },
      {
        sql: `CREATE TRIGGER IF NOT EXISTS events_count_after_insert AFTER INSERT ON events BEGIN
          INSERT INTO event_type_counts(type, n) VALUES (NEW.type, 1)
            ON CONFLICT(type) DO UPDATE SET n = n + 1;
        END`,
      },
      { sql: `CREATE TABLE IF NOT EXISTS stream_sync_fence (reason TEXT NOT NULL)` },
      {
        sql: `CREATE TRIGGER IF NOT EXISTS stream_sync_fence_abort
          BEFORE INSERT ON stream_sync_fence BEGIN
            SELECT RAISE(ABORT, 'stream event sync commit fenced');
          END`,
      },
    ],
    { transaction: true },
  );

  const [previous] = await sql.exec(
    `SELECT stream_id, through_offset FROM stream_sync WHERE singleton = 1`,
  );
  const reset = previous
    ? previous.stream_id !== source.streamId ||
      Number(previous.through_offset) > source.streamMaxOffset
    : false;
  const owner = crypto.randomUUID();
  // The writer lock remains held until these transactions finish. A new owner
  // also fences delayed callbacks from a superseded connection within that tab.
  await sql.batch(
    [
      {
        sql: `DELETE FROM events WHERE NOT EXISTS (
          SELECT 1 FROM stream_sync WHERE stream_id = ? AND through_offset <= ?
        )`,
        params: [source.streamId, source.streamMaxOffset],
      },
      {
        sql: `DELETE FROM event_type_counts WHERE NOT EXISTS (
          SELECT 1 FROM stream_sync WHERE stream_id = ? AND through_offset <= ?
        )`,
        params: [source.streamId, source.streamMaxOffset],
      },
      {
        sql: `INSERT INTO stream_sync(singleton, stream_id, through_offset, owner)
          VALUES (1, ?, 0, ?) ON CONFLICT(singleton) DO UPDATE SET
            through_offset = CASE WHEN stream_id = excluded.stream_id AND through_offset <= ?
              THEN through_offset ELSE 0 END,
            stream_id = excluded.stream_id, owner = excluded.owner`,
        params: [source.streamId, owner, source.streamMaxOffset],
      },
    ],
    { transaction: true },
  );
  const [saved] = await sql.exec(`SELECT through_offset FROM stream_sync WHERE singleton = 1`);
  let throughOffset = Number(saved!.through_offset);

  return {
    reset,
    get throughOffset() {
      return throughOffset;
    },
    async ingest(batch: StreamEventBatch) {
      if (
        batch.streamId !== source.streamId ||
        !Number.isSafeInteger(batch.scannedAfterOffset) ||
        !Number.isSafeInteger(batch.scannedThroughOffset) ||
        batch.scannedAfterOffset < 0 ||
        batch.scannedAfterOffset > throughOffset ||
        batch.scannedThroughOffset < batch.scannedAfterOffset
      ) {
        throw new Error("invalid stream event sync boundary");
      }
      let previousOffset = batch.scannedAfterOffset;
      for (const event of batch.events) {
        if (
          !Number.isSafeInteger(event.offset) ||
          event.offset <= previousOffset ||
          event.offset > batch.scannedThroughOffset
        ) {
          throw new Error("stream event sync batch is outside its ordered scan boundary");
        }
        previousOffset = event.offset;
      }
      const nextOffset = Math.max(throughOffset, batch.scannedThroughOffset);
      await sql.batch(
        [
          {
            sql: `INSERT INTO stream_sync_fence(reason)
              SELECT 'owner or cursor changed' WHERE NOT EXISTS (
                SELECT 1 FROM stream_sync
                WHERE singleton = 1 AND stream_id = ? AND owner = ? AND through_offset = ?
              )`,
            params: [source.streamId, owner, throughOffset],
          },
          {
            // Filter identical replay BEFORE assigning dense local positions.
            // Conflicting offsets remain candidates and fail in the insert trigger.
            sql: `INSERT INTO events(local_index, raw_jsonb)
              SELECT COALESCE((SELECT MAX(local_index) FROM events), -1)
                + ROW_NUMBER() OVER (ORDER BY CAST(incoming.key AS INTEGER)),
                jsonb(incoming.value)
              FROM json_each(?) AS incoming
              WHERE NOT EXISTS (
                SELECT 1 FROM events WHERE offset = json_extract(incoming.value, '$.offset')
                  AND json(raw_jsonb) = json(incoming.value)
              )
              ORDER BY CAST(incoming.key AS INTEGER)`,
            params: [JSON.stringify(batch.events)],
          },
          {
            sql: `UPDATE stream_sync SET through_offset = ? WHERE singleton = 1`,
            params: [nextOffset],
          },
        ],
        { transaction: true },
      );
      throughOffset = nextOffset;
    },
  };
}
