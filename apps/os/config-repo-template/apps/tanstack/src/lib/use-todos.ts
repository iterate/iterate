import { newWebSocketRpcSession } from "@iterate-com/capnweb";
import { createLiveStateStore } from "iterate/live-state";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TodoListState, TodoSessionApi } from "./state.ts";

/**
 * The whole client: one Cap'n Web WebSocket to /api, authenticated from the
 * app's exact-origin cookie, its live state folded into the platform's
 * `createLiveStateStore` (snapshot + patches) and read with
 * `useSyncExternalStore`. Mutations are plain calls on the session — the
 * Durable Object refreshes its one LiveState and every open tab, this one
 * included, repaints from the pushed patch.
 */
export function useTodos() {
  const [api, setApi] = useState<TodoSessionApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storeRef = useRef(createLiveStateStore<TodoListState>());
  const store = storeRef.current;

  useEffect(() => {
    store.reset();
    // Updater form is LOAD-BEARING everywhere a Cap'n Web stub meets React
    // state: stubs are callable Proxies (that is what makes pipelining
    // work), so setApi(stub) would make React CALL it as an updater.
    setApi(() => null);
    const endpoint = new URL("/api", window.location.href);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const publicApi = newWebSocketRpcSession<{
      authenticate(credentials: { type: "from-server-cookie" }): Promise<TodoSessionApi>;
    }>(endpoint.toString());

    let disposed = false;
    let subscription: { unsubscribe(): void } | undefined;
    void (async () => {
      const session = await publicApi.authenticate({ type: "from-server-cookie" });
      const subscribe = async () => {
        // A revision gap means a missed patch; resubscribing makes the server
        // lead with a fresh snapshot. Both lanes gate on disposal so a dying
        // socket's stragglers cannot repopulate the store.
        subscription?.unsubscribe();
        subscription = await session.liveState.subscribe((update) => {
          if (disposed) return;
          store.apply(update, () => {
            if (!disposed) void subscribe();
          });
        });
      };
      await subscribe();
      if (!disposed) setApi(() => session);
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
  return { todos: state?.todos, api, error };
}
