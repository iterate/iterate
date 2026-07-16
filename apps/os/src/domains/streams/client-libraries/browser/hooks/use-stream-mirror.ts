import { useCallback, useMemo, useReducer, useSyncExternalStore } from "react";
import {
  acquireStreamRuntime,
  type StreamBrowserSnapshot,
  type StreamBrowserStore,
} from "../stream-browser-store.ts";
import type { BrowserStreamClientFactory } from "../stream-transport.ts";
import { CANONICAL_MIRROR_PROCESSORS } from "../canonical-mirror-processors.ts";

/**
 * Mount THE stream mirror for a `(projectId, streamPath)` and subscribe this
 * component to it. This is the one browser entry point for streaming a stream
 * into the local event cache: it acquires (or joins) the single per-stream
 * runtime, which downloads the stream once and fans every batch out to the
 * canonical processor set (event cache + feed projection) — see
 * canonical-mirror-processors.ts. Views read whichever tables they need off the
 * returned `store.streamDatabase` via `useStreamQuery`.
 *
 * Subscribing is what STARTS the download (the runtime refcounts listeners), so
 * an unmounted mirror never folds. `acquireStreamRuntime` dedupes by
 * `(projectId, streamPath)`, so three mounts across two pages all join the same
 * runtime and share one subscription.
 */
export function useStreamMirror(input: {
  createStreamClient: BrowserStreamClientFactory;
  /** See BrowserStreamConnectionConfig.resetTransport — evict a dead-but-never-closed transport. */
  resetTransport?: () => void;
  projectId: string;
  streamPath: string;
}): { store: StreamBrowserStore; snapshot: StreamBrowserSnapshot } {
  const { createStreamClient, resetTransport, projectId, streamPath } = input;
  // Self-heal for the acquire-to-subscribe gap: React can yield between the
  // render that acquired the runtime and the commit that subscribes (Suspense,
  // lazy chunks — longer than any idle grace), and a runtime disposed inside
  // that window is a corpse the memo would cache forever. Bumping this epoch
  // re-runs the acquire (the registry entry is gone by then, so it creates a
  // fresh runtime) and useSyncExternalStore resubscribes to it.
  const [reacquireEpoch, reacquire] = useReducer((epoch: number) => epoch + 1, 0);
  const store = useMemo(
    () =>
      acquireStreamRuntime({
        createStreamClient,
        ...(resetTransport === undefined ? {} : { resetTransport }),
        projectId,
        streamPath,
        processors: CANONICAL_MIRROR_PROCESSORS,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacquireEpoch drives the self-heal re-acquire.
    [createStreamClient, resetTransport, projectId, streamPath, reacquireEpoch],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      if (store.isDisposed()) {
        reacquire();
        return () => {};
      }
      return store.subscribe(listener);
    },
    [store],
  );
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
  return { store, snapshot };
}
