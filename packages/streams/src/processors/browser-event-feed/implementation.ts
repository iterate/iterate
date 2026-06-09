// Browser event-feed SQLite helpers.

import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";

/** The table this processor owns. */
export const BROWSER_EVENT_FEED_TABLE = "feed_items";

/** Bumped into the writer-lock name so a feed_items schema change lets a fresh tab take over. */
export const BROWSER_EVENT_FEED_SCHEMA_VERSION = 2;

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
