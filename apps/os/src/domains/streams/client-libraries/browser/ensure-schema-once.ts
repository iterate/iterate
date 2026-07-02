// Dedupes concurrent schema migrations per SqlClient. Used by browser processor
// implementations that own OPFS SQLite tables (browser-raw-events, browser-event-feed).

import type { SqlClient } from "./stream-browser-db.ts";

export function createSchemaEnsurer(args: {
  run: (sql: SqlClient) => Promise<void>;
}): (sql: SqlClient) => Promise<void> {
  const schemaReady = new WeakSet<SqlClient>();
  const schemaPromises = new WeakMap<SqlClient, Promise<void>>();

  return async (sql: SqlClient) => {
    if (schemaReady.has(sql)) return;
    const existing = schemaPromises.get(sql);
    if (existing !== undefined) return existing;

    const schemaPromise = args
      .run(sql)
      .then(() => {
        schemaReady.add(sql);
      })
      .finally(() => {
        schemaPromises.delete(sql);
      });

    schemaPromises.set(sql, schemaPromise);
    return schemaPromise;
  };
}
