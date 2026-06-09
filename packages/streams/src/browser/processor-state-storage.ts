import type { StreamProcessorSnapshot, StreamProcessorStateStorage } from "../stream-processor.ts";
import { createSchemaEnsurer } from "./ensure-schema-once.ts";
import type { SqlClient } from "./stream-browser-db.ts";

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
      await args.sql.exec(
        `
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
        [args.processorSlug, subscriptionKey, JSON.stringify(snapshot.state), snapshot.offset],
      );
    },
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
