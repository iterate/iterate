// Durable progress for browser-hosted stream processors, in the per-stream
// OPFS SQLite mirror.
//
// One table lives here: `processor_progress` — the two-cursor
// {@link ProcessorProgress} record the StreamProcessorRunner commits (one row
// per processor slug + subscription key). `browserProcessorProgressStore` is
// the runner's {@link ProcessorProgressStore} over it, and its `commit` folds
// the processor's buffered projection writes (projection-write-buffer.ts) and
// this record into ONE SQLite transaction — the mirror rows and the resume
// cursor move together or not at all. The commit is CAS-fenced by
// `cursorRevision` and monotonic-guarded exactly like the Durable Object
// store (durable-object-processor-durability.ts), but the fence is enforced
// INSIDE the transaction by SQL (fence statements that abort via trigger),
// because unlike DO KV the browser's SqlClient is asynchronous and cross-tab
// writers exist: a read-check-then-write in JS would leave a window a stale
// leader could slip a commit through. The row also carries `reduced_state`:
// the stream view's live agent tail reads it reactively per commit.
//
// Resets NEVER delete a live progress row — they REWIND it
// (`browserProcessorProgressRewindStatements`): acknowledgement to 0 and
// `cursor_revision + 1`, in the SAME transaction that clears/drops the
// projection tables. Deleting the row would reset the revision to 0, and a
// stale runner incarnation (an old-deploy tab sharing the OPFS file, a
// superseded election's trailing pull) could then commit its stale forward
// cursor over the rebuilt mirror; worse, its higher acknowledgement would
// fence the REBUILDING runner's commits as "backward". The revision bump
// points the fence at the stale writer instead.

import type { ProcessorProgress, ProcessorProgressStore } from "iterate/stream-processor-runner";
import { createSchemaEnsurer } from "./ensure-schema-once.ts";
import type { BrowserProjectionWriteBuffer } from "./projection-write-buffer.ts";
import type { SqlClient, SqlValue } from "./stream-browser-db.ts";

const DEFAULT_SUBSCRIPTION_KEY = "";

/**
 * Sentinel `reducer_version` written by rewinds and stored for unreadable
 * persisted state: never equal to a real contract version, so the runner's
 * load treats the fold cache as stale and rebuilds it REDUCE-ONLY through the
 * (preserved) acknowledgement — effects never re-run for a cache miss.
 */
const STALE_REDUCER_VERSION = "";

/**
 * Ensure the progress schema (two-cursor table + fence). Exported for browser
 * processor schema ensurers whose version RESET must include rewind
 * statements — the rewind's UPDATE needs `processor_progress` to exist before
 * the reset transaction runs.
 */
export const ensureBrowserProcessorProgressSchema = createSchemaEnsurer({
  run: (sql) =>
    sql.batch(
      [
        {
          sql: `
            CREATE TABLE IF NOT EXISTS processor_progress (
              processor_slug TEXT NOT NULL,
              subscription_key TEXT NOT NULL DEFAULT '',
              reducer_version TEXT NOT NULL,
              reduced_through_offset INTEGER NOT NULL CHECK (reduced_through_offset >= 0),
              reduced_state TEXT NOT NULL,
              acknowledged_through_offset INTEGER NOT NULL CHECK (acknowledged_through_offset >= 0),
              cursor_revision INTEGER NOT NULL CHECK (cursor_revision >= 0),
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (processor_slug, subscription_key),
              -- The persisted two-cursor invariant (stream-processor-runner.ts):
              -- a fold AHEAD of acknowledged effects must never be committed.
              CHECK (reduced_through_offset <= acknowledged_through_offset)
            )
          `,
        },
        {
          sql: `
            -- Write-only fence: commits insert a row here exactly when their
            -- fence predicate detects a violation, and the trigger below
            -- aborts the transaction — so the fence check and the fenced
            -- writes are atomic inside ONE transaction. No row ever lands.
            CREATE TABLE IF NOT EXISTS processor_progress_fence (
              reason TEXT NOT NULL
            )
          `,
        },
        {
          sql: `
            CREATE TRIGGER IF NOT EXISTS processor_progress_fence_abort
            BEFORE INSERT ON processor_progress_fence
            BEGIN
              SELECT CASE NEW.reason
                WHEN 'revision' THEN RAISE(ABORT, 'stream processor progress commit fenced: expectedCursorRevision does not match the persisted cursorRevision - a cursor rewind landed after this continuation began')
                ELSE RAISE(ABORT, 'stream processor progress commit fenced: acknowledgedThroughOffset would move backward without a cursorRevision bump - a stale incarnation is rolling the cursor back')
              END;
            END
          `,
        },
      ],
      { transaction: true },
    ),
});

