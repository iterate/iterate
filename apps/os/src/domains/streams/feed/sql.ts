import type { ProjectionSqlValue } from "./projection-write-buffer.ts";

export type StreamFeedSqlValue = ProjectionSqlValue;

/** Minimal SQL surface shared by Durable Object SQLite and the retiring OPFS mirror. */
export type StreamFeedSqlClient = {
  exec(sql: string, params?: StreamFeedSqlValue[]): Promise<Record<string, StreamFeedSqlValue>[]>;
  batch(
    statements: { sql: string; params?: StreamFeedSqlValue[] }[],
    options?: { transaction?: boolean },
  ): Promise<void>;
};

/** Deduplicate schema opens per concrete SQL client. */
export function createStreamFeedSchemaEnsurer(args: {
  run: (sql: StreamFeedSqlClient) => Promise<void>;
}): (sql: StreamFeedSqlClient) => Promise<void> {
  const ready = new WeakSet<StreamFeedSqlClient>();
  const pending = new WeakMap<StreamFeedSqlClient, Promise<void>>();
  return async (sql) => {
    if (ready.has(sql)) return;
    const existing = pending.get(sql);
    if (existing !== undefined) return existing;
    const work = args
      .run(sql)
      .then(() => {
        ready.add(sql);
      })
      .finally(() => pending.delete(sql));
    pending.set(sql, work);
    await work;
  };
}
