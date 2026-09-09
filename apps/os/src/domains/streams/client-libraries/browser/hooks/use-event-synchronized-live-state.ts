import { useLayoutEffect, useRef } from "react";
import type { StreamBrowserDatabase } from "../stream-browser-db.ts";
import { useStreamQuery } from "./use-stream-query.ts";

/** Join a server snapshot to its durable publications; never fold events in the browser. */
export function useEventSynchronizedLiveState<State extends { publicationOffset: number }>(
  database: StreamBrowserDatabase,
  incoming: State | undefined,
): State | undefined {
  const cursor = useStreamQuery(database, `SELECT COALESCE(MAX(offset), 0) AS offset FROM events`);
  const committed = useRef<
    { database: StreamBrowserDatabase; value: State | undefined } | undefined
  >(undefined);
  const previous = committed.current?.database === database ? committed.current.value : undefined;
  const value =
    incoming && incoming.publicationOffset <= Number(cursor.data[0]?.offset ?? 0)
      ? incoming
      : previous;
  useLayoutEffect(() => {
    committed.current = { database, value };
  }, [database, value]);
  return value;
}