/**
 * The two fence statements every progress commit runs FIRST, inside its
 * transaction — the browser-SQL enforcement of the exact Durable Object fence
 * (durable-object-processor-durability.ts):
 *
 *  1. CAS: the persisted `cursor_revision` (absent row reads as 0, matching
 *     `read`) must equal the runner's `expectedCursorRevision`, else a cursor
 *     rewind landed after this continuation began.
 *  2. MONOTONIC: a commit whose acknowledgement moves BACKWARD past the
 *     persisted one without a revision bump is a stale incarnation rolling
 *     the cursor back — re-running effects that were durably acknowledged.
 */
function progressFenceStatements(args: {
  processorSlug: string;
  subscriptionKey: string;
  expectedCursorRevision: number;
  acknowledgedThroughOffset: number;
  cursorRevision: number;
}): { sql: string; params: SqlValue[] }[] {
  return [
    {
      sql: `
        INSERT INTO processor_progress_fence (reason)
        SELECT 'revision'
        WHERE COALESCE(
          (SELECT cursor_revision FROM processor_progress
           WHERE processor_slug = ? AND subscription_key = ?),
          0
        ) <> ?
      `,
      params: [args.processorSlug, args.subscriptionKey, args.expectedCursorRevision],
    },
    {
      sql: `
        INSERT INTO processor_progress_fence (reason)
        SELECT 'backward-acknowledgement'
        WHERE EXISTS (
          SELECT 1 FROM processor_progress
          WHERE processor_slug = ? AND subscription_key = ?
            AND acknowledged_through_offset > ?
            AND cursor_revision >= ?
        )
      `,
      params: [
        args.processorSlug,
        args.subscriptionKey,
        args.acknowledgedThroughOffset,
        args.cursorRevision,
      ],
    },
  ];
}

/**
 * The fenced cursor REWIND, as statements for composition into a caller's
 * transaction (a projection reset must drop rows and rewind the cursor
 * atomically — a crash between the two is exactly the stale-checkpoint-over-
 * empty-mirror hole this file exists to prevent). Semantics: a full rewind —
 * acknowledgement to 0, `cursor_revision + 1` so every
 * in-flight continuation of the old cursor fails its commit's CAS fence, and
 * the fold cache marked stale (the runner's next load rebuilds reduce-only —
 * through offset 0 that is just the schema default, no journal reads).
 * Rewinds every subscription key for the slug: the projection tables are
 * shared per-slug.
 */
export function browserProcessorProgressRewindStatements(
  processorSlug: string,
): { sql: string; params: SqlValue[] }[] {
  return [
    {
      sql: `
        UPDATE processor_progress
        SET reducer_version = '${STALE_REDUCER_VERSION}',
            reduced_through_offset = 0,
            reduced_state = '{}',
            acknowledged_through_offset = 0,
            cursor_revision = cursor_revision + 1,
            updated_at = datetime('now')
        WHERE processor_slug = ?
      `,
      params: [processorSlug],
    },
  ];
}

/**
 * Reset a browser processor's projection: run the caller's projection reset
 * statements (DELETE FROM / DROP TABLE of the slug's tables) and the fenced
 * cursor rewind in ONE transaction. All-or-nothing by construction — no crash
 * window can separate the cleared mirror from the rewound cursor, so no path
 * drops committed projection rows without also resetting the cursor that
 * would otherwise skip their rebuild.
 */
