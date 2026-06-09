import { StreamProcessor, type ProcessEventsArgs } from "../../stream-processor-v2.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { browserEventFeedContract } from "./contract.ts";
import { ensureBrowserEventFeedSchema } from "./implementation.ts";
import { planFeedOps, type FeedOp, type FeedState } from "./grouping.ts";

export const BrowserEventFeedContract = browserEventFeedContract;
export type BrowserEventFeedContract = typeof BrowserEventFeedContract;
export type BrowserEventFeedState = FeedState;

export type BrowserEventFeedProcessorDeps = {
  sql: SqlClient;
};

export class BrowserEventFeedProcessor extends StreamProcessor<
  BrowserEventFeedContract,
  BrowserEventFeedProcessorDeps
> {
  readonly contract = BrowserEventFeedContract;

  protected override processEvents(args: ProcessEventsArgs<BrowserEventFeedContract>): void {
    const { ops } = planFeedOps(
      args.previousState as FeedState,
      args.events.map(({ event }) => event),
    );
    if (ops.length === 0) return;

    args.blockProcessorWhile(() =>
      ensureBrowserEventFeedSchema(this.deps.sql).then(() =>
        this.deps.sql.batch(ops.map(feedOpToStatement), { transaction: true }),
      ),
    );
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
