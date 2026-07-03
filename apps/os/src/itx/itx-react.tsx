/**
 * itx-react — the entire React surface for itx, in one file.
 *
 * `itx` is the project's capability handle: a capnweb `RpcStub` reached over ONE
 * WebSocket to `/api[/<projectSlug>]`. This file is everything a component
 * needs to talk to the backend — the socket lifecycle AND the React primitives.
 *
 * FIVE primitives — two for GETTING the connection (in render vs imperatively),
 * one for a READ, one for a LIVE subscription, one for LIVE PROCESSOR STATE:
 *
 *   1. GET THE HANDLE   → useItx()                          (in render; suspends until connected)
 *   2. …IMPERATIVELY    → await connectItxBrowser()                (in handlers/closures; a Promise — the
 *                                                            non-render sibling of useItx)
 *   3. READ ONCE        → useItxQuery({ key, query })       (suspends until resolved)
 *   4. SUBSCRIBE / LIVE → useItxSubscription((itx) => handle, deps)
 *                                                           (owns the WHOLE recovery story for a live
 *                                                            server-push subscription: reconnect,
 *                                                            liveness watchdog, re-subscribe, retry —
 *                                                            see its docstring)
 *   5. LIVE STATE       → useItxState((itx) => itx.processor)
 *                                                           (the React spelling of
 *                                                            itx.processor.onStateChange(setState):
 *                                                            the initial push is the first paint, every
 *                                                            state change repaints — see its docstring)
 *
 *   (useItxEffect — the reconnect-aware raw effect — is the internal foundation
 *   under the live hooks; it stops being module-private the day a consumer
 *   needs mount-scoped itx work that isn't a subscription.)
 *
 *   ACTIONS (mutations) → imperative on the handle, no extra primitive:
 *                           const itx = useItx();
 *                           <button onClick={() => itx.chat.sendMessage({ text })} />
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
 *    `use()` needs a cached promise and the QueryClient already exists). LIVE
 *    subscriptions are ONE hook (useItxSubscription) owning the entire recovery
 *    story — reconnect, liveness watchdog, re-subscribe, retry — so no consumer
 *    hand-rolls epochs or watchdogs. See the hooks' docstrings.
 */

// oxlint-disable react/only-export-components -- the itx hooks are colocated with ItxProvider by design (see module header); this file is the whole itx React surface, not a Fast Refresh component module.
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useSuspenseQuery, type QueryKey } from "@tanstack/react-query";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type {
  ProcessorSnapshot,
  ProjectRpcTarget as ProjectItx,
  Session,
  UnauthenticatedOs,
} from "../types.ts";

/**
 * The handle type is context-dependent: a project connection holds the project
 * itx, the global connection holds the Session catalog. One pragmatic
 * intersection keeps the four primitives monomorphic — a wrong call for the
 * context fails at runtime exactly like a missing capability would.
 */
type ItxHandle = RpcStub<Session & ProjectItx>;
export type { ItxHandle as ItxReactHandle };

/**
 * How you address an itx connection — a plain, comparable value (that's what lets
 * the provider hold it in context and `useItx` resolve it with `??`). The empty
 * address `{}` is the global context. `projectId` is a project id (`prj_…`); `path`/`baseUrl` are reserved (not yet used to key the socket).
 */
type ItxAddress = { projectId?: string; path?: string; baseUrl?: string };

// ─────────────────────────────────────────────────────────────────────────────
// The socket: one live WebSocket per context, kept outside React.
// ─────────────────────────────────────────────────────────────────────────────

const DIAL_TIMEOUT_MS = 15_000;

