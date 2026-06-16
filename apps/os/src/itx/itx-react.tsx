/**
 * itx-react — the entire React surface for itx, in one file.
 *
 * `itx` is the project's capability handle: a capnweb `RpcStub` reached over ONE
 * WebSocket to `/api/itx[/<projectSlug>]`. This file is everything a component
 * needs to talk to the backend — the socket lifecycle AND the React primitives.
 *
 * FOUR primitives — two for GETTING the connection (in render vs imperatively),
 * one for a READ, one for a LIVE subscription:
 *
 *   1. GET THE HANDLE   → useItx()                          (in render; suspends until connected)
 *   2. …IMPERATIVELY    → await connectItx()                (in handlers/closures; a Promise — the
 *                                                            non-render sibling of useItx)
 *   3. READ ONCE        → useItxQuery({ key, query })       (suspends until resolved)
 *   4. SUBSCRIBE / LIVE → useItxEffect((itx) => cleanup, deps)
 *                                                           (set up on mount, dispose on unmount,
 *                                                            re-run on reconnect — see its docstring)
 *
 *   ACTIONS (mutations) → imperative on the handle, no extra primitive:
 *                           const itx = useItx();
 *                           <button onClick={() => itx.projects.remove({ id })} />
 *                         or, for pending/error/refetch tracking, TanStack Query's useMutation.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SOCKET MODEL — a Map, not a "pool"
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  • ONE WebSocket per CONTEXT (a project slug, or `undefined` for the global
 *    context), memoized in a module-level `Map` right here in this file. React
 *    19's `use()` needs a STABLE promise across render replays, so the
 *    connecting promise is cached: same context = same socket, different
 *    contexts = different sockets. The Map lives outside React, so a socket
 *    persists across client-side navigation — components mount/unmount, the
 *    socket does not — and every component on a context (project page, repl,
 *    activity tail, admin) shares the one connection.
 *
 *  • On socket death the entry is dropped and mounted readers are woken, so the
 *    next render re-dials and re-suspends on a fresh socket. There is no resume:
 *    re-reading current state IS the recovery (kernel subscriptions push current
 *    state on open), so a useItxEffect subscription re-fires after a reconnect.
 *    Connecting THROWS on the server (never SSRs): a forever-pending `use()`
 *    during streaming SSR would hang the response. Render itx consumers under an
 *    `ssr: false` route or `<ClientOnly>` + `<Suspense>`.
 *
 *  • CONNECTIONS are addressed by a plain { projectId?, path?, baseUrl? } tuple.
 *    Only `projectId` keys the socket today; `path`/`baseUrl` are reserved for
 *    future multi-connection addressing.
 *
 *  • The PROVIDER holds the ADDRESS, not the handle — and is "almost an
 *    optimization." Rules-of-hooks forbid conditionally opening a connection, so
 *    we split "WHICH address" (a plain value resolved with `??`) from "open a
 *    socket for it" (one unconditional hook). `useItx(override?)` resolves
 *    `override ?? providerAddress ?? global` then ALWAYS connects — so it works
 *    WITH a provider (shares its pre-warmed socket), WITHOUT one (global), and
 *    with an override (its own socket).
 *
 *  • READS suspend and ride TanStack Query, NOT a hand-rolled cache (React 19's
 *    `use()` needs a cached promise and the QueryClient already exists). EFFECTS
 *    are ONE hook whose cleanup is just `return () => sub[Symbol.dispose]()` —
 *    capnweb's `Symbol.dispose` IS the teardown; there is no bespoke
 *    `unsubscribe()`. See the two hooks' docstrings.
 */

// oxlint-disable react/only-export-components -- the itx hooks are colocated with ItxProvider by design (see module header); this file is the whole itx React surface, not a Fast Refresh component module.
import {
  createContext,
  use,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useSuspenseQuery, type QueryKey } from "@tanstack/react-query";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { ItxHandle } from "./handle.ts";

type Itx = RpcStub<ItxHandle>;

/**
 * How you address an itx connection — a plain, comparable value (that's what lets
 * the provider hold it in context and `useItx` resolve it with `??`). The empty
 * address `{}` is the global context. `projectId` is the stream owner key (a
 * project slug); `path`/`baseUrl` are reserved (not yet used to key the socket).
 */
export type ItxAddress = { projectId?: string; path?: string; baseUrl?: string };

