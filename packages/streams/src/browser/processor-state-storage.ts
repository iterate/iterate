// Shared checkpoint table for browser-hosted stream processors: one row per
// (processor slug, subscription key) holding the JSON reduced state and the
// max processed offset. Keeping checkpoints here — separate from each
// processor's projection tables — gives every processor the same resume and
// reset story. Processors that own SQLite projection tables include
// `upsertProcessorStateStatement` in their projection transaction so the
// checkpoint can never lag the mirror; the base class's later `writeState`
// persists the same snapshot again, which is an idempotent upsert.

import type { StreamProcessorSnapshot, StreamProcessorStateStorage } from "../stream-processor.ts";
import { createSchemaEnsurer } from "./ensure-schema-once.ts";
import type { SqlClient, SqlValue } from "./stream-browser-db.ts";

const DEFAULT_SUBSCRIPTION_KEY = "";

export const ensureBrowserProcessorStateSchema = createSchemaEnsurer({
  run: (sql) =>
    sql.batch(
      [
        {
          sql: `
            CREATE TABLE IF NOT EXISTS processor_state (
              processor_slug TEXT NOT NULL,
              subscription_key TEXT NOT NULL DEFAULT '',
              reduced_state TEXT NOT NULL,
              max_offset INTEGER NOT NULL CHECK (max_offset >= 0),
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (processor_slug, subscription_key)
            )
          `,
        },
      ],
      { transaction: true },
    ),
});

/**
 * `readState`/`writeState` backed by the shared `processor_state` table, ready
 * to pass into a `StreamProcessor` constructor.
 */
export function browserProcessorStateStorage<State>(args: {
  sql: SqlClient;
  processorSlug: string;
  subscriptionKey?: string;
}): Required<StreamProcessorStateStorage<State>> {
  const subscriptionKey = args.subscriptionKey ?? DEFAULT_SUBSCRIPTION_KEY;

  return {
    readState: async () => {
      await ensureBrowserProcessorStateSchema(args.sql);
      const [row] = await args.sql.exec(
        `
          SELECT reduced_state, max_offset
          FROM processor_state
          WHERE processor_slug = ?
            AND subscription_key = ?
          LIMIT 1
        `,
        [args.processorSlug, subscriptionKey],
      );
      if (row === undefined) return undefined;
      if (typeof row.reduced_state !== "string") {
        throw new Error("processor_state.reduced_state must be JSON text");
      }
      return {
        state: JSON.parse(row.reduced_state) as State,
        offset: Number(row.max_offset),
      };
    },
    writeState: async (snapshot: StreamProcessorSnapshot<State>) => {
      await ensureBrowserProcessorStateSchema(args.sql);
      const statement = upsertProcessorStateStatement({
        processorSlug: args.processorSlug,
        subscriptionKey,
        snapshot,
      });
      await args.sql.exec(statement.sql, statement.params);
    },
  };
}

/**
 * The checkpoint upsert as a single statement, so processors that project into
 * SQLite can commit their projection writes and the checkpoint in one
 * transaction — ruling out the crash window where the mirror is ahead of the
 * stored cursor.
 */
export function upsertProcessorStateStatement(args: {
  processorSlug: string;
  subscriptionKey?: string;
  snapshot: StreamProcessorSnapshot<unknown>;
}): { sql: string; params: SqlValue[] } {
  return {
    sql: `
      INSERT INTO processor_state (
        processor_slug,
        subscription_key,
        reduced_state,
        max_offset,
        updated_at
      )
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(processor_slug, subscription_key) DO UPDATE SET
        reduced_state = excluded.reduced_state,
        max_offset = excluded.max_offset,
        updated_at = excluded.updated_at
    `,
    params: [
      args.processorSlug,
      args.subscriptionKey ?? DEFAULT_SUBSCRIPTION_KEY,
      JSON.stringify(args.snapshot.state),
      args.snapshot.offset,
    ],
  };
}

/** Deletes stored processor state; with no `subscriptionKey`, all rows for the slug. */
export async function deleteBrowserProcessorState(args: {
  sql: SqlClient;
  processorSlug: string;
  subscriptionKey?: string;
}): Promise<void> {
  await ensureBrowserProcessorStateSchema(args.sql);
  if (args.subscriptionKey === undefined) {
    await args.sql.exec(`DELETE FROM processor_state WHERE processor_slug = ?`, [
      args.processorSlug,
    ]);
    return;
  }
  await args.sql.exec(
    `
      DELETE FROM processor_state
      WHERE processor_slug = ?
        AND subscription_key = ?
    `,
    [args.processorSlug, args.subscriptionKey],
  );
}