export async function resetBrowserProcessorProjection(args: {
  sql: SqlClient;
  processorSlug: string;
  projectionResetStatements: { sql: string; params?: SqlValue[] }[];
}): Promise<void> {
  await ensureBrowserProcessorProgressSchema(args.sql);
  await args.sql.batch(
    [
      ...args.projectionResetStatements,
      ...browserProcessorProgressRewindStatements(args.processorSlug),
    ],
    { transaction: true },
  );
}

/**
 * Discard a browser processor's projection with a STABLE owned-table set:
 * ensure every table the processor owns exists (its own projection schema
 * ensurer — cheap, memoized per client), then DELETE FROM all of them plus
 * the fenced cursor rewind in ONE transaction via
 * {@link resetBrowserProcessorProjection}.
 *
 * The ensure-first step is load-bearing, not cosmetic: deriving the delete
 * set from per-table `sqlite_master` probes instead is NON-ATOMIC — a
 * follower's clear (no writer lock) can interleave with a writer tab creating
 * the tables, probe `events` before it exists and `event_type_counts` after,
 * and delete only the counts. Replay from the rewound cursor then re-inserts
 * the surviving `events` rows into the identical-replay RAISE(IGNORE) arm, so
 * the after-insert count trigger never fires for them — `event_type_counts`
 * stays permanently undercounted. With every owned table guaranteed to exist
 * up front, the delete set is complete no matter what a concurrent writer
 * creates in between.
 */
export async function discardBrowserProcessorProjection(args: {
  sql: SqlClient;
  processorSlug: string;
  tables: readonly string[];
  ensureProjectionSchema: (sql: SqlClient) => Promise<void>;
}): Promise<void> {
  await args.ensureProjectionSchema(args.sql);
  await resetBrowserProcessorProjection({
    sql: args.sql,
    processorSlug: args.processorSlug,
    projectionResetStatements: args.tables.map((table) => ({ sql: `DELETE FROM ${table}` })),
  });
}

/**
 * The browser {@link ProcessorProgressStore}: the runner's durable progress
 * over the shared mirror SQLite, with the transactional projection committer.
 *
 * `read` runs the schema work first — the progress schema, then the
 * processor's own `ensureProjectionSchema`: projection version resets must
 * land BEFORE the first checkpoint read, or a stale cursor gets memoized as
 * the replay watermark and the mirror silently rebuilds without the skipped
 * prefix. A missing row is genuinely fresh (undefined). Every read also
 * re-hydrates the shared projection buffer's covered offset.
 *
 * `commit` executes, in ONE transaction: the two fence statements, the
 * buffer's drained projection writes, and the progress upsert (whose
 * `reduced_state` the stream view reads reactively). A mid-transaction
 * failure — fence, projection trigger, OPFS error — rolls back ALL of it; the
 * runner never advances past a failed commit, so the redelivered frame
 * regenerates the drained writes.
 */
