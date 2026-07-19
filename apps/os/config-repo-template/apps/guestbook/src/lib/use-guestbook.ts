import { newWebSocketRpcSession } from "@iterate-com/capnweb";
import { createLiveStateStore } from "iterate/live-state";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { GuestbookApi, GuestbookFoldState } from "./state.ts";

/**
 * The whole client: one Cap'n Web WebSocket to /api (public — the root
 * target needs no authenticate step), the processor's fold folded into the
 * platform's `createLiveStateStore` (snapshot + patches) and read with
 * `useSyncExternalStore`. Signing is a plain call on the root — the append
 * flows through the stream's wake spine back into the fold, and every open
 * tab, this one included, repaints from the pushed patch.
 */
export function useGuestbook() {
  const [api, setApi] = useState<GuestbookApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storeRef = useRef(createLiveStateStore<GuestbookFoldState>());
  const store = storeRef.current;

  useEffect(() => {
    store.reset();
    // Updater form is LOAD-BEARING everywhere a Cap'n Web stub meets React
    // state: stubs are callable Proxies (that is what makes pipelining
    // work), so setApi(stub) would make React CALL it as an updater.
    setApi(() => null);
    const endpoint = new URL("/api", window.location.href);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const publicApi = newWebSocketRpcSession<GuestbookApi>(endpoint.toString());

    let disposed = false;
    let subscription: { unsubscribe(): void } | undefined;
    void (async () => {
      const subscribe = async () => {
        // A revision gap means a missed patch; resubscribing makes the server
        // lead with a fresh snapshot. Both lanes gate on disposal so a dying
        // socket's stragglers cannot repopulate the store.
        subscription?.unsubscribe();
        subscription = await publicApi.liveState.subscribe((update) => {
          if (disposed) return;
          store.apply(update, () => {
            if (!disposed) void subscribe();
          });
        });
      };
      await subscribe();
      if (!disposed) setApi(() => publicApi);
    })().catch((thrown: unknown) => {
      if (!disposed) setError(thrown instanceof Error ? thrown.message : String(thrown));
    });

    return () => {
      disposed = true;
      subscription?.unsubscribe();
      publicApi[Symbol.dispose]();
    };
  }, [store]);

  const state = useSyncExternalStore(store.subscribe, store.getState, () => undefined);
  return { guestbook: state, api, error };
}
