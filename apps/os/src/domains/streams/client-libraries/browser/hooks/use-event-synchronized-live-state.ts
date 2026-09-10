import { useState } from "react";
import type { StreamBrowserDatabase } from "../stream-browser-db.ts";
import { useStreamQuery } from "./use-stream-query.ts";

/** Join a server snapshot to its durable publications; never fold events in the browser. */
export function useEventSynchronizedLiveState<
  State extends {
    publicationOffset: number;
    streamId: string | null;
  },
>(database: StreamBrowserDatabase, incoming: State | undefined): State | undefined {
  const synchronization = useStreamQuery(
    database,
    `SELECT stream_id, through_offset FROM stream_sync WHERE singleton = 1`,
  );
  const source = synchronization.data[0];
  const [presented, setPresented] = useState<{
    database: StreamBrowserDatabase;
    value: State | undefined;
  }>({ database, value: undefined });
  const sourceStreamId = typeof source?.stream_id === "string" ? source.stream_id : undefined;
  const previous =
    presented.database === database && presented.value?.streamId === sourceStreamId
      ? presented.value
      : undefined;
  const value =
    incoming &&
    incoming.streamId !== null &&
    incoming.streamId === sourceStreamId &&
    incoming.publicationOffset <= Number(source?.through_offset ?? 0)
      ? incoming
      : previous;
  if (presented.database !== database || presented.value !== value) {
    setPresented({ database, value });
  }
  return value;
}