// ─────────────────────────────────────────────────────────────────────────────
// The socket: one live WebSocket per context, kept outside React.
// ─────────────────────────────────────────────────────────────────────────────

const DIAL_TIMEOUT_MS = 15_000;

/** The connecting promise per context (a project slug, or `undefined` = global). */
const sockets = new Map<string | undefined, Promise<Itx>>();
/** Woken on any socket death so mounted readers (useSyncExternalStore) re-dial. */
const listeners = new Set<() => void>();
const wake = () => {
  for (const listener of listeners) listener();
};
const subscribeSockets = (onChange: () => void) => {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
};

/**
 * The connecting promise for a context, dialing once if absent. Stable identity
 * until the socket dies — that's what `use()` and useSyncExternalStore need.
 * Browser-only: throws on the server rather than suspending forever.
 */
function socketFor(context: string | undefined): Promise<Itx> {
  if (typeof window === "undefined") {
    throw new Error(
      "itx is browser-only: it dials a WebSocket to /api/itx and never SSRs. " +
        "Render itx consumers under an `ssr: false` route or inside <ClientOnly>.",
    );
  }
  const existing = sockets.get(context);
  if (existing) return existing;

  const url = new URL(
    context ? `/api/itx/${encodeURIComponent(context)}` : "/api/itx",
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  const { promise, resolve, reject } = Promise.withResolvers<Itx>();
  // Keep an internal handler so a dial that rejects with no live awaiter (the
  // reader unmounted, or only the hook ever held it) never surfaces as an
  // unhandledrejection — real `connectItx()` awaiters still observe it.
  void promise.catch(() => {});
  // A dial that never connects must not suspend forever: time out and close, so
  // the close handler below drops the entry and the next render re-dials.
  const timeout = setTimeout(() => ws.close(), DIAL_TIMEOUT_MS);
  ws.addEventListener("open", () => {
    clearTimeout(timeout);
    resolve(newWebSocketRpcSession<ItxHandle>(ws));
  });
  // `close` fires for a failed dial AND for a later death — either way the socket
  // is gone: drop the entry and wake readers so the next render re-dials.
  // Identity-guarded so a stale socket's death never evicts its successor.
  //
  // Then settle the connecting promise. Once a dial has opened it already
  // RESOLVED, so this reject is a no-op — a transient post-open drop stays a
  // clean re-dial for `use()`, never an error-boundary throw (the deliberate
  // design). But a dial that closes BEFORE opening never resolved: reject it so
  // imperative `connectItx()` awaiters fail fast instead of hanging on a
  // forever-pending promise. The hook re-dials regardless — `wake()` re-points
  // its snapshot to the fresh promise before this rejection is observed.
  ws.addEventListener("close", () => {
    clearTimeout(timeout);
    if (sockets.get(context) === promise) {
      sockets.delete(context);
      wake();
    }
    reject(new Error("itx WebSocket closed before connecting"));
  });
  sockets.set(context, promise);
  return promise;
}

/**
 * Drop a context's socket (default: global) and dispose it, so the next read
 * re-dials with the browser session's CURRENT claims. Call after a session
 * change such as creating a project or unlocking admin — the live socket carries
 * the connect-time principal, so `itx.projects.list` would otherwise omit the new
 * project until a reload.
 */
export function reconnectItx(address?: ItxAddress): void {
  const context = address?.projectId;
  const promise = sockets.get(context);
  if (!promise) return;
  sockets.delete(context);
  wake();
  void promise.then((itx) => (itx as Partial<Disposable>)[Symbol.dispose]?.()).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Connection: <ItxProvider> + useItx() + connectItx()
// ─────────────────────────────────────────────────────────────────────────────

/** Default address = the global context. Lets useItx() work with NO provider. */
const ItxAddressContext = createContext<ItxAddress>({});

/** Subscribe to the socket map, suspend until this context's socket connects. */
function useSocket(context: string | undefined): Itx {
  const promise = useSyncExternalStore(
    subscribeSockets,
    () => socketFor(context),
    () => socketFor(context),
  );
  return use(promise);
}

/**
 * Sets the default itx address for a subtree (and pre-warms its socket). It hands
 * down an ADDRESS, not a handle — and pre-opens the connection here so children's
 * `useItx()` resolve synchronously to the same socket. "Almost an optimization":
 * `useItx()` works without a provider (falls back to global).
 *
 * One <ItxProvider> serves every context — they're just different addresses:
 *   <ItxProvider />                          → global (home / projects list / admin)
 *   <ItxProvider projectId={projectSlug} />  → a project (the 99% case)
 *
 * The pre-warm suspends and never SSRs, so render it under an `ssr: false` route
 * (or `<ClientOnly>`) with a `<Suspense>` fallback.
 */
export function ItxProvider({
  projectId,
  path,
  baseUrl,
  children,
}: ItxAddress & { children: ReactNode }) {
  // Stable value so a fresh object literal each render doesn't thrash consumers.
  const address = useMemo<ItxAddress>(
    () => ({ projectId, path, baseUrl }),
    [projectId, path, baseUrl],
  );
  useSocket(projectId); // pre-warm: suspend here so children read it synchronously
  return <ItxAddressContext.Provider value={address}>{children}</ItxAddressContext.Provider>;
}

/**
 * The itx handle — "does its best" to get one:
 *   useItx()              → the provider's address (or global if none)
 *   useItx({ projectId }) → that address instead, IGNORING the provider
 *
 * Resolution is `override ?? providerAddress ?? global` — all plain values, so
 * there's no conditional hook. Suspends until connected; re-suspends on reconnect.
 * Use it for imperative actions, and pass it as `{ itx }` to override the default
 * in `useItxQuery` / `useItxEffect`.
 *
 *   const itx = useItx();
 *   const onDelete = () => itx.projects.remove({ id });
 */
export function useItx(override?: ItxAddress): Itx {
  const contextAddress = useContext(ItxAddressContext);
  return useSocket((override ?? contextAddress).projectId);
}

/**
 * The IMPERATIVE companion to {@link useItx}: the same socket, as a Promise, for
 * code that CAN'T (or MUSTN'T) call the hook — event handlers, a `mutationFn`,
 * and lazy closures (e.g. a ⌘K navigator that dials itx only when opened and must
 * NEVER suspend its parent's first paint).
 *
 *   const onCreate = async () => {
 *     const itx = await connectItx();                  // global context
 *     await itx.projects.create({ slug });
 *   };
 *   const itx = await connectItx({ projectId: slug }); // lazy; never suspends the caller
 *
 * WHY a separate accessor exists (and why `ssr: false` doesn't remove the need):
 * reaching itx splits into three concerns, and only the first is about SSR —
 *   1. SSR-safety — solved by `ssr: false` / <ClientOnly>. Irrelevant here.
 *   2. Suspense-coupling — the hook calls `use()`, so it suspends the WHOLE
 *      component on connect, even for itx it only touches on a later click. The
 *      agent feed must paint without waiting on the navigator's socket.
 *   3. Call-context — you literally cannot call a hook inside onClick / a
 *      mutationFn / a useMemo'd closure. True even with zero SSR.
 * (2) and (3) are what force a render-free Promise accessor; not SSR.
 *
 * WHY it's a standalone function, not `useItx.connect`: every mainstream library
 * ships the imperative companion as a peer function (SWR `preload`, Relay
 * `fetchQuery`) or a client method (`queryClient.fetchQuery`, `client.query`) —
 * none hang it off the hook, and a non-hook on a `use`-prefixed name fights the
 * rules-of-hooks convention. We can't put it on the handle the Apollo/Convex way
 * because `useItx` returns the BARE capnweb stub, not a wrapper client.
 *
 * Reads the SAME socket map the hook uses (same dedupe, same persist-across-
 * navigation, same re-dial-on-death), so it shares the socket a provider/hook in
 * the same subtree already warmed — address it by the same key (the project SLUG)
 * to land on that socket. Running outside render there is no provider context to
 * read: pass the address explicitly (defaults to global).
 */
export function connectItx(address?: ItxAddress): Promise<Itx> {
  return socketFor(address?.projectId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reads: useItxQuery() — suspends until resolved
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read once through itx, suspending until it resolves. A thin adapter over
 * TanStack Query's `useSuspenseQuery` (React 19's `use()` needs a cached promise,
 * and the QueryClient already exists, so this is strictly less machinery than
 * hand-rolling a cache).
 *
 *   const { projects } = useItxQuery({
 *     key: ["projects"],                              // the cache key — what this result IS
 *     query: (itx) => itx.projects.list({ limit: 20 }),
 *   });
 *
 * `key` is the TanStack queryKey (prefixed with "itx" internally). It must encode
 * exactly what the result is scoped to: a GLOBAL read like the project list is
 * just `["projects"]`; a PER-PROJECT read keys by the project so two projects'
 * data can't collide, e.g. `["secrets", projectSlug]`.
 *
 * `itx` defaults to the provider's handle; pass it to read through a different
 * connection. Errors throw to the nearest error boundary; refetch after a mutation
 * with `queryClient.invalidateQueries({ queryKey: ["itx", ...key] })`.
 */
export function useItxQuery<T>({
  key,
  query,
  itx,
}: {
  key: QueryKey;
  query: (itx: Itx) => Promise<T>;
  itx?: Itx;
}): T {
  const fallback = useItx();
  const handle = itx ?? fallback; // an explicit { itx } override wins
  return useSuspenseQuery({
    queryKey: ["itx", ...(Array.isArray(key) ? key : [key])],
    queryFn: () => query(handle),
  }).data;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Live subscriptions: useItxEffect() — a reconnect-aware itx effect
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set up a live itx subscription (or any mount-scoped itx work) and tear it down
 * on unmount. Use this for the SUSPEND-OK case: a component that already holds a
 * `useItx()` handle and wants the server to push into it for as long as it's
 * mounted.
 *
 * THE LOAD-BEARING REASON it exists (not just sugar over `useEffect`): it injects
 * the connected `itx` handle and threads it into the effect deps, so when the
 * socket dies and re-dials, the effect RE-RUNS and re-subscribes on the fresh
 * socket — its subscription's first push is the recovery. A hand-rolled
 * `useEffect` that reaches itx through a closure silently omits that dep and does
 * NOT recover on reconnect (the codebase has exactly that bug, papered over with
 * a manual "Refresh" button in stream-tree-browser). A dedicated subscription
 * hook is also the universal shape — Apollo/urql/tRPC/Relay/Convex all ship one
 * rather than asking callers to wire raw effects.
 *
 * NOT for the must-NOT-suspend case: a component whose main content does not
 * depend on itx (e.g. the agent feed, the ⌘K tree) dials lazily via
 * {@link connectItx} inside a closure instead, so a slow/down socket degrades
 * just that widget and never suspends the page.
 *
 * Subscribe to live pushes:
 *   const [state, setState] = useState<ProjectState>();
 *   useItxEffect((itx) => {
 *     const sub = itx.project.onStateChange(setState); // server now pushes to setState
 *     return () => sub[Symbol.dispose]();              // dispose = tell the server to stop
 *   }, []);
 *
 * Async setup (await, then subscribe) — same hook, no extra ceremony:
 *   useItxEffect(async (itx) => {
 *     const cfg = await itx.project.getConfig();
 *     const sub = itx.project.onStateChange((s) => setState({ ...s, cfg }));
 *     return () => sub[Symbol.dispose]();
 *   }, []);
 *
 * The callback may be sync OR async; you don't pick. An async setup's late cleanup
 * still runs if you unmounted mid-await (React's documented async-effect guard).
 * Cleanup contract = `useEffect`'s: return a cleanup function (or nothing) —
 * typically disposing a capnweb stub via `Symbol.dispose`. `itx` defaults to the
 * provider; `[itx]` is added to the deps internally.
 */
export function useItxEffect(
  setup: (itx: Itx) => void | (() => void) | Promise<void | (() => void)>,
  deps: unknown[],
  opts?: { itx?: Itx },
): void {
  const fallback = useItx();
  const itx = opts?.itx ?? fallback; // an explicit { itx } override wins
  useEffect(() => {
    let disposed = false;
    let cleanup: void | (() => void);
    const result = setup(itx);
    if (result instanceof Promise) {
      // Async: the cleanup lands later. If we unmounted in the meantime, run it
      // immediately so nothing leaks (React's documented async-effect guard).
      void result.then(
        (c) => {
          if (disposed) c?.();
          else cleanup = c;
        },
        // A rejected async setup has no resource to clean up — surface it rather
        // than leave an unhandled rejection. A setup that wants to RENDER the
        // failure should try/catch and setState itself (see itx-activity-tail).
        (error: unknown) => {
          if (!disposed) console.error("useItxEffect: async setup failed", error);
        },
      );
    } else {
      cleanup = result; // sync: cleanup captured now, like a normal effect
    }
    return () => {
      disposed = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- [itx] + caller's deps; setup read fresh per run
  }, [itx, ...deps]);
}
