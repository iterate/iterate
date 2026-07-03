import { useSyncExternalStore } from "react";
import type { SqliteQuerySnapshot, SqlValue, StreamBrowserDatabase } from "../stream-browser-db.ts";

export function useStreamQuery(
  db: StreamBrowserDatabase,
  sql: string,
  params: SqlValue[] = [],
): SqliteQuerySnapshot<Record<string, SqlValue>> {
  // db.query dedupes by (sql, params) value, so identical calls across renders
  // return the same handle — subscribe/getSnapshot identities stay stable and
  // useSyncExternalStore does not resubscribe. A handle created by a render
  // that never commits is reclaimed by the registry's creation-time GC.
  const handle = db.query(sql, params);
  return useSyncExternalStore(handle.subscribe, handle.getSnapshot);
}
