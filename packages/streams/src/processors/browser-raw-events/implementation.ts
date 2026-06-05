// Implements the "browser-raw-events" processor.
// Owns the browser `events` table schema and writes each delivered batch of events
// in one SQLite transaction (afterAppendBatch + the batch write API).

import { implementProcessor } from "../../processor.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { browserRawEventsContract } from "./contract.ts";

export const BROWSER_RAW_EVENTS_SCHEMA_VERSION = 4;

const ensureBrowserRawEventsSchema = createSchemaEnsurer({
  run: async (sql) => {
    const [schemaVersion] = await sql.exec(`PRAGMA user_version`);
    if (Number(schemaVersion?.user_version ?? 0) !== BROWSER_RAW_EVENTS_SCHEMA_VERSION) {
      await sql.batch(
        [
          { sql: `DROP TRIGGER IF EXISTS events_before_insert` },
          { sql: `DROP TABLE IF EXISTS events` },
          { sql: `PRAGMA user_version = ${BROWSER_RAW_EVENTS_SCHEMA_VERSION}` },
        ],
        { transaction: true },
      );
    }

    await sql.batch(
      [
        {
          sql: `
            -- Browser-owned append log mirror. raw_jsonb is the source of truth:
            -- SQLite derives the queryable event fields from it, so future JSON-field
            -- indexes can use the same payload without duplicating text JSON.
            --
            -- local_index is deliberately separate from offset. Today it is offset - 1,
            -- because server offsets are one-based and TanStack Virtual indexes are
            -- zero-based. Keeping a separate local list position gives us room to age
            -- server events out later while still rendering a dense local list.
            CREATE TABLE IF NOT EXISTS events (
              local_index INTEGER PRIMARY KEY,
              raw_jsonb BLOB NOT NULL,
              offset INTEGER GENERATED ALWAYS AS (json_extract(raw_jsonb, '$.offset')) STORED NOT NULL UNIQUE,
              type TEXT GENERATED ALWAYS AS (json_extract(raw_jsonb, '$.type')) STORED NOT NULL,
              idempotency_key TEXT GENERATED ALWAYS AS (json_extract(raw_jsonb, '$.idempotencyKey')) STORED,
              created_at TEXT GENERATED ALWAYS AS (json_extract(raw_jsonb, '$.createdAt')) STORED NOT NULL,
              inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
              CHECK (local_index = offset - 1)
            )
          `,
        },
        {
          sql: `
            CREATE INDEX IF NOT EXISTS events_type_local_index ON events (type, local_index)
          `,
        },
        {
          sql: `
            -- Append invariant:
            -- 1. Identical replay is accepted and ignored, preserving inserted_at as
            --    "first stored locally".
            -- 2. Same offset with different JSON is a conflicting duplicate.
            -- 3. New rows must append continuously, so a missed offset fails loudly.
            CREATE TRIGGER IF NOT EXISTS events_before_insert
            BEFORE INSERT ON events
            BEGIN
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM events
                  WHERE offset = NEW.offset
                    AND json(raw_jsonb) = json(NEW.raw_jsonb)
                ) THEN RAISE(IGNORE)
                WHEN EXISTS (
                  SELECT 1
                  FROM events
                  WHERE offset = NEW.offset
                ) THEN RAISE(ABORT, 'stream browser mirror replay changed an existing offset')
                WHEN NEW.offset != COALESCE((SELECT MAX(offset) + 1 FROM events), 1)
                  THEN RAISE(ABORT, 'stream browser mirror offsets must append continuously')
              END;
            END
          `,
        },
      ],
      { transaction: true },
    );
  },
});

/** Resume cursor for this processor: the max committed offset in the events table. */
export async function loadBrowserRawEventsCheckpoint(
  sql: SqlClient,
): Promise<{ state: Record<string, never>; offset: number } | undefined> {
  await ensureBrowserRawEventsSchema(sql);
  const [row] = await sql.exec(`SELECT MAX(offset) AS max_offset FROM events`);
  const max = Number(row?.max_offset ?? -1);
  return max < 0 ? undefined : { state: {}, offset: max };
}

export const browserRawEvents = implementProcessor(
  browserRawEventsContract,
  (deps: { sql: SqlClient }) => ({
    afterAppendBatch({ events, blockProcessorUntil }) {
      blockProcessorUntil(() =>
        ensureBrowserRawEventsSchema(deps.sql).then(() =>
          deps.sql.batch(
            events.map(({ event }) => {
              return {
                sql: `INSERT INTO events (local_index, raw_jsonb) VALUES (?, jsonb(?))`,
                params: [event.offset - 1, JSON.stringify(event)] satisfies SqlValue[],
              };
            }),
            { transaction: true },
          ),
        ),
      );
    },
  }),
);

export { ensureBrowserRawEventsSchema };
