import { StreamProcessor } from "../../stream-processor.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import { deleteBrowserProcessorState } from "../../browser/processor-state-storage.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserRawEventsContract } from "./contract.ts";
export { BrowserRawEventsContract } from "./contract.ts";

export const BROWSER_RAW_EVENTS_SCHEMA_VERSION = 4;

export type BrowserRawEventsContract = typeof BrowserRawEventsContract;
export type BrowserRawEventsState = Record<string, never>;

export type BrowserRawEventsProcessorDeps = {
  sql: SqlClient;
};

export class BrowserRawEventsProcessor extends StreamProcessor<
  BrowserRawEventsContract,
  BrowserRawEventsProcessorDeps
> {
  readonly contract = BrowserRawEventsContract;

  // The schema ensurer also handles version resets (drop table + clear checkpoint),
  // so it must run before the first checkpoint read — otherwise a stale checkpoint
  // gets memoized and reported to the server as the replay cursor.
  override async snapshot() {
    await ensureBrowserRawEventsSchema(this.deps.sql);
    return await super.snapshot();
  }

  protected override async processBatch(
    args: Parameters<StreamProcessor<BrowserRawEventsContract>["processBatch"]>[0],
  ): Promise<void> {
    await ensureBrowserRawEventsSchema(this.deps.sql);
    await this.deps.sql.batch(
      args.events.map((event) => ({
        sql: `INSERT INTO events (local_index, raw_jsonb) VALUES (?, jsonb(?))`,
        params: [event.offset - 1, JSON.stringify(event)] satisfies SqlValue[],
      })),
      { transaction: true },
    );
    await super.processBatch(args);
  }
}

const ensureBrowserRawEventsSchema = createSchemaEnsurer({
  run: async (sql) => {
    const [schemaVersion] = await sql.exec(`PRAGMA user_version`);
    if (Number(schemaVersion?.user_version ?? 0) !== BROWSER_RAW_EVENTS_SCHEMA_VERSION) {
      // The resume checkpoint lives in processor_state, not in the events table,
      // so it must be cleared together with the table. A stale checkpoint over an
      // empty table would skip historical replay and then trip the continuity
      // trigger on the first new event. Deleted before the user_version write so
      // a crash in between re-runs this reset on the next load.
      await deleteBrowserProcessorState({ sql, processorSlug: BrowserRawEventsContract.slug });
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

export { ensureBrowserRawEventsSchema };
