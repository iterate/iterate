/**
 * Todo UI — Cap'n Web live state via the same useLiveStateRpc pattern as the
 * guestbook (and packages/iterate's iterate/react export). createApp keeps
 * React/Cap'n Web as esm.sh URL imports.
 */
import React, {
  type FormEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "https://esm.sh/react@19.2.4";
import { createRoot } from "https://esm.sh/react-dom@19.2.4/client";
import { newWebSocketRpcSession } from "https://esm.sh/@iterate-com/capnweb@0.10.0";

// --- createLiveStateStore + useLiveStateRpc (same protocol as packages/iterate) ---

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

type LiveStateRpc<State> = {
  get(): Promise<State>;
  subscribe(onUpdate: (update: LiveUpdate<State>) => unknown): Promise<{ unsubscribe(): void }>;
};

function useLiveStateRpc<Root extends object, State, Selected = State>(
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

// --- app ---

type TodoApi = {
  liveState: LiveStateRpc<{
    todos: Array<{ createdAt: string; done: boolean; id: string; title: string }>;
  }>;
  add(title: string): Promise<void>;
  setDone(id: string, done: boolean): Promise<void>;
  remove(id: string): Promise<void>;
};

function useTodoApi(): { api: TodoApi | null; error: string | undefined } {
  const [api, setApi] = useState<TodoApi | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setApi(() => null);
    setError(undefined);
    const endpoint = new URL("/api", window.location.href);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const publicApi = newWebSocketRpcSession<TodoApi>(endpoint.toString());
    setApi(() => publicApi);
    return () => {
      publicApi[Symbol.dispose]();
      setApi(() => null);
    };
  }, []);

  return { api, error };
}

export function TodoClient() {
  const { api, error: dialError } = useTodoApi();
  const { value: state, error: liveError } = useLiveStateRpc(
    api,
    (session) => session.liveState,
    (s) => s,
  );
  const [title, setTitle] = useState("");
  const [actionError, setActionError] = useState("");

  const error = dialError ?? liveError ?? (actionError.length > 0 ? actionError : undefined);
  const todos = state?.todos ?? [];

  const run = async (action: () => Promise<void>) => {
    setActionError("");
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (api == null || title.trim().length === 0) return;
    const next = title;
    setTitle("");
    await run(() => api.add(next));
  };

  return (
    <>
      <h1>Todo</h1>
      <form onSubmit={add}>
        <input
          aria-label="New todo"
          id="new-todo"
          maxLength={200}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder="What needs doing?"
          required
          type="text"
          value={title}
        />
        <button disabled={api == null} type="submit">
          Add
        </button>
      </form>
      {error !== undefined && <p role="alert">{error}</p>}
      {state === undefined ? (
        <p>Loading…</p>
      ) : todos.length === 0 ? (
        <p>No todos yet.</p>
      ) : (
        <ul>
          {todos.map((todo) => (
            <li key={todo.id}>
              <input
                aria-label={`Mark ${todo.title} ${todo.done ? "not done" : "done"}`}
                checked={todo.done}
                onChange={(event) => {
                  const done = event.currentTarget.checked;
                  if (api == null) return;
                  void run(() => api.setDone(todo.id, done));
                }}
                type="checkbox"
              />
              <span className={todo.done ? "done" : ""}>{todo.title}</span>
              <button
                onClick={() => {
                  if (api == null) return;
                  void run(() => api.remove(todo.id));
                }}
                type="button"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(<TodoClient />);
