/**
 * Browser-side live-state hook for createApp clients.
 *
 * Same protocol as `useLiveStateRpc` from `packages/iterate` (`iterate/react`).
 * Inlined in the seeded template because createApp does not inject platform
 * virtual modules the way createWorker does — both guestbook and todo import
 * this one module so the patch/resync logic is not duplicated.
 *
 * React is an esm.sh URL import to match the clients.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "https://esm.sh/react@19.2.4";

type LiveUpdate<State> =
  | { type: "snapshot"; revision: number; state: State }
  | { type: "patch"; from: number; to: number; patch: LiveStatePatch };

type LiveStatePatch =
  | { set: unknown }
  | { fields?: Record<string, LiveStatePatch>; drop?: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function applyPatch<State>(prev: State, patch: LiveStatePatch): State {
  if ("set" in patch) return patch.set as State;
  const base = isPlainObject(prev) ? prev : {};
  const next: Record<string, unknown> = { ...base };
  if (patch.fields) {
    for (const [key, childPatch] of Object.entries(patch.fields)) {
      next[key] = applyPatch(Object.hasOwn(base, key) ? base[key] : undefined, childPatch);
    }
  }
  if (patch.drop) {
    for (const key of patch.drop) delete next[key];
  }
  return next as State;
}

function createLiveStateStore<State>() {
  let held: { revision: number; state: State | undefined } = { revision: -1, state: undefined };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    getState: () => held.state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reset: () => {
      held = { revision: -1, state: undefined };
      notify();
    },
    apply: (update: LiveUpdate<State>, resync: () => void) => {
      if (update.type === "snapshot") {
        held = { revision: update.revision, state: update.state };
      } else if (update.from !== held.revision) {
        resync();
        return;
      } else {
        held = { revision: update.to, state: applyPatch(held.state as State, update.patch) };
      }
      notify();
    },
  };
}

export type LiveStateRpc<State> = {
  get(): Promise<State>;
  subscribe(onUpdate: (update: LiveUpdate<State>) => unknown): Promise<{ unsubscribe(): void }>;
};

/**
 * Subscribe a React tree to a Cap'n Web `LiveStateRpc` reached from a stable
 * root. The live accessor runs once per root so Cap'n Web property stubs
 * (fresh proxy each get) do not thrash the effect.
 */
export function useLiveStateRpc<Root extends object, State, Selected = State>(
  root: Root | null | undefined,
  live: (root: Root) => LiveStateRpc<State>,
  selector: (state: State) => Selected,
): { value: Selected | undefined; error: string | undefined } {
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
