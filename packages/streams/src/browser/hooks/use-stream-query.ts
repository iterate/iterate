import { useMemo, useSyncExternalStore } from "react";
import type { SqliteQuerySnapshot, SqlValue, StreamBrowserDatabase } from "../stream-browser-db.ts";

export function useStreamQuery(
  db: StreamBrowserDatabase,
  sql: string,
  params: SqlValue[] = [],
): SqliteQuerySnapshot<Record<string, SqlValue>> {
  const paramsKey = JSON.stringify(params);
  const handle = useMemo(() => db.query(sql, params), [db, paramsKey, sql]);
  return useSyncExternalStore(handle.subscribe, handle.getSnapshot);
}
