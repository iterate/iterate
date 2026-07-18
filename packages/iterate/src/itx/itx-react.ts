/**
 * itx-react — the React surface for itx: hooks over the framework-free session
 * keeper in ./itx-session.ts (one WebSocket per tab, generations, invisible
 * reconnect — the session model lives there) plus TanStack Query for reads.
 *
 * Renderer-agnostic on purpose: nothing here touches the DOM, so the same
 * hooks run under react-dom (the OS dashboard), @opentui/react (the chat TUI),
 * and React Native — TanStack Query itself only uses React primitives. The
 * browser-specific pieces (cookie auth, window-derived URL, visibility/online
 * wake probes) live in the keeper behind runtime guards; non-browser apps
 * point the keeper at a deployment with `configureIterateSession`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE PRIMITIVES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   SESSION (the catalog authenticate() returned)
 *     useIterateSession()            in render; suspends once on first connect
 *     connectIterateSession()        imperative (handlers/closures); a Promise
 *
 *   ITX (a project capability handle — session.projects.get(slug))
 *     useItx(slug?)           in render; slug (or prj_ id) from the arg or <ProjectScope>
 *     connectItx(slug)        imperative; a Promise
 *
 *   READ ONCE   useItxQuery({ key, query })              project read; SUSPENDS
 *               useIterateSessionQuery({ key, query })   session read; NON-suspending (shell)
 *   LIVE STATE  useLiveState((itx) => itx.liveState, selector)  project snapshot + diffs
 *               useIterateSessionLiveState(...)                 session snapshot + diffs
 *   SUBSCRIBE   useItxSubscription((itx) => handle, deps)   raw event stream (escape hatch)
 *   MOUNT       <ProjectScope slug>   ambient project + socket pre-warm (no provider)
 *
 *   ACTIONS (mutations) — imperative on the handle, no extra primitive:
 *     const itx = useItx();
 *     <button onClick={() => itx.chat.sendMessage(text)} />
 *
 * RECONNECT, AS REACT SEES IT: components read an immutable Snapshot via
 * `useSyncExternalStore`; `snapshot.session` holds the LAST live session and is
 * kept across a transport gap. So `useIterateSession()` suspends exactly once —
 * first load, on the stable first-connect promise — and never again: when the
 * socket dies we keep showing the last session while a fresh generation dials
 * in the background, then swap when it establishes. TanStack keeps cached read
 * data through a reconnect (no re-suspend, no spinner); only an in-flight read
 * retries, on the transport-only policy — see useItxQuery. A stray action fired
 * during the sub-second gap rides the dead stub and rejects — the one accepted
 * edge.
 *
 * CONNECTING THROWS ON THE SERVER (never SSRs): a forever-pending `use()`
 * during streaming SSR would hang the response. Render itx consumers under an
 * `ssr: false` route or `<ClientOnly>` + `<Suspense>`.
 */

