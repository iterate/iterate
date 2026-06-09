import { StreamProcessor } from "../../stream-processor.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import {
  ensureBrowserProcessorStateSchema,
  upsertProcessorStateStatement,
} from "../../browser/processor-state-storage.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserEventFeedContract } from "./contract.ts";
import { planFeedOps, type FeedOp, type FeedState } from "./grouping.ts";
export { BrowserEventFeedContract } from "./contract.ts";

/** The table this processor owns. */
export const BROWSER_EVENT_FEED_TABLE = "feed_items";

/** Bumped into the writer-lock name so a feed_items schema change lets a fresh tab take over. */
export const BROWSER_EVENT_FEED_SCHEMA_VERSION = 2;

export type BrowserEventFeedContract = typeof BrowserEventFeedContract;
export type BrowserEventFeedState = FeedState;

export type BrowserEventFeedProcessorDeps = {
  sql: SqlClient;
  /** Must match the key the host's checkpoint storage was created with. */
  subscriptionKey?: string;
};

/**
 * Folds stream events into grouped `feed_items` rows for the browser feed UI.
 * The grouping logic lives in the pure `planFeedOps` helper: `reduce` runs it
 * one event at a time to advance state, and `processEventBatch` runs it over
 * the whole batch (from the same batch-entry state) to produce one SQLite
 * transaction — keeping the two in lockstep by construction.
 */
export class BrowserEventFeedProcessor extends StreamProcessor<
  BrowserEventFeedContract,
  BrowserEventFeedProcessorDeps
> {
  readonly contract = BrowserEventFeedContract;

  protected override async prepare(): Promise<void> {
    await ensureBrowserProcessorStateSchema(this.deps.sql);
    await ensureBrowserEventFeedSchema(this.deps.sql);
  }

  protected override reduce(
    args: Parameters<StreamProcessor<BrowserEventFeedContract>["reduce"]>[0],
  ): FeedState {
    return planFeedOps(args.state, [args.event]).endState;
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<BrowserEventFeedContract>["processEventBatch"]>[0],
  ): Promise<void> {
    const { ops } = planFeedOps(args.previousState, args.events);

    // The checkpoint upsert rides in the same transaction as the feed writes,
    // so the stored cursor can never lag feed_items. The base class's later
    // writeState persists the same snapshot again (idempotent upsert).
    await this.deps.sql.batch(
      [
        ...ops.map(feedOpToStatement),
        upsertProcessorStateStatement({
          processorSlug: this.contract.slug,
          subscriptionKey: this.deps.subscriptionKey,
          snapshot: { offset: args.checkpointOffset, state: args.state },
        }),
      ],
      { transaction: true },
    );

    await super.processEventBatch(args);
  }
}

function feedOpToStatement(op: FeedOp): { sql: string; params: SqlValue[] } {
  if (op.kind === "insert") {
    return {
      sql: `INSERT INTO feed_items (local_index, component, first_offset, last_offset, event_count, data)
            VALUES (?, ?, ?, ?, ?, jsonb(?))
            ON CONFLICT(local_index) DO UPDATE SET
              component = excluded.component,
              first_offset = excluded.first_offset,
              last_offset = excluded.last_offset,
              event_count = excluded.event_count,
              data = excluded.data`,
      params: [
        op.localIndex,
        op.component,
        op.firstOffset,
        op.lastOffset,
        op.eventCount,
        JSON.stringify(op.data),
      ],
    };
  }
  return {
    sql: `UPDATE feed_items SET last_offset = ?, event_count = ?, data = jsonb(?) WHERE local_index = ?`,
    params: [op.lastOffset, op.eventCount, JSON.stringify(op.data), op.localIndex],
  };
}

const ensureBrowserEventFeedSchema = createSchemaEnsurer({
  run: async (sql) => {
    // No PRAGMA user_version here: feed_items shares the per-stream OPFS database with the
    // raw-events `events` table, which owns user_version. CREATE TABLE IF NOT EXISTS is the
    // idempotent migration for now; a multi-table version scheme can come later.
    await sql.batch(
      [
        {
          sql: `
            -- One row per rendered Feed Item: a specific-renderer singleton, or a
            -- collapsed run of consecutive non-specific events ("group"). local_index is
            -- the dense, zero-based list position TanStack Virtual indexes.
            CREATE TABLE IF NOT EXISTS feed_items (
              local_index INTEGER PRIMARY KEY,
              component TEXT NOT NULL,
              first_offset INTEGER NOT NULL,
              last_offset INTEGER NOT NULL,
              event_count INTEGER NOT NULL,
              data BLOB NOT NULL
            )
          `,
        },
      ],
      { transaction: true },
    );
  },
});

export { ensureBrowserEventFeedSchema };
