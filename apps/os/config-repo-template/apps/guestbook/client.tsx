/**
 * Public guestbook UI. Live reduced state arrives over Cap'n Web via the same
 * `useLiveStateRpc` hook as `iterate/react` (inlined here so createApp can
 * resolve it without pulling the full itx session stack into the browser
 * bundle — createApp does not inject platform virtual modules the way
 * createWorker does). Cap'n Web + React stay esm.sh URL imports.
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

/** Same contract as `useLiveStateRpc` from `iterate/react`. */
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

    // Capture LiveStateRpc once per root — Cap'n Web getters return a new stub
    // each access; depending on that identity would thrash the subscription.
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

type GuestbookState = {
  birthCertificate: { config: { title: string } } | null;
  entries: Array<{ name: string; message: string; signedAt: string }>;
  lastMilestone: number;
};

type GuestbookApi = {
  liveState: LiveStateRpc<GuestbookState>;
  sign(name: string, message: string): Promise<void>;
};

function useGuestbookApi(): GuestbookApi | null {
  const [api, setApi] = useState<GuestbookApi | null>(null);

  useEffect(() => {
    // Updater form is load-bearing: Cap'n Web stubs are callable Proxies, so
    // setApi(stub) would make React CALL the stub as an updater.
    setApi(() => null);
    const endpoint = new URL("/api", window.location.href);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const publicApi = newWebSocketRpcSession<GuestbookApi>(endpoint.toString());
    setApi(() => publicApi);
    return () => {
      publicApi[Symbol.dispose]();
      setApi(() => null);
    };
  }, []);

  return api;
}

export function GuestbookClient() {
  const api = useGuestbookApi();
  const { value: state, error: liveError } = useLiveStateRpc(
    api,
    (session) => session.liveState,
    (s) => s,
  );
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState("");

  const error = liveError ?? (signError.length > 0 ? signError : undefined);
  const entries = state?.entries ?? [];
  // Only claim the configured title once reduced state has arrived — the
  // seeded-apps heading wait must not pass on the HTML shell alone.
  const title =
    state === undefined ? "Loading…" : (state.birthCertificate?.config.title ?? "Guestbook");

  const sign = async (event: FormEvent) => {
    event.preventDefault();
    if (api == null) return;
    setSigning(true);
    setSignError("");
    try {
      await api.sign(name, message);
      setMessage("");
    } catch (cause) {
      setSignError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSigning(false);
    }
  };

  return (
    <>
      <h1>{title}</h1>
      <form onSubmit={sign}>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          maxLength={80}
          onChange={(event) => setName(event.currentTarget.value)}
          required
          value={name}
        />
        <label htmlFor="message">Message</label>
        <textarea
          id="message"
          maxLength={500}
          onChange={(event) => setMessage(event.currentTarget.value)}
          required
          rows={4}
          value={message}
        />
        <button disabled={api == null || signing} type="submit">
          Sign guestbook
        </button>
      </form>
      {error !== undefined && <p role="alert">{error}</p>}
      {state === undefined ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p>No entries yet.</p>
      ) : (
        <section aria-label="Guestbook entries">
          {/* Newest first; key on payload identity (not reversed index — that
              shifts on every append and remounts the list). */}
          {[...entries].reverse().map((entry) => (
            <article key={`${entry.signedAt}\0${entry.name}\0${entry.message}`}>
              <strong>{entry.name}</strong> <time dateTime={entry.signedAt}>{entry.signedAt}</time>
              <p>{entry.message}</p>
            </article>
          ))}
        </section>
      )}
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(<GuestbookClient />);
