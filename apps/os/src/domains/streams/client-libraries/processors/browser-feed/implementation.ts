import { StreamProcessor } from "../../../stream-processor.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import {
  browserProcessorProgressRewindStatements,
  deleteBrowserProcessorState,
  ensureBrowserProcessorProgressSchema,
} from "../../browser/processor-state-storage.ts";
import { BrowserProjectionWriteBuffer } from "../../browser/projection-write-buffer.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserFeedContract } from "./contract.ts";
import {
  planBrowserFeedOps,
  RAW_GROUP_KIND,
  type BrowserFeedState,
  type FeedOp,
} from "./projector.ts";
export { BrowserFeedContract } from "./contract.ts";

/** The table this processor owns — the ONLY rendered-feed table in the mirror. */
export const BROWSER_FEED_TABLE = "feed_items";

/** Bumped into the writer-lock name (and mirror meta) so a schema/projection change rebuilds the mirror. */
export const BROWSER_FEED_SCHEMA_VERSION = 1;

/**
 * Folds stream events into the single `feed_items` projection for the browser
 * feed UI. The projection logic lives in the pure `planBrowserFeedOps` helper,
 * run one event at a time by BOTH hooks — `reduce` keeps its `endState`,
 * `processEvent` keeps its `ops` — so state and projection stay in lockstep by
 * construction. The ops are buffered into {@link projectionBuffer}; the
 * browser progress store (processor-state-storage.ts) flushes them and the
 * two-cursor progress record in ONE SQLite transaction per delivered frame.
 *
 * The open raw-group row grows with every folded event; its per-event ops are
 * COALESCED in the buffer to one upsert per commit carrying the row's final
 * data (matching the legacy batch override's one-statement-per-touched-row
 * serialization cost — without it a monotype catch-up would serialize the
 * group's cumulative events array once per event, O(n²) bytes on the exact
 * deep-replay path the mirror's flow control protects).
 */
export class BrowserFeedProcessor extends StreamProcessor<BrowserFeedContract, { sql: SqlClient }> {
  readonly contract = BrowserFeedContract;

  /** Shared with the progress store — see the class doc. One per instance. */
  readonly projectionBuffer = new BrowserProjectionWriteBuffer();

  /** Projection schema for the progress store's first-open (prepare() successor). */
  ensureProjectionSchema(sql: SqlClient): Promise<void> {
    return ensureBrowserFeedSchema(sql);
  }

  protected override reduce(
    args: Parameters<StreamProcessor<BrowserFeedContract>["reduce"]>[0],
  ): BrowserFeedState {
    return planBrowserFeedOps(args.state, [args.event]).endState;
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<BrowserFeedContract>["processEvent"]>[0],
  ): undefined {
    // Event-less at-head pass: this processor has no at-head reconcile, so nothing to do.
    if (args.event === null) return;
    const { ops } = planBrowserFeedOps(args.previousState, [args.event]);
    if (ops.length === 0) return;
    const open = args.state.open;
    this.projectionBuffer.append(
      args.event.offset,
      ops.map((op) => {
        if (open === null || op.localIndex !== open.localIndex) {
          // Settled rows (agent items, raw singletons, groups closed within
          // this event): one immutable statement each.
          return { build: () => feedOpToStatement(op) };
        }
        // The still-open raw group row. Always written as the UPSERT shape
        // with the row's FULL current values: a pending same-key write may be
        // the row's original insert (which a plain UPDATE must not replace —
        // the row would never be created), and against an already-committed
        // row the upsert's conflict arm is exactly the legacy UPDATE.
        const upsert: FeedOp =
          op.kind === "insert"
            ? op
            : {
                kind: "insert",
                localIndex: op.localIndex,
                itemKind: RAW_GROUP_KIND,
                firstOffset: open.firstOffset,
                lastOffset: op.lastOffset,
                eventCount: op.eventCount,
                data: op.data,
              };
        return {
          coalesceKey: `feed-item:${op.localIndex}`,
          build: () => feedOpToStatement(upsert),
        };
      }),
    );
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

export const ensureBrowserFeedSchema = createSchemaEnsurer({
  run: async (sql) => {
    // The rewind statements below reference processor_progress; make sure the
    // progress schema exists before the reset transaction can touch it.
    await ensureBrowserProcessorProgressSchema(sql);
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
    // events + feed_items plus the shared progress bookkeeping.
    const columns = await sql.exec(`SELECT name FROM pragma_table_info('feed_items')`);
    const isLegacyFeedItems =
      columns.length > 0 && !columns.some((column) => column.name === "kind");
    await sql.batch(
      [
        { sql: `DROP TABLE IF EXISTS agent_feed_items` },
        ...(isLegacyFeedItems
          ? [
              // Dropping the old-shaped table MUST rewind browser-feed's own
              // cursor in the SAME transaction: a rollback build recreates the
              // old shape without touching processor_progress, so a surviving
              // acknowledgement at N over the recreated-empty table would
              // resume delivery at N+1 and leave feed rows 1..N permanently
              // missing.
              ...browserProcessorProgressRewindStatements(BrowserFeedContract.slug),
              { sql: `DROP TABLE IF EXISTS feed_items` },
            ]
          : []),
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