/** The connecting promise per context (a project slug, or `undefined` = global). */
const sockets = new Map<string | undefined, Promise<ItxHandle>>();
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
function socketFor(context: string | undefined): Promise<ItxHandle> {
  if (typeof window === "undefined") {
    throw new Error(
      "itx is browser-only: it dials a WebSocket to /api and never SSRs. " +
        "Render itx consumers under an `ssr: false` route or inside <ClientOnly>.",
    );
  }
  const existing = sockets.get(context);
  if (existing) return existing;

  // Context resolution is client-side: one endpoint, authenticate(), then
  // projects.get(<project id>) — the context key is a project ID, not a slug.
  const url = new URL("/api", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  const { promise, resolve, reject } = Promise.withResolvers<ItxHandle>();
  // Keep an internal handler so a dial that rejects with no live awaiter (the
  // reader unmounted, or only the hook ever held it) never surfaces as an
  // unhandledrejection — real `connectItxBrowser()` awaiters still observe it.
  void promise.catch(() => {});
  // A dial that never connects must not suspend forever: time out and close, so
  // the close handler below drops the entry and the next render re-dials.
  const timeout = setTimeout(() => ws.close(), DIAL_TIMEOUT_MS);
  ws.addEventListener("open", () => {
    clearTimeout(timeout);
    // Pipelined, no extra round trips: authenticate() rides the session cookie
    // on the WebSocket handshake, projects.get narrows to the project context.
    // The session/root stubs live as long as the socket; they are never
    // disposed individually.
    const unauthenticated = newWebSocketRpcSession<UnauthenticatedOs>(ws);
    const root = unauthenticated.authenticate({ type: "from-server-cookie" });
    resolve((context ? root.projects.get(context) : root) as unknown as ItxHandle);
  });
  // `close` fires for a failed dial AND for a later death — either way the socket
  // is gone: drop the entry and wake readers so the next render re-dials.
  // Identity-guarded so a stale socket's death never evicts its successor.
  //
  // Then settle the connecting promise. Once a dial has opened it already
  // RESOLVED, so this reject is a no-op — a transient post-open drop stays a
  // clean re-dial for `use()`, never an error-boundary throw (the deliberate
  // design). But a dial that closes BEFORE opening never resolved: reject it so
  // imperative `connectItxBrowser()` awaiters fail fast instead of hanging on a
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

/**
 * Drop and re-dial EVERY live socket. The recovery for a half-open transport
 * (laptop sleep, network switch): when one socket's ping stops answering, the
 * others were on the same TCP conditions — and a half-open socket never fires
 * `close`, so nothing else would ever recover them.
 */
let lastReconnectAllAt = 0;

function reconnectAllItx(): void {
  // Single-flight across watchdogs: a half-open transport times out EVERY
  // mounted subscription's ping within one timeout window, and a second pass
  // here would drop the fresh sockets the first pass just started re-dialing.
  // One storm → one reconnect.
  const now = Date.now();
  if (now - lastReconnectAllAt < LIVENESS_PING_TIMEOUT_MS) return;
  lastReconnectAllAt = now;
  for (const context of [...sockets.keys()]) {
    reconnectItx({ projectId: context });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Connection: <ItxProvider> + useItx() + connectItxBrowser()
// ─────────────────────────────────────────────────────────────────────────────

/** Default address = the global context. Lets useItx() work with NO provider. */
const ItxAddressContext = createContext<ItxAddress>({});

/** Subscribe to the socket map, suspend until this context's socket connects. */
function useSocket(context: string | undefined): ItxHandle {
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
  return <ItxAddressContext value={address}>{children}</ItxAddressContext>;
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
 *   const onSend = () => itx.chat.sendMessage({ text });
 */
export function useItx(override?: ItxAddress): ItxHandle {
  const contextAddress = use(ItxAddressContext);
  return useSocket((override ?? contextAddress).projectId);
}

/**
 * The IMPERATIVE companion to {@link useItx}: the same socket, as a Promise, for
 * code that CAN'T (or MUSTN'T) call the hook — event handlers, a `mutationFn`,
 * and lazy closures (e.g. a ⌘K navigator that dials itx only when opened and must
 * NEVER suspend its parent's first paint).
 *
 *   const onCreate = async () => {
 *     const itx = await connectItxBrowser();                  // global context
 *     await itx.projects.create({ slug });
 *   };
 *   const itx = await connectItxBrowser({ projectId: slug }); // lazy; never suspends the caller
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
export function connectItxBrowser(address?: ItxAddress): Promise<ItxHandle> {
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
  query: (itx: ItxHandle) => Promise<T>;
  itx?: ItxHandle;
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
 * {@link connectItxBrowser} inside a closure instead, so a slow/down socket degrades
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
function useItxEffect(
  setup: (itx: ItxHandle) => void | (() => void) | Promise<void | (() => void)>,
  deps: unknown[],
  opts?: { itx?: ItxHandle },
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

// ─────────────────────────────────────────────────────────────────────────────
// 4. Live processor state: useItxProcessorState() — snapshot + push + watchdog
// ─────────────────────────────────────────────────────────────────────────────

/** How often a mounted subscription verifies it is still alive server-side. */
const LIVENESS_INTERVAL_MS = 45_000;
/** A ping slower than this means the socket is half-open (sleep/network change): re-dial. */
const LIVENESS_PING_TIMEOUT_MS = 10_000;
/** How long useItxSubscription waits before retrying a failed subscribe. */
const SUBSCRIBE_RETRY_MS = 10_000;
const PING_TIMED_OUT = Symbol("itx-ping-timed-out");

/**
 * Poll a subscription handle's `ping()` until it stops answering `true`, then
 * recover. This exists because server pushes fail SILENTLY: a dead Durable
 * Object or a half-open TCP connection stops delivering without any
 * client-visible signal, so a page can show "live" forever while being stale.
 * The watchdog checks on an interval and — because those are exactly the
 * moments sockets die — when the tab becomes visible or the browser comes
 * back online.
 *
 * The two failure shapes and their recoveries:
 *
 *   `dead`      → ping answered `false` or REJECTED. The socket works but the
 *                 server-side subscription is gone (the hosting DO restarted,
 *                 or the callback was dropped after a failed delivery). The
 *                 caller's recovery is a re-subscribe on the same socket.
 *   `timed-out` → ping never answered: the WebSocket is half-open (laptop
 *                 sleep, network switch — the browser never gets a `close`
 *                 event). The watchdog itself drops every live socket
 *                 ({@link reconnectAllItx} — they all shared the dead network)
 *                 BEFORE reporting; consumers keyed on the itx handle re-run
 *                 once the fresh socket connects, so the report is only for
 *                 status UI.
 *
 * Returns a stop function. `onDead` fires at most once; the caller is expected
 * to tear down and re-subscribe (which creates a fresh watchdog).
 */
function watchItxSubscription(
  ping: () => boolean | Promise<boolean>,
  onDead: (reason: "dead" | "timed-out") => void,
): () => void {
  let stopped = false;
  let checking = false;

  const report = (reason: "dead" | "timed-out") => {
    if (stopped) return;
    stop();
    if (reason === "timed-out") reconnectAllItx();
    onDead(reason);
  };

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const timeout = new Promise<typeof PING_TIMED_OUT>((resolve) =>
        setTimeout(() => resolve(PING_TIMED_OUT), LIVENESS_PING_TIMEOUT_MS),
      );
      let alive: boolean | typeof PING_TIMED_OUT;
      try {
        alive = await Promise.race([Promise.resolve(ping()), timeout]);
      } catch {
        report("dead");
        return;
      }
      if (alive === PING_TIMED_OUT) report("timed-out");
      else if (alive !== true) report("dead");
    } finally {
      checking = false;
    }
  };

  const onWake = () => {
    if (document.visibilityState === "visible") void check();
  };
  const interval = setInterval(() => void check(), LIVENESS_INTERVAL_MS);
  document.addEventListener("visibilitychange", onWake);
  window.addEventListener("online", onWake);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onWake);
    window.removeEventListener("online", onWake);
  };
  return stop;
}

/**
 * The live handle shape every itx subscription API returns — `Stream.subscribe`
 * and `StreamProcessorRpc.onStateChange` both hand back `ping()` + `unsubscribe()`.
 */
export type ItxLiveSubscriptionHandle = {
  ping(): boolean | Promise<boolean>;
  unsubscribe(): unknown;
};

export type ItxSubscriptionStatus = "connecting" | "live" | "error";

/**
 * Hold ONE live server-push subscription for as long as the component is
 * mounted, owning the whole recovery story so consumers never hand-roll it:
 *
 *   - socket death with a `close` event → re-subscribes on the fresh socket
 *     (via {@link useItxEffect}'s reconnect-aware [itx] dep);
 *   - SILENT death — hosting DO restart, dropped callback, half-open TCP —
 *     → the {@link watchItxSubscription} watchdog detects it and either
 *     re-subscribes (dead) or drops the sockets so everything re-dials
 *     (timed-out);
 *   - a failed subscribe attempt → status "error", retried on a
 *     watchdog-shaped delay.
 *
 * `subscribe` opens the subscription and returns its handle; server pushes go
 * wherever the caller's callbacks put them (component state, the query cache).
 * A re-subscription's first push is the recovery, so push consumers must be
 * replay-tolerant — merge by offset, or let last-write-wins state absorb it.
 *
 *   const [events, setEvents] = useState<StreamEvent[]>([]);
 *   const { status } = useItxSubscription(
 *     (itx) => itx.streams.get("/logs").subscribe({
 *       replayAfterOffset: 0,
 *       processEventBatch: (batch) => setEvents((prev) => mergeByOffset(prev, batch.events)),
 *     }),
 *     [],
 *   );
 *
 * `status` is the honesty bit for UI: "live" only while a subscription is
 * actually established. `refresh()` force re-subscribes (the impatient-human
 * button). `enabled: false` renders the hook inert (for lazily-loaded tree
 * nodes). `deps` re-subscribe when they change, like useItxEffect's.
 */
export function useItxSubscription(
  subscribe: (itx: ItxHandle) => Promise<ItxLiveSubscriptionHandle>,
  deps: unknown[],
  opts?: { enabled?: boolean },
): { status: ItxSubscriptionStatus; error?: string; refresh: () => void } {
  const enabled = opts?.enabled ?? true;
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<{ status: ItxSubscriptionStatus; error?: string }>({
    status: "connecting",
  });

  useItxEffect(
    async (effectItx) => {
      // Status resets BEFORE the enabled gate: a subscription disabled after a
      // live period must not keep reporting "live" over its torn-down handle
      // (consumers render stale data as fresh otherwise).
      setState({ status: "connecting" });
      if (!enabled) return;
      let disposed = false;

      let subscription: ItxLiveSubscriptionHandle;
      try {
        subscription = await subscribe(effectItx);
      } catch (error) {
        if (disposed) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        const retry = setTimeout(() => setEpoch((current) => current + 1), SUBSCRIBE_RETRY_MS);
        return () => clearTimeout(retry);
      }
      const dispose = () =>
        void Promise.resolve()
          .then(() => subscription.unsubscribe())
          .catch(() => {
            // The server side of a dead subscription is already gone.
          });
      if (disposed) {
        dispose();
        return;
      }
      setState({ status: "live" });

      const stopWatchdog = watchItxSubscription(
        () => subscription.ping(),
        () => {
          if (disposed) return;
          setState({ status: "connecting" });
          // Re-subscribe unconditionally. On "dead" the socket is fine and
          // this is the whole recovery; on "timed-out" the watchdog dropped
          // the sockets, but a sibling watchdog may have already done that
          // within the single-flight window — if this consumer's socket was
          // therefore NOT replaced, the [itx] dep alone would never re-run
          // this effect and the subscription would stay stuck. The epoch bump
          // covers both; a doubled re-subscribe is idempotent (the fresh
          // initial push repaints).
          setEpoch((current) => current + 1);
        },
      );

      return () => {
        disposed = true;
        stopWatchdog();
        dispose();
      };
    },
    [enabled, epoch, ...deps],
  );

  return {
    ...state,
    refresh: () => {
      setState({ status: "connecting" });
      setEpoch((current) => current + 1);
    },
  };
}

/**
 * THE page-data primitive: live reduced state from a stream processor. The
 * callsite spells the whole subscription — nothing is called on your behalf:
 *
 *   const { state } = useItxState((itx, setState) => itx.processor.onStateChange(setState), []);
 *   // state.secrets / state.repos / state.agents re-render as events land
 *
 * The hook only owns what a callsite can't: the state cell (`setState` is a
 * plain setter EXCEPT it commits offset-monotonically, so a straggler push
 * from a dying subscription can never roll state backwards) and
 * {@link useItxSubscription}'s recovery. No cache keys, no query client, no
 * separate initial fetch: `onStateChange` delivers the current checkpoint
 * immediately (the server's initial push IS the first paint) and every state
 * change after; mutations need no invalidation.
 *
 * `state` is `undefined` between mount and the initial push (one round trip
 * on a warm socket); render a loading row for that window. Anything the
 * subscribe closure captures that points the hook at a DIFFERENT processor
 * (a secret path, a repo path) goes in `deps` — a deps change re-subscribes
 * AND drops the held snapshot, so offsets from unrelated processors are
 * never compared.
 */
export function useItxState<State>(
  subscribe: (
    itx: ItxHandle,
    setState: (snapshot: ProcessorSnapshot<State>) => void,
  ) => Promise<ItxLiveSubscriptionHandle>,
  deps: unknown[] = [],
): {
  state: State | undefined;
  offset: number | undefined;
  status: ItxSubscriptionStatus;
  error?: string;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<ProcessorSnapshot<State>>();

  // deps change = this hook now points at a different processor: the old
  // snapshot must not survive (its offsets are meaningless against the new
  // processor's). Recovery re-subscribes (same processor) keep the snapshot —
  // they come from useItxSubscription's internal epoch, not from deps.
  useEffect(() => {
    return () => setSnapshot(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller's deps by design
  }, deps);

  const subscription = useItxSubscription(
    (itx) =>
      subscribe(itx, (pushed) => {
        setSnapshot((previous) =>
          previous !== undefined && previous.offset >= pushed.offset ? previous : pushed,
        );
      }),
    deps,
  );

  return { state: snapshot?.state, offset: snapshot?.offset, ...subscription };
}
