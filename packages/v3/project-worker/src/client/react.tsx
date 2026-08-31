// client/react.tsx — the REACT binding for clean-room live state. `useLiveState` subscribes a
// component to a producer's live state (a processor slug, a mini-app key), seeds through its door,
// and re-renders on every synced delta via `useSyncExternalStore` over the LiveStateStore. It is the
// browser half of the door+delta loop; the transport (client/live-state-client.ts) and the store
// (client/live-state-store.ts) stay framework-free, so only this file imports React.
//
// Adapted from apps/os's `useLiveState` (packages/iterate/src/sdk/capnweb/react.tsx), kept to the
// one shape a demo/test needs — no reconnect/backoff/ping-watchdog (that policy belongs to whoever
// owns the capnweb session; here the caller passes a ready `itx`).

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connectLiveState, type LiveItx } from "./live-state-client.ts";
import type { LiveStateSeed, LiveStateStore } from "./live-state-store.ts";

export type LiveStateStatus = "connecting" | "live" | "error";

/** Subscribe to a producer's live state and render its latest value. Pass a ready `itx` (a capnweb
 *  `session.get()`), the producer's `key`, and a `door` thunk that reads `{rev, state}`
 *  (`() => itx.invokeCapability("itx.facets.get('slug').liveSnapshot()")`). Re-subscribes if `key`
 *  or the session changes. */
export function useLiveState<S>(
  itx: LiveItx | undefined,
  opts: { key: string; name?: string; door: () => Promise<LiveStateSeed<S>> },
): { value: S | undefined; rev: number | null; status: LiveStateStatus; error?: string } {
  const [store, setStore] = useState<LiveStateStore<S> | undefined>();
  const [status, setStatus] = useState<LiveStateStatus>("connecting");
  const [error, setError] = useState<string | undefined>();
  // The door closes over changing values; keep the latest without re-subscribing on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!itx) return;
    let disposed = false;
    setStore(undefined);
    setStatus("connecting");
    setError(undefined);
    connectLiveState<S>(itx, {
      key: optsRef.current.key,
      name: optsRef.current.name,
      door: () => optsRef.current.door(),
    }).then(
      (s) => {
        if (disposed) return;
        setStore(s);
        setStatus("live");
      },
      (e: unknown) => {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      },
    );
    return () => {
      disposed = true;
    };
  }, [itx, opts.key]);

  const value = useSyncExternalStore(
    (cb) => (store ? store.subscribe(cb) : () => {}),
    () => store?.get(),
    () => undefined,
  );
  return { value, rev: store?.rev() ?? null, status, error };
}
