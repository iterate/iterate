// useStreamEvents: the React 19 face of the stream-tail multiplexer — the
// hook the canonical stream views are built on. History page + live tail,
// shared subscription per stream, client-side filtering by the caller.
//
//   const tail = useStreamEvents({ project: project.id, streamPath: "/itx" });
//   tail.events    // last ≤500 events, replay + live
//   tail.status    // "connecting" | "live" | "error"

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useItxClient } from "./context.ts";
import { acquireStreamTailStore } from "./stream-tail.ts";
import type { StreamTailSnapshot } from "./stream-tail.ts";

const SERVER_SNAPSHOT: StreamTailSnapshot = { events: [], status: "connecting" };
const getServerSnapshot = () => SERVER_SNAPSHOT;

export function useStreamEvents(options: {
  project: string;
  streamPath: string;
}): StreamTailSnapshot {
  const client = useItxClient();
  const store = useMemo(
    () => acquireStreamTailStore(client, options.project, options.streamPath),
    [client, options.project, options.streamPath],
  );

  // retain/release is the effect; the store survives StrictMode's
  // mount→unmount→mount because release lingers before tearing down.
  useEffect(() => store.retain(), [store]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
}
