import { StreamProcessor } from "iterate/processors";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import {
  browserProcessorProgressRewindStatements,
  ensureBrowserProcessorProgressSchema,
} from "../../browser/processor-state-storage.ts";
import { BrowserProjectionWriteBuffer } from "../../browser/projection-write-buffer.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserRawEventsContract } from "./contract.ts";
export { BrowserRawEventsContract } from "./contract.ts";

// v7 clears local event tables that may contain ephemeral events persisted by
// the previous browser projection. Ephemeral events now feed only the volatile
// UI overlay, so those old rows cannot remain visible after an upgrade.
export const BROWSER_RAW_EVENTS_SCHEMA_VERSION = 7;

/**
 * Tables this processor owns. Views pass this to the runtime so a database
 * discard clears the projection AND its derived counts together — clearing
 * `events` alone would leave stale totals behind (rows are append-only, so
 * the counts trigger has no delete arm to bring the totals back down).
 */
export const BROWSER_RAW_EVENTS_TABLES = ["events", "event_type_counts"];

export type BrowserRawEventsState = Record<string, never>;

/**
 * Stores raw stream events in the browser's `events` SQLite table.
 * Stateless apart from the resume cursor: the table itself is the projection.
 *
 * Driven by the StreamProcessorRunner: `processEvent` buffers one INSERT per
 * event into {@link projectionBuffer}, and the browser progress store
 * (processor-state-storage.ts) flushes the buffered inserts and the two-cursor
 * progress record in ONE SQLite transaction per delivered batch — the event
 * rows and the resume cursor can no longer disagree (the legacy path committed
 * them separately). Schema creation and version resets, which the retired
 * `prepare()` hook used to run, now land in {@link ensureProjectionSchema} —
 * the progress store runs it before the first checkpoint read, preserving the
 * reset-before-resume-cursor ordering (a stale offset memoized over a dropped
 * table would skip historical replay and leave a silent hole the gap-tolerant
 * trigger accepts).
 */
export class BrowserRawEventsProcessor extends StreamProcessor<
  BrowserRawEventsContract,
  { sql: SqlClient }
> {
  readonly contract = BrowserRawEventsContract;

  /** Shared with the progress store — see the class doc. One per instance. */
  readonly projectionBuffer = new BrowserProjectionWriteBuffer();

  /** Projection schema/reset for the progress store's first-open (prepare() successor). */
  ensureProjectionSchema(sql: SqlClient): Promise<void> {
    return ensureBrowserRawEventsSchema(sql);
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<BrowserRawEventsContract>["processEvent"]>[0],
  ): undefined {
    const event = args.event;
    // Event-less caught-up call: this projection has no caught-up work.
    if (!event) return;
    // Sparse offsets are expected: memory-only ephemeral events are
    // intentionally absent. The runner validates the enclosing scan envelope before this
    // hook runs, so accepting a gap here means "proved omitted", not "lost".
    this.projectionBuffer.append(event.offset, [
      {
        build: () => ({
          sql: `INSERT INTO events (local_index, raw_jsonb) VALUES (?, jsonb(?))`,
          params: [event.offset - 1, JSON.stringify(event)] satisfies SqlValue[],
        }),
      },
    ]);
  }
}

const ensureBrowserRawEventsSchema = createSchemaEnsurer({
  run: async (sql) => {
    // The rewind statements below UPDATE processor_progress; make sure the
    // progress schema exists before the reset transaction can reference it.
    await ensureBrowserProcessorProgressSchema(sql);
    const [schemaVersion] = await sql.exec(`PRAGMA user_version`);
    if (Number(schemaVersion?.user_version ?? 0) !== BROWSER_RAW_EVENTS_SCHEMA_VERSION) {
      // ONE transaction: the fenced cursor rewind (acknowledgement to 0 with a
      // cursorRevision bump, staling any in-flight commit from an old-schema
      // writer), the legacy checkpoint delete, the table drops, and the
      // user_version stamp. All-or-nothing — no crash window can separate the
      // dropped event tables from the rewound resume cursor (a stale checkpoint over
      // an empty table would skip historical replay and silently rebuild
      // without the skipped prefix; the gap-tolerant trigger accepts the hole).
      await sql.batch(
        [
          ...browserProcessorProgressRewindStatements(BrowserRawEventsContract.slug),
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
            -- Browser-owned copy of the append log. raw_jsonb is the source of truth:
            -- SQLite derives the queryable event fields from it, so future JSON-field
            -- indexes can use the same payload without duplicating text JSON.
            --
            -- local_index is deliberately separate from offset. Today it is offset - 1,
            -- because server offsets are one-based and TanStack Virtual indexes are
            -- zero-based. Neither column is guaranteed dense: ephemeral event
            -- bodies are never written to durable storage, while their offsets
            -- stay consumed, so replays can carry permanent gaps. The actual consumers (inspector panels' offset point
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
            -- Incrementally-maintained per-type row counts. The UI's reactive
            -- count queries (total, per-type, filter dropdown) re-run after
            -- every delivered batch; COUNT(*) over the events table rescans
            -- the whole events table, and because reads and ingest writes share the
            -- one OPFS connection, those rescans delay applying new events on
            -- deep local copies (measured: 1M rows → ~12s lag at 5k events/s
            -- with the counts as full scans). Reading this table is O(#types).
            --
            -- Kept correct by events_count_after_insert below. There is no
            -- delete arm on purpose: event rows are append-only, and the only
            -- delete is a full local-database clear, which clears this table in the
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
            -- 3. New rows must append in increasing offset order. Gaps are legal:
            --    memory-only ephemeral events consume offsets without entering
            --    durable replay, so strict continuity would wedge every later row.
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
                ) THEN RAISE(ABORT, 'browser event replay changed an existing stream offset')
                WHEN NEW.offset <= COALESCE((SELECT MAX(offset) FROM events), 0)
                  THEN RAISE(ABORT, 'browser event offsets must increase')
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
