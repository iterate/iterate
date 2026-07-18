import { newWebSocketRpcSession } from "capnweb";
import { createLiveStateStore } from "iterate/live-state";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TodoListApi, TodoListState } from "../state.ts";

/**
 * The whole client: one Cap'n Web WebSocket to the list's Durable Object,
 * its live state folded into `createLiveStateStore` (snapshot + patches, the
 * same store `useLiveState` renders inside the iterate keeper) and read with
 * `useSyncExternalStore`. Mutations are plain calls on the session — the
 * server refreshes the one LiveState and every connected browser, this one
 * included, repaints from the pushed patch.
 */
export function useTodoList(slug: string) {
  const [api, setApi] = useState<TodoListApi | null>(null);
  const storeRef = useRef(createLiveStateStore<TodoListState>());
  const store = storeRef.current;

  useEffect(() => {
    store.reset();
    setApi(null);
    const endpoint = new URL(`/api/lists/${slug}`, window.location.href);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const session = newWebSocketRpcSession<TodoListApi>(endpoint.toString());

    let disposed = false;
    let subscription: { unsubscribe(): void } | undefined;
    const subscribe = async () => {
      // A revision gap in the store means a missed patch; resubscribing makes
      // the server lead with a fresh snapshot, which the store folds in. The
      // disposed guard is load-bearing: the store outlives this effect (one
      // ref across slug changes), so a straggler update from this session's
      // dying WebSocket must not repopulate it after the next effect reset it
      // for another list.
      subscription?.unsubscribe();
      subscription = await session.liveState.subscribe((update) => {
        if (disposed) return;
        store.apply(update, () => {
          if (!disposed) void subscribe();
        });
      });
    };
    void subscribe()
      .then(() => {
        // Updater form is LOAD-BEARING: a Cap'n Web stub is a callable Proxy
        // (that is what makes pipelining work), so setApi(session) would make
        // React treat it as an updater and CALL it — storing a bogus
        // pipelined-call stub instead of the session.
        if (!disposed) setApi(() => session);
      })
      .catch(() => {
        // Strict-mode double-mount disposes the first session while its
        // subscribe is still in flight; the rejection is that disposal, not
        // a failure of the surviving session.
      });

    return () => {
      disposed = true;
      subscription?.unsubscribe();
      session[Symbol.dispose]();
    };
  }, [slug, store]);

  const state = useSyncExternalStore(store.subscribe, store.getState, () => undefined);
  return { todos: state?.todos, api };
}
