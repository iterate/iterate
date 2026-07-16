import { StreamProcessor } from "../../../stream-processor.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import {
  browserProcessorProgressRewindStatements,
  ensureBrowserProcessorProgressSchema,
} from "../../browser/processor-state-storage.ts";
import { BrowserProjectionWriteBuffer } from "../../browser/projection-write-buffer.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserRawEventsContract } from "./contract.ts";
export { BrowserRawEventsContract } from "./contract.ts";

// v7 clears mirrors that may contain replayed historical ephemeral rows. The
// durable-only replay contract cannot leave those old rows visible after the
// live-only ephemeral cutover.
export const BROWSER_RAW_EVENTS_SCHEMA_VERSION = 7;

/**
 * Tables this processor owns. Views pass this to the runtime so a mirror
 * discard clears the projection AND its derived counts together — clearing
 * `events` alone would leave stale totals behind (rows are append-only, so
 * the counts trigger has no delete arm to reconcile them).
 */
export const BROWSER_RAW_EVENTS_TABLES = ["events", "event_type_counts"];

export type BrowserRawEventsState = Record<string, never>;

/**
 * Mirrors raw stream events into the browser's `events` SQLite table.
 * Stateless apart from the resume cursor: the table itself is the projection.
 *
 * Driven by the StreamProcessorRunner: `processEvent` buffers one INSERT per
 * event into {@link projectionBuffer}, and the browser progress store
 * (processor-state-storage.ts) flushes the buffered inserts and the two-cursor
 * progress record in ONE SQLite transaction per delivered frame — the mirror
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
    // Sparse offsets are expected: historical ephemerals are intentionally
    // absent. The runner validates the enclosing scan envelope before this
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
      // dropped mirror from the rewound resume cursor (a stale checkpoint over
      // an empty mirror would skip historical replay and silently rebuild
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