export function browserProcessorProgressStore<State = unknown>(args: {
  sql: SqlClient;
  processorSlug: string;
  subscriptionKey?: string;
  /** The processor's projection schema/reset. */
  ensureProjectionSchema?: (sql: SqlClient) => Promise<void>;
  /** The shared projection-write buffer this store drains at commit. */
  projection?: BrowserProjectionWriteBuffer;
}): ProcessorProgressStore<State> {
  const { sql, processorSlug, ensureProjectionSchema, projection } = args;
  const subscriptionKey = args.subscriptionKey ?? DEFAULT_SUBSCRIPTION_KEY;

  const ensureSchemas = async () => {
    // Progress schema FIRST: a projection ensurer's version reset composes the
    // rewind statements above, which reference processor_progress.
    await ensureBrowserProcessorProgressSchema(sql);
    await ensureProjectionSchema?.(sql);
  };

  const parsePersistedState = (
    raw: SqlValue | undefined,
  ): { state: State; readable: true } | { state: Record<string, never>; readable: false } => {
    if (typeof raw === "string") {
      try {
        return { state: JSON.parse(raw) as State, readable: true };
      } catch {
        // fall through — unreadable text degrades to a stale fold cache below.
      }
    }
    return { state: {}, readable: false };
  };

  return {
    read: async (): Promise<ProcessorProgress<State> | undefined> => {
      await ensureSchemas();
      const [row] = await sql.exec(
        `
          SELECT reducer_version, reduced_through_offset, reduced_state,
                 acknowledged_through_offset, cursor_revision
          FROM processor_progress
          WHERE processor_slug = ? AND subscription_key = ?
          LIMIT 1
        `,
        [processorSlug, subscriptionKey],
      );
      if (row === undefined) {
        projection?.hydrate(0);
        return undefined;
      }
      const acknowledgedThroughOffset = Number(row.acknowledged_through_offset);
      projection?.hydrate(acknowledgedThroughOffset);
      const parsed = parsePersistedState(row.reduced_state);
      return {
        reduction: parsed.readable
          ? {
              reducerVersion: String(row.reducer_version),
              reducedThroughOffset: Number(row.reduced_through_offset),
              state: parsed.state,
            }
          : // Unreadable fold cache: mark it stale (never a real version) so
            // the runner refolds reduce-only through the acknowledgement.
            {
              reducerVersion: STALE_REDUCER_VERSION,
              reducedThroughOffset: 0,
              state: parsed.state as State,
            },
        processing: {
          acknowledgedThroughOffset,
          cursorRevision: Number(row.cursor_revision),
        },
      };
    },

    commit: async (progress, opts): Promise<void> => {
      await ensureSchemas();
      const acknowledgedThroughOffset = progress.processing.acknowledgedThroughOffset;
      const stateJson = JSON.stringify(progress.reduction.state);
      // Drain BEFORE building the batch: if the transaction fails, the
      // drained writes are lost on purpose — the cursor did not advance, so
      // the redelivered frame re-derives them from the committed state.
      const projectionStatements = projection?.drainThrough(acknowledgedThroughOffset) ?? [];
      await sql.batch(
        [
          ...progressFenceStatements({
            processorSlug,
            subscriptionKey,
            expectedCursorRevision: opts.expectedCursorRevision,
            acknowledgedThroughOffset,
            cursorRevision: progress.processing.cursorRevision,
          }),
          ...projectionStatements,
          {
            sql: `
              INSERT INTO processor_progress (
                processor_slug, subscription_key, reducer_version, reduced_through_offset,
                reduced_state, acknowledged_through_offset, cursor_revision, updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(processor_slug, subscription_key) DO UPDATE SET
                reducer_version = excluded.reducer_version,
                reduced_through_offset = excluded.reduced_through_offset,
                reduced_state = excluded.reduced_state,
                acknowledged_through_offset = excluded.acknowledged_through_offset,
                cursor_revision = excluded.cursor_revision,
                updated_at = excluded.updated_at
            `,
            params: [
              processorSlug,
              subscriptionKey,
              progress.reduction.reducerVersion,
              progress.reduction.reducedThroughOffset,
              stateJson,
              acknowledgedThroughOffset,
              progress.processing.cursorRevision,
            ],
          },
        ],
        { transaction: true },
      );
    },
  };
}

/**
 * Deletes stored processor progress rows; with no `subscriptionKey`, all rows
 * for the slug. For RETIRED processor slugs (browser-feed's schema ensurer
 * clears the old agent-ui rows). A LIVE processor's reset must use
 * {@link resetBrowserProcessorProjection} instead: deleting a live progress
 * row resets its cursorRevision to 0, disarming the fence against stale
 * writers (see the module doc).
 */
export async function deleteBrowserProcessorState(args: {
  sql: SqlClient;
  processorSlug: string;
  subscriptionKey?: string;
}): Promise<void> {
  await ensureBrowserProcessorProgressSchema(args.sql);
  const scope =
    args.subscriptionKey === undefined
      ? { where: `processor_slug = ?`, params: [args.processorSlug] }
      : {
          where: `processor_slug = ? AND subscription_key = ?`,
          params: [args.processorSlug, args.subscriptionKey],
        };
  await args.sql.exec(`DELETE FROM processor_progress WHERE ${scope.where}`, scope.params);
}
