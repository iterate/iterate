/**
 * React hooks over a raw {@link LiveStateRpc} — the userspace half of live
 * state (project workers, public apps, Cap'n Web sessions that are not the
 * dashboard itx). Dashboard code under a project scope still uses
 * {@link useLiveState} from `iterate/react` (itx-dialed).
 *
 * Same store/patch protocol as `useLiveState`; only the connection root differs.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createLiveStateStore } from "./itx/live-state/store.ts";
import type { LiveStateRpc } from "./processors/rpc-types.ts";

/**
 * Subscribe a React tree to a Cap'n Web `LiveStateRpc` reached from a stable
 * root (session / public API stub). The live accessor runs ONCE per root so
 * Cap'n Web property stubs (a fresh proxy each get) do not thrash the effect.
 *
 *   const api = useGuestbookApi();
 *   const { value } = useLiveStateRpc(api, (a) => a.liveState, (s) => s.entries);
 *
 * `value` is `undefined` until the first snapshot. A revision gap re-subscribes
 * automatically.
 */
export function useLiveStateRpc<Root extends object, State, Selected = State>(
  root: Root | null | undefined,
  live: (root: Root) => LiveStateRpc<State>,
  selector: (state: State) => Selected = (state) => state as unknown as Selected,
): {
  value: Selected | undefined;
  error: string | undefined;
} {
  const [store] = useState(() => createLiveStateStore<State>());
  const [error, setError] = useState<string | undefined>(undefined);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    store.reset();
    setError(undefined);
    if (root == null) return;

    // Capture the LiveStateRpc once for this root incarnation. Cap'n Web
    // getters return a new stub each access; depending on that identity would
    // tear down and resubscribe after every render.
    const liveState = liveRef.current(root);

    let disposed = false;
    let subscription: { unsubscribe(): void } | undefined;

    const subscribe = async () => {
      subscription?.unsubscribe();
      subscription = await liveState.subscribe((update) => {
        if (disposed) return;
        store.apply(update, () => {
          if (!disposed) void subscribe().catch(report);
        });
      });
    };

    const report = (thrown: unknown) => {
      if (disposed) return;
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    };

    void subscribe().catch(report);

    return () => {
      disposed = true;
      subscription?.unsubscribe();
      store.reset();
    };
  }, [root, store]);

  const cache = useRef<{ state: State | undefined; value: Selected | undefined }>({
    state: undefined,
    value: undefined,
  });
  const getSelected = () => {
    const state = store.getState();
    if (state === undefined) {
      cache.current = { state: undefined, value: undefined };
      return undefined;
    }
    if (Object.is(cache.current.state, state)) return cache.current.value;
    const value = selectorRef.current(state);
    cache.current = { state, value };
    return value;
  };

  const value = useSyncExternalStore(store.subscribe, getSelected, () => undefined);
  return { value, error };
}
