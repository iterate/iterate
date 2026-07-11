import { StreamProcessor } from "../../../stream-processor.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import { deleteBrowserProcessorState } from "../../browser/processor-state-storage.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserRawEventsContract } from "./contract.ts";
export { BrowserRawEventsContract } from "./contract.ts";

export const BROWSER_RAW_EVENTS_SCHEMA_VERSION = 5;

/**
 * Tables this processor owns. Views pass this to the runtime so a mirror
 * discard clears the projection AND its derived counts together — clearing
 * `events` alone would leave stale totals behind (rows are append-only, so
 * the counts trigger has no delete arm to reconcile them).
 */
export const BROWSER_RAW_EVENTS_TABLES = ["events", "event_type_counts"];

export type BrowserRawEventsState = Record<string, never>;

/**
 * Mirrors raw stream events into the browser's `events` SQLite table, one
 * transaction per delivered batch. Stateless apart from the checkpoint: the
 * table itself is the projection.
 */
export class BrowserRawEventsProcessor extends StreamProcessor<
  BrowserRawEventsContract,
  { sql: SqlClient }
> {
  readonly contract = BrowserRawEventsContract;

  // The schema ensurer also handles version resets (drop table + clear checkpoint),
  // so it must run before the checkpoint is first read — otherwise a stale offset
  // gets memoized and reported to the server as the replay cursor, and the first
  // insert into the freshly-reset table trips the continuity trigger.
  protected override async prepare(): Promise<void> {
    await ensureBrowserRawEventsSchema(this.deps.sql);
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<BrowserRawEventsContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await this.deps.sql.batch(
      args.events.map((event) => ({
        sql: `INSERT INTO events (local_index, raw_jsonb) VALUES (?, jsonb(?))`,
        params: [event.offset - 1, JSON.stringify(event)] satisfies SqlValue[],
      })),
      { transaction: true },
    );
    await super.processEventBatch(args);
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
          { sql: `DROP TRIGGER IF EXISTS events_count_after_insert` },
          { sql: `DROP TABLE IF EXISTS events` },
          { sql: `DROP TABLE IF EXISTS event_type_counts` },
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
            -- Incrementally-maintained per-type row counts. The UI's reactive
            -- count queries (total, per-type, filter dropdown) re-run after
            -- every delivered batch; COUNT(*) over the events table rescans
            -- the whole mirror, and because reads and ingest writes share the
            -- one OPFS connection, those rescans throttle live-tail apply on
            -- deep mirrors (measured: 1M rows → ~12s tail lag at 5k events/s
            -- with the counts as full scans). Reading this table is O(#types).
            --
            -- Kept correct by events_count_after_insert below. There is no
            -- delete arm on purpose: mirror rows are append-only, and the only
            -- delete is the whole-mirror clear, which clears this table in the
            -- same discard (see BROWSER_RAW_EVENTS_TABLES).
            CREATE TABLE IF NOT EXISTS event_type_counts (
              type TEXT PRIMARY KEY,
              n INTEGER NOT NULL
            ) WITHOUT ROWID
          `,
        },
        {
          sql: `
            -- Fires only for rows that actually insert: a replayed duplicate is
            -- swallowed by events_before_insert's RAISE(IGNORE) first, so it
            -- never double-counts.
            CREATE TRIGGER IF NOT EXISTS events_count_after_insert
            AFTER INSERT ON events
            BEGIN
              INSERT INTO event_type_counts (type, n) VALUES (NEW.type, 1)
              ON CONFLICT (type) DO UPDATE SET n = n + 1;
            END
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
