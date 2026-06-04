// Implements the "browser-event-feed" processor.
// Owns the browser `feed_items` table schema and writes one SQLite transaction per
// delivered batch via afterAppendBatch + the batch write API. blockProcessorUntil
// keeps the checkpoint behind the committed rows, exactly like browser-raw-events.

import { implementProcessor } from "../../processor.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { browserEventFeedContract } from "./contract.ts";
import {
  GROUP_COMPONENT,
  parseGroupFeedData,
  planFeedOps,
  type FeedOp,
  type FeedState,
} from "./grouping.ts";

/** The table this processor owns. */
export const BROWSER_EVENT_FEED_TABLE = "feed_items";

/** Bumped into the writer-lock name so a feed_items schema change lets a fresh tab take over. */
export const BROWSER_EVENT_FEED_SCHEMA_VERSION = 2;

/**
 * Reconstruct the processor's resume cursor + grouping state purely from `feed_items`.
 * The last row IS the open element: if it is a group, the next non-specific event extends
 * it; otherwise the next one starts a fresh group. `offset` is the max committed
 * `last_offset`, so the subscription resumes right after the rows already on disk.
 */
export async function loadBrowserEventFeedCheckpoint(
  sql: SqlClient,
): Promise<{ state: FeedState; offset: number } | undefined> {
  await ensureBrowserEventFeedSchema(sql);
  const [row] = await sql.exec(
    `SELECT local_index, component, first_offset, last_offset, event_count, data
     FROM feed_items ORDER BY local_index DESC LIMIT 1`,
  );
  if (row === undefined) return undefined;
  const localIndex = Number(row.local_index);
  const lastOffset = Number(row.last_offset);
  const groupData = row.component === GROUP_COMPONENT ? parseGroupFeedData(row.data) : undefined;
  const open =
    groupData === undefined
      ? null
      : {
          localIndex,
          firstOffset: Number(row.first_offset),
          lastOffset,
          eventCount: Number(row.event_count),
          eventType: groupData.eventType,
          events: groupData.events,
        };
  return { state: { open, nextLocalIndex: localIndex + 1 }, offset: lastOffset };
}

/** Highest committed stream offset reflected in feed_items, or -1 when empty. */
export async function browserEventFeedMaxOffset(sql: SqlClient): Promise<number> {
  await ensureBrowserEventFeedSchema(sql);
  const [row] = await sql.exec(`SELECT MAX(last_offset) AS max_offset FROM feed_items`);
  return Number(row?.max_offset ?? -1);
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

export const browserEventFeed = implementProcessor(
  browserEventFeedContract,
  (deps: { sql: SqlClient }) => ({
    afterAppendBatch({ events, previousState, blockProcessorUntil }) {
      const { ops } = planFeedOps(
        previousState,
        events.map(({ event }) => event),
      );
      if (ops.length === 0) return;
      blockProcessorUntil(() =>
        ensureBrowserEventFeedSchema(deps.sql).then(() =>
          deps.sql.batch(ops.map(feedOpToStatement), { transaction: true }),
        ),
      );
    },
  }),
);

function feedOpToStatement(op: FeedOp): { sql: string; params: SqlValue[] } {
  if (op.kind === "insert") {
    return {
      sql: `INSERT INTO feed_items (local_index, component, first_offset, last_offset, event_count, data)
            VALUES (?, ?, ?, ?, ?, jsonb(?))`,
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

export { ensureBrowserEventFeedSchema };
