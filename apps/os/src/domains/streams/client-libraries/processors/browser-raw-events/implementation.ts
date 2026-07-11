import { StreamProcessor } from "../../../stream-processor.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import { deleteBrowserProcessorState } from "../../browser/processor-state-storage.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserRawEventsContract } from "./contract.ts";
export { BrowserRawEventsContract } from "./contract.ts";

export const BROWSER_RAW_EVENTS_SCHEMA_VERSION = 5;

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
  // gets memoized and reported to the server as the replay cursor, and the mirror
  // silently rebuilds without the skipped prefix (the gap-tolerant trigger
  // accepts the hole; nothing ever refetches it).
  protected override async prepare(): Promise<void> {
    await ensureBrowserRawEventsSchema(this.deps.sql);
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<BrowserRawEventsContract>["processEventBatch"]>[0],
  ): Promise<void> {
    // Gaps are legal only once server-side ephemeral eviction exists; until
    // then every delivered batch is dense, so an observed gap is a real lost
    // delivery the relaxed trigger would otherwise swallow silently. Log it.
    const [head] = await this.deps.sql.exec(`SELECT MAX(offset) AS max_offset FROM events`);
    const localHead = Number(head?.max_offset ?? 0);
    const firstOffset = args.events[0]?.offset;
    if (firstOffset !== undefined && localHead > 0 && firstOffset > localHead + 1) {
      console.error(
        `[browser-raw-events] offset gap in mirror: local head ${localHead}, batch starts at ${firstOffset} — lost delivery or server-side eviction`,
      );
    }
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
      // empty table would skip historical replay and silently rebuild the mirror
      // without the skipped prefix (the gap-tolerant trigger accepts the hole).
      // Deleted before the user_version write so a crash in between re-runs this
      // reset on the next load.
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
            -- zero-based. Neither column is guaranteed dense: the server may evict
            -- ephemeral rows (their offsets stay consumed), so replays can carry
            -- permanent gaps. The actual consumers (inspector panels' offset point
            -- reads and ORDER BY offset walks) are gap-proof.
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
            -- 3. New rows must append in increasing offset order. Gaps are legal:
            --    the server may evict ephemeral rows (offsets stay consumed), so a
            --    strict-continuity check would wedge every replay of a stream whose
            --    chunks were swept.
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
                WHEN NEW.offset <= COALESCE((SELECT MAX(offset) FROM events), 0)
                  THEN RAISE(ABORT, 'stream browser mirror offsets must increase')
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