// oxlint-disable react/only-export-components -- the itx hooks are colocated with <ProjectScope> by design (see module header); this file is the whole itx React surface, not a Fast Refresh component module.
import {
  createContext,
  createElement,
  Suspense,
  use,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useQuery,
  useSuspenseQuery,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { LiveStateRpc } from "../itx-api.generated.ts";
import {
  connectIterateSession,
  connectItx,
  currentSnapshot,
  isItxTransportError,
  projectStubFor,
  releaseItxSubscription,
  reportTransportSuspicion,
  serverSnapshot,
  subscribeSession,
  watchItxSubscription,
  type ItxLiveSubscriptionHandle,
  type ProjectStub,
  type SessionStub,
} from "./itx-session.ts";
import { createLiveStateStore } from "./live-state/store.ts";

// The React entry is one-stop: everything a component file needs — hooks AND
// the imperative/keeper surface — importable from one place.
export {
  configureIterateSession,
  connectIterateSession,
  connectItx,
  isItxTransportError,
  reconnectIterateSession,
  reportTransportSuspicion,
  type Itx,
  type ItxLiveSubscriptionHandle,
  type IterateSessionConfig,
} from "./itx-session.ts";
export { createIterateQueryClient } from "./query-client.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Connection: <ProjectScope> (ambient slug + pre-warm) + useIterateSession/useItx
// ─────────────────────────────────────────────────────────────────────────────

/** The ambient project slug for `useItx()` / `useItxQuery()` — set by <ProjectScope>. */
const ProjectScopeContext = createContext<string | undefined>(undefined);

/**
 * The Session — the catalog `authenticate()` returned (`projects.list/create`,
 * admin `streams`). Suspends exactly ONCE, on first connect; a later reconnect
 * keeps returning the last session (no re-suspend — see module header).
 */
export function useIterateSession(): SessionStub {
  const snap = useSyncExternalStore(subscribeSession, currentSnapshot, serverSnapshot);
  if (snap.session !== undefined) return snap.session;
  return use(snap.connecting);
}

/**
 * The project itx for `slug` — `session.projects.get(slug)`, the real capnweb
 * stub. `slug` comes from the argument or the nearest <ProjectScope>; an
 * explicit argument wins. The returned stub's identity is stable within a socket
 * and changes once per reconnect (which re-runs effects/memos keyed on it).
 *
 *   const itx = useItx();               // ambient project (under <ProjectScope>)
 *   const itx = useItx("other-slug");   // a specific project
 *   const onSend = () => itx.chat.sendMessage(text);
 */
export function useItx(explicitSlug?: string): ProjectStub {
  // Read the scope UNCONDITIONALLY (rules-of-hooks): never behind a default arg.
  const scopedSlug = useContext(ProjectScopeContext);
  const slug = explicitSlug ?? scopedSlug;
  if (slug === undefined) {
    throw new Error(
      "useItx() needs a project: pass useItx(slug) or render under <ProjectScope slug>.",
    );
  }
  return projectStubFor(useIterateSession(), slug);
}

function SessionPrewarm() {
  useIterateSession();
  return null;
}

/**
 * Set the ambient project for a subtree AND pre-warm the one shared socket. It
 * carries the URL slug so `useItx()` / `useItxQuery()` resolve without an
 * explicit argument, and dials the socket in a SIBLING null-fallback boundary so
 * children paint immediately (each component that reads through itx suspends into
 * its own nearest boundary — usually the router's per-route `<Suspense>`).
 *
 * It never SSRs (dialing throws on the server), so mount it under an
 * `ssr: false` route (or `<ClientOnly>`). No provider wraps it: the socket is
 * module-global and every hook dials it lazily, so a component can use itx with
 * no `<ProjectScope>` above it (the sidebar, ⌘K, admin) — the scope is only the
 * ambient-slug convenience.
 */
export function ProjectScope({ slug, children }: { slug: string; children?: ReactNode }) {
  return createElement(
    ProjectScopeContext,
    { value: slug },
    createElement(Suspense, { fallback: null }, createElement(SessionPrewarm)),
    children,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reads: useItxQuery() — suspends until resolved, then stale-while-revalidate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shared TanStack retry policy for itx reads: retry ONLY transport-close
 * failures (a fresh generation is already re-dialing), briefly — application
 * errors surface immediately.
 */
const itxTransportRetry = {
  retry: (failureCount: number, error: Error) => isItxTransportError(error) && failureCount < 3,
  retryDelay: (failureCount: number) => Math.min(250 * 2 ** failureCount, 2_000),
};

/**
 * Read once through a project itx, suspending until it resolves. A thin adapter
 * over TanStack Query's `useSuspenseQuery`. `key` (prefixed with "itx"
 * internally) is the cache key — it must encode what the result is scoped to,
 * INCLUDING the project, so two projects' data can't collide: a per-project read
 * keys by the project, e.g. `["repo-files", projectId, repoPath]`. (The ambient
 * slug drives the CONNECTION, not the key — so a mutation invalidates with the
 * same `["itx", ...key]` it was written under.)
 *
 *   const files = useItxQuery({
 *     key: ["repo-files", projectId, repoPath],
 *     query: (itx) => itx.repos.get(repoPath).listFiles(),
 *   });
 *
 * The connection is resolved PER FETCH (never a render-captured stub — that
 * would pin a dead socket after a reconnect), and the per-fetch project stub is
 * disposed once the read resolves. A resolved query keeps its cached data across
 * a reconnect (no re-suspend, no spinner); only an in-flight read retries, on a
 * finite transport-only policy. Errors with no cached data throw to the nearest
 * error boundary; refetch after a mutation with
 * `queryClient.invalidateQueries({ queryKey: ["itx", ...key] })`.
 */
export function useItxQuery<T>({
  key,
  query,
}: {
  key: QueryKey;
  query: (itx: ProjectStub) => Promise<T>;
}): T {
  const slug = useContext(ProjectScopeContext);
  if (slug === undefined) {
    throw new Error("useItxQuery needs a project: render it under <ProjectScope slug>.");
  }
  return useSuspenseQuery({
    queryKey: ["itx", ...key],
    queryFn: async () => {
      const session = await connectIterateSession();
      const itx = session.projects.get(slug);
      // `return await` is load-bearing: dispose only AFTER the RPC result has
      // fully resolved (the serialized result is already pulled, so disposing
      // the short-lived stub can't invalidate it).
      try {
        return await query(itx);
      } finally {
        (itx as Partial<Disposable>)[Symbol.dispose]?.();
      }
    },
    ...itxTransportRetry,
  }).data;
}

/**
 * Read once through the SESSION (the catalog — `projects.list`, admin `streams`),
 * the session-scoped sibling of {@link useItxQuery}. NON-suspending: session
 * reads live in the always-mounted shell (sidebar, ⌘K, admin) which must not
 * suspend on the socket, so this returns the full TanStack result (`data`,
 * `isPending`, …) and accepts the usual options (`enabled`, `staleTime`). Same
 * `["itx", ...key]` namespace and the same transport-only retry as useItxQuery,
 * resolved per fetch (never a render-captured session stub).
 *
 *   const { data } = useIterateSessionQuery({ key: ["projects"], query: (s) => s.projects.list() });
 */
export function useIterateSessionQuery<T>({
  key,
  query,
  enabled,
  staleTime,
}: {
  key: QueryKey;
  query: (session: SessionStub) => Promise<T>;
  enabled?: boolean;
  staleTime?: number;
}): UseQueryResult<T> {
  return useQuery({
    queryKey: ["itx", ...key],
    queryFn: () => connectIterateSession().then(query),
    ...itxTransportRetry,
    enabled,
    staleTime,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Live subscriptions: a reconnect-aware effect
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cancellation contract an async reconnectable setup
 * runs under. `disposed` flips the moment THIS run is superseded — unmount,
 * deps change, or a reconnect re-run — and it flips BEFORE the run's own
 * cleanup executes. Everything a setup does after an `await` must be gated on
 * it: without the shared signal, a run cancelled mid-await can't know, and its
 * late continuation would overwrite the successor's state.
 */
type ItxEffectSignal = { readonly disposed: boolean };

type RootConnection<Root> = {
  key: unknown;
  connect?: () => Promise<Root>;
  missingMessage: string;
};

/**
 * Set up a live itx subscription (or any mount-scoped async itx work) and tear
 * it down on unmount. The itx is awaited INSIDE the effect (never in render),
 * so this hook NEVER suspends — and a reconnect silently re-runs the effect
 * (the effect is keyed on the session generation), whose first server push is
 * the recovery. A hand-rolled `useEffect` reaching itx through a closure would
 * omit that dep and not recover on reconnect. That generation dep is also the
 * whole retry story for a failed dial: the failing dial has already published
 * its (paced) successor, which re-runs the effect — no timer needed here.
 *
 *   useReconnectableEffect(async (itx, signal) => {
 *     const sub = await itx.streams.get("/logs").subscribe({ processEventBatch });
 *     if (signal.disposed) { sub.unsubscribe(); return; }
 *     return () => sub.unsubscribe();
 *   }, []);
 *
 * A late cleanup (setup resolved after this run was superseded) still executes.
 * `itx` resolves from `opts.slug`, else the ambient <ProjectScope>.
 * `enabled: false` renders it fully inert.
 */
function useReconnectableEffect<Root>(
  setup: (root: Root, signal: ItxEffectSignal) => Promise<void | (() => void)>,
  deps: unknown[],
  connection: RootConnection<Root>,
  opts?: {
    enabled?: boolean;
    onConnectionError?: (error: unknown) => void;
  },
): void {
  const enabled = opts?.enabled ?? true;
  // A socket death replaces the generation; that number in the deps re-runs the
  // effect on it (the reconnect recovery).
  const generation = useSyncExternalStore(
    subscribeSession,
    () => (enabled ? currentSnapshot().generation : 0),
    () => 0,
  );
  useEffect(() => {
    if (!enabled) return;
    const signal = { disposed: false };
    let cleanup: void | (() => void);
    if (connection.connect !== undefined) {
      // Await the connection INSIDE the effect: mounting never suspends the tree.
      connection.connect().then(
        (root) => {
          if (signal.disposed) return;
          setup(root, signal).then(
            (late) => {
              // Setup resolved after this run was superseded: run its cleanup now.
              if (signal.disposed) late?.();
              else cleanup = late;
            },
            (error: unknown) => {
              if (!signal.disposed) {
                console.error("reconnectable itx effect setup failed", error);
              }
            },
          );
        },
        (error: unknown) => {
          if (signal.disposed) return;
          if (opts?.onConnectionError) opts.onConnectionError(error);
          else console.error("reconnectable itx effect connect failed", error);
        },
      );
    } else {
      const error = new Error(connection.missingMessage);
      if (opts?.onConnectionError) opts.onConnectionError(error);
      else console.error(error.message);
    }
    return () => {
      signal.disposed = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connection key + caller's deps; setup/read factory are fresh per run
  }, [enabled, connection.key, generation, ...deps]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Live subscriptions: useItxSubscription() — recovery + watchdog; useLiveState()
// ─────────────────────────────────────────────────────────────────────────────

/** How long useItxSubscription waits before retrying a transport-failed subscribe. */
const SUBSCRIBE_RETRY_MS = 10_000;
/** A subscribe RPC must either establish or give recovery ownership back to the hook. */
const SUBSCRIBE_TIMEOUT_MS = 15_000;
const SUBSCRIBE_TIMED_OUT = Symbol("itx-subscribe-timed-out");

export type ItxSubscriptionStatus = "connecting" | "live" | "error";

/**
 * Hold ONE live server-push subscription for as long as the component is
 * mounted, owning the whole recovery story so consumers never hand-roll it:
 *
 *   - reconnect → re-subscribes on the fresh generation (via
 *     the reconnectable effect's generation dep; a failed dial rides
 *     the same dep — the failing dial has already published a paced successor;
 *   - SILENT death — DO restart, dropped callback, half-open TCP — → the
 *     `watchItxSubscription` watchdog re-subscribes (and, on a ping
 *     timeout, reports transport suspicion);
 *   - a TRANSPORT-failed subscribe → status "error", retried on a
 *     watchdog-shaped delay. Any other subscribe failure (auth, validation, a
 *     programming error) stays in "error" — retrying a permanent failure every
 *     ten seconds forever is a silent RPC loop, not recovery; `refresh()` or a
 *     reconnect re-runs it.
 *
 * `subscribe` opens the subscription and returns its handle; pushes go wherever
 * the caller's callbacks put them. A re-subscription's first push is the
 * recovery, so consumers must be replay-tolerant (merge by offset, or let
 * last-write-wins absorb it). On teardown the handle is unsubscribed AND
 * disposed (see {@link ItxLiveSubscriptionHandle}). `status` reads "live" while
 * established — through the sub-second gap of an invisible transport reconnect
 * it may briefly overstate (the re-run flips it to "connecting"); that bias
 * matches the no-flicker reconnect model. `refresh()` force re-subscribes;
 * `enabled: false` is inert; `deps` re-subscribe on change. `opts.slug`
 * subscribes to a specific project (e.g. ⌘K reaching a project from the app
 * shell) without suspending the tree.
 */
function useRecoveringSubscription<Root>(
  subscribe: (root: Root) => Promise<ItxLiveSubscriptionHandle>,
  deps: unknown[],
  connection: RootConnection<Root>,
  enabled = true,
): { status: ItxSubscriptionStatus; error?: string; refresh: () => void } {
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<{ status: ItxSubscriptionStatus; error?: string }>({
    status: "connecting",
  });

  // Disabling makes the whole effect inert; reset status so a subscription
  // disabled after a live period doesn't keep reporting "live".
  useEffect(() => {
    if (!enabled) setState({ status: "connecting" });
  }, [enabled]);

  useReconnectableEffect(
    async (root, signal) => {
      setState({ status: "connecting" });

      let subscription: ItxLiveSubscriptionHandle;
      try {
        const pending = subscribe(root);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          pending,
          new Promise<typeof SUBSCRIBE_TIMED_OUT>((resolve) => {
            timeout = setTimeout(() => resolve(SUBSCRIBE_TIMED_OUT), SUBSCRIBE_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timeout));
        if (result === SUBSCRIBE_TIMED_OUT) {
          // A transport can disappear after the server accepted subscribe but
          // before the browser receives its handle. No handle means no ping
          // watchdog, and a half-open WebSocket emits no close event: without
          // this bound the UI stays "connecting" forever. REPORT the suspicion
          // (never close the shared socket ourselves — the verifier two-strikes
          // and, if genuinely half-open, re-dials, whose generation re-runs this
          // effect); a straggler handle is unsubscribed AND disposed.
          void pending.then(
            (late) => releaseItxSubscription(late),
            () => {},
          );
          if (signal.disposed) return;
          reportTransportSuspicion();
          setState({
            status: "error",
            error: `itx subscription did not establish within ${SUBSCRIBE_TIMEOUT_MS}ms`,
          });
          // Retry regardless of the verifier's verdict: a wedged-but-alive
          // server (cold DO) recovers on the next attempt, not on a re-dial.
          const retry = setTimeout(() => setEpoch((current) => current + 1), SUBSCRIBE_RETRY_MS);
          return () => clearTimeout(retry);
        }
        subscription = result;
      } catch (error) {
        // The ONE cancellation signal: a run superseded mid-await (unmount,
        // deps, reconnect) must not touch state its successor now owns.
        if (signal.disposed) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        if (!isItxTransportError(error)) return;
        const retry = setTimeout(() => setEpoch((current) => current + 1), SUBSCRIBE_RETRY_MS);
        return () => clearTimeout(retry);
      }
      const dispose = () => releaseItxSubscription(subscription);
      if (signal.disposed) {
        dispose();
        return;
      }
      setState({ status: "live" });

      const stopWatchdog = watchItxSubscription(
        () => subscription.ping(),
        () => {
          if (signal.disposed) return;
          setState({ status: "connecting" });
          // Re-subscribe unconditionally. On a dead subscription the socket is
          // fine and this is the whole recovery; on a transport timeout the
          // verifier may be re-dialing, and the generation dep will also re-run
          // this effect — the epoch bump covers both, and a doubled
          // re-subscribe is idempotent.
          setEpoch((current) => current + 1);
        },
      );

      return () => {
        stopWatchdog();
        dispose();
      };
    },
    [epoch, ...deps],
    connection,
    {
      enabled,
      // A failed connect never reaches setup, so without this the hook would sit
      // on "connecting" forever. No timer: the failed dial has already published
      // a paced successor, and that generation dep re-runs the effect.
      onConnectionError: (error) => {
        setState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    },
  );

  // Stable identity: `refresh` lands in consumer deps and memoized children.
  const refresh = useCallback(() => {
    setState({ status: "connecting" });
    setEpoch((current) => current + 1);
  }, []);

  return { ...state, refresh };
}

export function useItxSubscription(
  subscribe: (itx: ProjectStub) => Promise<ItxLiveSubscriptionHandle>,
  deps: unknown[],
  opts?: { enabled?: boolean; slug?: string },
): { status: ItxSubscriptionStatus; error?: string; refresh: () => void } {
  const scopedSlug = useContext(ProjectScopeContext);
  const slug = opts?.slug ?? scopedSlug;
  return useRecoveringSubscription(
    subscribe,
    deps,
    {
      key: slug,
      ...(slug === undefined ? {} : { connect: () => connectItx(slug) }),
      missingMessage:
        "useItxSubscription needs a project: pass { slug } or render under <ProjectScope slug>.",
    },
    opts?.enabled,
  );
}

/**
 * THE live-state primitive: subscribe to any `.liveState` node, render the slice
 * you pick. The server pushes a snapshot then minimal diffs; this hook
 * reassembles them (see ./live-state/store) and hands back `selector(state)`.
 *
 *   const streams = useLiveState((itx) => itx.liveState, (s) => s.streamsIndex);
 *
 * THE SELECTOR CONTRACT — a pure function of the state, nothing else:
 * - Return a STABLE slice (`s => s.rows`), not a fresh object; map downstream.
 * - Do NOT close over props/state (`s => s.rows[props.id]`): selection is cached
 *   by STATE identity, so a closure-captured value going stale is invisible until
 *   the next push. Select the broader slice and index in render, or route the
 *   changing input through `deps`.
 *
 * `value` is `undefined` between mount and the first snapshot (one round trip);
 * render a loading row for that window. It never suspends — a reconnect keeps the
 * last value while the subscription silently re-establishes. `deps` (or a changed
 * `opts.slug`) re-point the hook at a different node, and the held value drops to
 * `undefined` immediately — the previous node's state is never shown against the
 * new one. To read a DIFFERENT project's live state from OUTSIDE its scope (⌘K in
 * the app shell), pass `opts.slug`.
 */
export function useLiveState<State, Selected = State>(
  live: (itx: ProjectStub) => LiveStateRpc<State>,
  selector: (state: State) => Selected,
  deps: unknown[] = [],
  opts?: { slug?: string; enabled?: boolean },
): {
  value: Selected | undefined;
  status: ItxSubscriptionStatus;
  error?: string;
  refresh: () => void;
} {
  const scopedSlug = useContext(ProjectScopeContext);
  const slug = opts?.slug ?? scopedSlug;
  return useLiveStateForRoot(
    live,
    selector,
    deps,
    {
      key: slug,
      ...(slug === undefined ? {} : { connect: () => connectItx(slug) }),
      missingMessage:
        "useLiveState needs a project: pass { slug } or render under <ProjectScope slug>.",
    },
    opts?.enabled,
  );
}

/** Session-scoped sibling of {@link useLiveState}, for deployment-wide live nodes. */
export function useIterateSessionLiveState<State, Selected = State>(
  live: (session: SessionStub) => LiveStateRpc<State>,
  selector: (state: State) => Selected,
  deps: unknown[] = [],
  opts?: { enabled?: boolean },
): {
  value: Selected | undefined;
  status: ItxSubscriptionStatus;
  error?: string;
  refresh: () => void;
} {
  return useLiveStateForRoot(
    live,
    selector,
    deps,
    {
      key: "session",
      connect: connectIterateSession,
      missingMessage: "useIterateSessionLiveState could not resolve the session.",
    },
    opts?.enabled,
  );
}

function useLiveStateForRoot<Root, State, Selected>(
  live: (root: Root) => LiveStateRpc<State>,
  selector: (state: State) => Selected,
  deps: unknown[],
  connection: RootConnection<Root>,
  enabled = true,
): {
  value: Selected | undefined;
  status: ItxSubscriptionStatus;
  error?: string;
  refresh: () => void;
} {
  // useState, not useMemo: the store holds the accumulated live value.
  const [store] = useState(() => createLiveStateStore<State>());
  // The node key includes the project/session connection and the caller's deps.
  // A route param change therefore cannot render the previous node's state.
  const nodeKey = [connection.key, ...deps];
  // Node change = a different node: drop the held state (its slice is
  // meaningless now).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- node identity by design
  useEffect(() => () => store.reset(), nodeKey);

  // The sink needs `refresh` to resync on a gap, but `refresh` comes from the
  // subscription below — a ref bridges the cycle (the sink only fires later).
  const refreshRef = useRef<() => void>(() => {});
  const subscription = useRecoveringSubscription(
    async (root) => {
      // The stale-sink guard: revision lines RESTART per subscription, so a
      // straggler push from a dying subscription could apply a wrong patch — or
      // read as a gap and tear the healthy subscription down. Marking the sink
      // stale on unsubscribe closes both.
      let stale = false;
      const handle = await live(root).subscribe((update) => {
        if (stale) return;
        store.apply(update, () => refreshRef.current());
      });
      return {
        ping: () => handle.ping(),
        unsubscribe: () => {
          stale = true;
          return handle.unsubscribe();
        },
        // Forward the stub release so the hook's teardown frees the capnweb
        // import-table entry (the wrapper would otherwise swallow it).
        [Symbol.dispose]: () => (handle as Partial<Disposable>)[Symbol.dispose]?.(),
      };
    },
    deps,
    connection,
    enabled,
  );
  // In an effect, not during render (a discarded concurrent render must not
  // write refs); `refresh` is stable, so this runs once.
  useEffect(() => {
    refreshRef.current = subscription.refresh;
  }, [subscription.refresh]);

  // Selector memo cache keyed on STATE identity: same `Selected` ref while state
  // is unchanged, so useSyncExternalStore bails out (and can never loop). Also
  // keyed on the NODE: the store resets in a passive effect, so the render that
  // re-points the hook could otherwise still read the previous node's state. On
  // a node switch the pre-switch state becomes a BARRIER — selection returns
  // `undefined` until the store moves past it (the reset, then the new node's
  // first push) — so the previous node's value can never render under the new.
  // Two accepted edges, both self-healing within one push: the barrier compares
  // by identity, so an old-node diff landing in the commit gap produces a fresh
  // object that slips past it for one frame (the reset then clears it); and a
  // DISCARDED concurrent render with a different key re-arms the barrier
  // against the still-current node (blanking until its next push) — a
  // blocked-until-reset latch would close both but could wedge permanently in
  // the discarded-render case, so transient-and-healing wins.
  const cache = useRef<{
    key: unknown[];
    barrier: State | undefined;
    state: State | undefined;
    value: Selected | undefined;
  }>({ key: nodeKey, barrier: undefined, state: undefined, value: undefined });
  const getSelected = () => {
    const sameNode =
      cache.current.key.length === nodeKey.length &&
      cache.current.key.every((part, index) => part === nodeKey[index]);
    if (!sameNode) {
      cache.current = {
        key: nodeKey,
        barrier: store.getState(),
        state: undefined,
        value: undefined,
      };
      return undefined;
    }
    const state = store.getState();
    if (state !== undefined && state === cache.current.barrier) return undefined;
    if (state === cache.current.state) return cache.current.value;
    cache.current.state = state;
    cache.current.value = state === undefined ? undefined : selector(state);
    return cache.current.value;
  };
  const value = useSyncExternalStore(store.subscribe, getSelected, getSelected);

  return { value, ...subscription };
}
