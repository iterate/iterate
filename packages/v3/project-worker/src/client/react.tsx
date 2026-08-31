// client/react.tsx — the REACT binding for clean-room live state. `useLiveState` subscribes a
// component to a producer's live state (a processor slug, a mini-app key), seeds through its door,
// and re-renders on every synced delta via `useSyncExternalStore` over the LiveStateStore. It is the
// browser half of the door+delta loop; the transport (client/live-state-client.ts) and the store
// (client/live-state-store.ts) stay framework-free, so only this file imports React.
//
// Adapted from apps/os's `useLiveState` (packages/iterate/src/sdk/capnweb/react.tsx), kept to the
// one shape a demo/test needs — no reconnect/backoff/ping-watchdog (that policy belongs to whoever
// owns the capnweb session; here the caller passes a ready `itx`).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connectLiveState, type LiveItx } from "./live-state-client.ts";
import type { LiveStateSeed, LiveStateStore } from "./live-state-store.ts";

export type LiveStateStatus = "connecting" | "live" | "error";

/** Subscribe to a producer's live state and render its latest value. Pass a ready `itx` (a capnweb
 *  `session.get()`), the producer's `key`, and a `door` thunk that reads `{rev, state}`
 *  (`() => itx.invokeCapability("itx.facets.get('slug').liveSnapshot()")`). Re-subscribes when the
 *  session, `key`, or `name` changes; unmount (and every re-subscribe) unsubscribes the previous
 *  server-side mount. */
export function useLiveState<S>(
  itx: LiveItx | undefined,
  opts: { key: string; name?: string; door: () => Promise<LiveStateSeed<S>> },
): { value: S | undefined; rev: number | null; status: LiveStateStatus; error?: string } {
  const [store, setStore] = useState<LiveStateStore<S> | undefined>();
  const [status, setStatus] = useState<LiveStateStatus>("connecting");
  const [error, setError] = useState<string | undefined>();
  // The door thunk is a fresh arrow every render; hold the latest so the effect need not re-run per
  // render. The effect SNAPSHOTS it at connect time, so an old subscription's gap heal can never
  // read a NEWER key's door (cross-key contamination after a key/session switch).
  const doorRef = useRef(opts.door);
  doorRef.current = opts.door;

  useEffect(() => {
    setStore(undefined);
    setStatus("connecting");
    setError(undefined);
    if (!itx) return;
    const door = doorRef.current; // pinned to THIS key/session for the connection's whole life
    let disposed = false;
    let dispose: (() => Promise<void>) | undefined;
    connectLiveState<S>(itx, {
      key: opts.key,
      name: opts.name,
      door,
      onResync: (r) => {
        if (disposed) return;
        if (r === "healed") {
          setStatus("live");
          setError(undefined);
        } else {
          // the store keeps its last value; the next delta retries the heal
          setStatus("error");
          setError(r.message);
        }
      },
    }).then(
      (conn) => {
        dispose = conn.dispose;
        if (disposed) {
          void conn.dispose(); // unmounted while connecting — still tear the mount down
          return;
        }
        setStore(conn.store);
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
      void dispose?.();
    };
  }, [itx, opts.key, opts.name]);

  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : () => {}),
    [store],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => store?.get(),
    () => undefined,
  );
  return { value, rev: store?.rev() ?? null, status, error };
}
