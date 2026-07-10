import { StreamProcessor } from "../../../stream-processor.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import { deleteBrowserProcessorState } from "../../browser/processor-state-storage.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserFeedContract } from "./contract.ts";
import { planBrowserFeedOps, type BrowserFeedState, type FeedOp } from "./projector.ts";
export { BrowserFeedContract } from "./contract.ts";

/** The table this processor owns — the ONLY rendered-feed table in the mirror. */
export const BROWSER_FEED_TABLE = "feed_items";

/** Bumped into the writer-lock name (and mirror meta) so a schema/projection change rebuilds the mirror. */
export const BROWSER_FEED_SCHEMA_VERSION = 1;

export type { BrowserFeedState };

/**
 * Folds stream events into the single `feed_items` projection for the browser
 * feed UI. The projection logic lives in the pure `planBrowserFeedOps` helper:
 * `reduce` runs it one event at a time to advance state, and
 * `processEventBatch` runs it over the whole batch (from the same batch-entry
 * state) to produce one SQLite transaction — keeping the two in lockstep by
 * construction.
 */
export class BrowserFeedProcessor extends StreamProcessor<BrowserFeedContract, { sql: SqlClient }> {
  readonly contract = BrowserFeedContract;

  protected override async prepare(): Promise<void> {
    await ensureBrowserFeedSchema(this.deps.sql);
  }

  protected override reduce(
    args: Parameters<StreamProcessor<BrowserFeedContract>["reduce"]>[0],
  ): BrowserFeedState {
    return planBrowserFeedOps(args.state, [args.event]).endState;
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<BrowserFeedContract>["processEventBatch"]>[0],
  ): Promise<void> {
    const { ops } = planBrowserFeedOps(args.previousState, args.events);

    if (ops.length > 0) {
      await this.deps.sql.batch(ops.map(feedOpToStatement), { transaction: true });
    }

    await super.processEventBatch(args);
  }
}

function feedOpToStatement(op: FeedOp): { sql: string; params: SqlValue[] } {
  if (op.kind === "insert") {
    return {
      sql: `INSERT INTO feed_items (local_index, kind, first_offset, last_offset, event_count, data)
            VALUES (?, ?, ?, ?, ?, jsonb(?))
            ON CONFLICT(local_index) DO UPDATE SET
              kind = excluded.kind,
              first_offset = excluded.first_offset,
              last_offset = excluded.last_offset,
              event_count = excluded.event_count,
              data = excluded.data`,
      params: [
        op.localIndex,
        op.itemKind,
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

const ensureBrowserFeedSchema = createSchemaEnsurer({
  run: async (sql) => {
    // No PRAGMA user_version here: feed_items shares the per-stream OPFS
    // database with the raw-events `events` table, which owns user_version.
    // Version resets ride the store's resetOnSchemaVersionChange lane
    // (mirror meta keyed by slug) instead.
    //
    // Pre-unification cleanup: mirrors built before browser-feed carry the
    // retired agent-ui processor's agent_feed_items table and a feed_items
    // with a `component` column. Both are disposable projections — drop them
    // (the old-shape feed_items is detected by its missing `kind` column) and
    // clear the retired processors' checkpoints so the mirror is exactly
    // events + feed_items plus the shared processor_state bookkeeping.
    const columns = await sql.exec(`SELECT name FROM pragma_table_info('feed_items')`);
    const isLegacyFeedItems =
      columns.length > 0 && !columns.some((column) => column.name === "kind");
    await sql.batch(
      [
        { sql: `DROP TABLE IF EXISTS agent_feed_items` },
        ...(isLegacyFeedItems ? [{ sql: `DROP TABLE IF EXISTS feed_items` }] : []),
        {
          sql: `
            -- One row per rendered Feed Item, pretty and raw interleaved in ONE
            -- total order: local_index is allocated by the browser-feed
            -- projector as items settle. kind is 'agent.<item kind>' for pretty
            -- chat rows (data = the AgentUiItem) or 'raw.group' /
            -- 'raw.<component>' for raw rows (data = the grouped events).
            CREATE TABLE IF NOT EXISTS feed_items (
              local_index INTEGER PRIMARY KEY,
              kind TEXT NOT NULL,
              first_offset INTEGER NOT NULL,
              last_offset INTEGER NOT NULL,
              event_count INTEGER NOT NULL DEFAULT 1,
              data BLOB NOT NULL
            )
          `,
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS feed_items_offsets_idx ON feed_items (first_offset, last_offset)`,
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS feed_items_kind_idx ON feed_items (kind, local_index)`,
        },
      ],
      { transaction: true },
    );
    await deleteBrowserProcessorState({ sql, processorSlug: "agent-ui" });
    await deleteBrowserProcessorState({ sql, processorSlug: "browser-event-feed" });
  },
});
