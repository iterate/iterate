/**
 * `iterate/sdk/itx/react` — hooks over the framework-free session keeper in
 * ../../itx/itx-session.ts (one WebSocket per tab, generations, invisible
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
 *   CONNECT     useStreamConnection((itx) => handle, deps)  raw event batches (escape hatch)
 *   MOUNT       <ProjectScope slug>   ambient project + reconnectable Cap'n Web provider
 *
 *   ACTIONS (mutations) — imperative on the handle, no extra primitive:
 *     const itx = useItx();
 *     <button onClick={() => itx.chat.sendMessage(text)} />
 *
 * RECONNECT, AS REACT SEES IT: components read an immutable Snapshot via
 * `useSyncExternalStore`; `snapshot.session` holds the LAST live session and is
 * kept across a transport gap. So `useIterateSession()` suspends exactly once —
 * first load, on the stable first-connect promise — and never again: when the
 * socket dies we keep showing the last session while a fresh generation connects
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
  use,
  useCallback,
  useContext,
  useEffect,
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
import type { LiveStateRpc } from "../../itx-api.generated.ts";
import {
  CapnWebProvider,
  useLiveState as useCapnWebLiveState,
  type LiveStateStatus,
} from "../capnweb/react.tsx";
import {
  connectIterateSession,
  connectItx,
  currentSnapshot,
  isItxTransportError,
  projectStubFor,
  releaseItxConnection,
  reportTransportSuspicion,
  serverSnapshot,
  subscribeSession,
  watchItxConnection,
  type ItxRecoverableConnectionHandle,
  type ProjectStub,
  type SessionStub,
} from "../../itx/itx-session.ts";

// The React entry is one-stop: everything a component file needs — hooks AND
// the imperative/keeper surface — importable from one place.
export {
  configureIterateSession,
  connectIterateSession,
  connectItx,
  disconnectIterateSession,
  isItxTransportError,
  reconnectIterateSession,
  retryFailedIterateSession,
  reportTransportSuspicion,
  type Itx,
  type ItxRecoverableConnectionHandle,
  type IterateSessionConfig,
  type ProjectStub,
  type SessionStub,
} from "../../itx/itx-session.ts";
export { createIterateQueryClient } from "../../itx/query-client.ts";
export type * from "../../itx-api.generated.ts";

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

/**
 * Set the ambient project for a subtree and provide its reconnectable Cap'n Web
 * root. The project-specific layer is deliberately only a connection factory;
 * live-state ownership and recovery live in `iterate/sdk/capnweb/react`.
 *
 * The provider dials in an effect, never during render, so this context remains
 * safe to render on the server. The duplicate belongs to the provider; the
 * lower-level session keeper keeps owning and reconnecting the shared socket
 * beneath it.
 */
export function ProjectScope({ slug, children }: { slug: string; children?: ReactNode }) {
  const makeConnection = useCallback(async () => (await connectItx(slug)).dup(), [slug]);
  return createElement(
    ProjectScopeContext,
    { value: slug },
    createElement(CapnWebProvider, { makeConnection }, children),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reads: useItxQuery() — suspends until resolved, then stale-while-revalidate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shared TanStack retry policy for itx reads: retry ONLY transport-close
 * failures (a fresh generation is already reconnecting), briefly — application
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
 * The cancellation contract an async reconnectable setup runs under.
 * `disposed` flips before the run's cleanup executes. A semantic teardown
 * (unmount, disable, or dependency change) flips it immediately; a transport
 * generation change flips it only after the successor setup has completed, so
 * long-lived callbacks move make-before-break. Everything a setup does after
 * an `await` must be gated on it: without the shared signal, a cancelled run's
 * late continuation could overwrite its successor's state.
 */
type ItxEffectSignal = { readonly disposed: boolean };

type RootConnection<Root> =
  | { key: unknown; connect: () => Promise<Root> }
  | { key: unknown; connect?: undefined; missingMessage: string };

/**
 * Set up a live itx subscription (or any mount-scoped async itx work) and tear
 * it down on unmount. The itx is awaited INSIDE the effect (never in render),
 * so this hook NEVER suspends — and a reconnect silently re-runs the effect
 * (the effect is keyed on the session generation), whose first server push is
 * the recovery. A hand-rolled `useEffect` reaching itx through a closure would
 * omit that dep and not recover on reconnect. That generation dep is also the
 * whole retry story for a failed connection attempt: the failing connection attempt has already published
 * its (paced) successor, which re-runs the effect — no timer needed here.
 *
 *   useReconnectableEffect(async (itx, signal) => {
 *     const sub = await itx.streams.get("/logs").openConnection({ processEventBatch });
 *     if (signal.disposed) { sub.unsubscribe(); return; }
 *     return () => sub.unsubscribe();
 *   }, []);
 *
 * Generation changes are observed inside the semantic-lifetime effect. Its
 * active setup remains live while the successor connects and is cleaned up
 * immediately after the successor setup resolves. A late cleanup from a
 * superseded candidate still executes. `enabled: false` renders it fully inert.
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
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let observedGeneration = -1;
    let candidate: { signal: { disposed: boolean } } | undefined;
    let active: { signal: { disposed: boolean }; cleanup: void | (() => void) } | undefined;

    const startGeneration = () => {
      const generation = currentSnapshot().generation;
      if (generation === observedGeneration) return;
      observedGeneration = generation;

      // A newer socket superseded an in-flight setup. The active predecessor,
      // however, stays live until this candidate has fully opened.
      if (candidate !== undefined) candidate.signal.disposed = true;
      const run = { signal: { disposed: false } };
      candidate = run;

      if (connection.connect === undefined) {
        const error = new Error(connection.missingMessage);
        if (opts?.onConnectionError) opts.onConnectionError(error);
        else console.error(error.message);
        return;
      }

      // Await the connection INSIDE the effect: mounting never suspends the tree.
      connection.connect().then(
        (root) => {
          if (stopped || run.signal.disposed) return;
          setup(root, run.signal).then(
            (cleanup) => {
              if (stopped || run.signal.disposed || candidate !== run) {
                cleanup?.();
                return;
              }
              candidate = undefined;
              const predecessor = active;
              active = { signal: run.signal, cleanup };
              if (predecessor !== undefined) {
                predecessor.signal.disposed = true;
                predecessor.cleanup?.();
              }
            },
            (error: unknown) => {
              if (candidate === run) candidate = undefined;
              if (!stopped && !run.signal.disposed) {
                console.error("reconnectable itx effect setup failed", error);
              }
            },
          );
        },
        (error: unknown) => {
          if (candidate === run) candidate = undefined;
          if (stopped || run.signal.disposed) return;
          if (opts?.onConnectionError) opts.onConnectionError(error);
          else console.error("reconnectable itx effect connect failed", error);
        },
      );
    };

    const unsubscribe = subscribeSession(startGeneration);
    startGeneration();
    return () => {
      stopped = true;
      unsubscribe();
      if (candidate !== undefined) candidate.signal.disposed = true;
      if (active !== undefined) {
        active.signal.disposed = true;
        active.cleanup?.();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connection key + caller's deps define one semantic lifetime; setup/read factory are fresh per run
  }, [enabled, connection.key, ...deps]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Push connections: useStreamConnection() — recovery + watchdog; useLiveState()
// ─────────────────────────────────────────────────────────────────────────────

/** How long useStreamConnection waits before retrying a failed open. */
const CONNECTION_RETRY_MS = 10_000;
/** An open RPC must either establish or give recovery ownership back to the hook. */
const CONNECTION_TIMEOUT_MS = 15_000;
const CONNECTION_TIMED_OUT = Symbol("itx-connection-timed-out");

export type ItxConnectionStatus = LiveStateStatus;

/** Shared reconnect and watchdog engine behind stream and live-state push APIs. */
function useRecoveringConnection<Root>(
  open: (root: Root) => Promise<ItxRecoverableConnectionHandle>,
  deps: unknown[],
  connection: RootConnection<Root>,
  enabled = true,
): { status: ItxConnectionStatus; error?: string; refresh: () => void } {
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<{ status: ItxConnectionStatus; error?: string }>({
    status: "connecting",
  });

  // Disabling makes the whole effect inert; reset status so a connection
  // disabled after a live period doesn't keep reporting "live".
  useEffect(() => {
    if (!enabled) setState({ status: "connecting" });
  }, [enabled]);

  useReconnectableEffect(
    async (root, signal) => {
      setState({ status: "connecting" });

      let openedConnection: ItxRecoverableConnectionHandle;
      try {
        const pending = open(root);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          pending,
          new Promise<typeof CONNECTION_TIMED_OUT>((resolve) => {
            timeout = setTimeout(() => resolve(CONNECTION_TIMED_OUT), CONNECTION_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timeout));
        if (result === CONNECTION_TIMED_OUT) {
          // A transport can disappear after the server accepted the open but
          // before the browser receives its handle. No handle means no ping
          // watchdog, and a half-open WebSocket emits no close event: without
          // this bound the UI stays "connecting" forever. REPORT the suspicion
          // (never close the shared socket ourselves — the verifier two-strikes
          // and, if genuinely half-open, reconnects, whose generation re-runs this
          // effect); a straggler handle is closed AND disposed.
          void pending.then(
            (late) => releaseItxConnection(late),
            () => {},
          );
          if (signal.disposed) return;
          reportTransportSuspicion();
          // This attempt is bounded and a retry is already scheduled, so the
          // consumer remains in a recoverable connecting state rather than
          // replacing already-loaded data with terminal error UI.
          setState({ status: "connecting" });
          // Retry regardless of the verifier's verdict: a wedged-but-alive
          // server (cold DO) recovers on the next attempt, not on a reconnect.
          const retry = setTimeout(() => setEpoch((current) => current + 1), CONNECTION_RETRY_MS);
          return () => clearTimeout(retry);
        }
        openedConnection = result;
      } catch (error) {
        // The ONE cancellation signal: a run superseded mid-await (unmount,
        // deps, reconnect) must not touch state its successor now owns.
        if (signal.disposed) return;
        if (!isItxTransportError(error)) {
          setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        // Recoverable transport failures never become terminal UI errors. Keep
        // already-loaded consumers rendered while this hook retries.
        setState({ status: "connecting" });
        const retry = setTimeout(() => setEpoch((current) => current + 1), CONNECTION_RETRY_MS);
        return () => clearTimeout(retry);
      }
      const dispose = () => releaseItxConnection(openedConnection);
      if (signal.disposed) {
        dispose();
        return;
      }
      setState({ status: "live" });

      const stopWatchdog = watchItxConnection(
        () => openedConnection.ping(),
        () => {
          if (signal.disposed) return;
          setState({ status: "connecting" });
          // Open again unconditionally. When only the server-side callback
          // connection died, the shared transport is still fine and this is
          // the whole recovery; on a transport timeout the
          // verifier may be reconnecting, and the generation dep will also re-run
          // this effect — the epoch bump covers both, and a doubled
          // second open is idempotent by connection key.
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
      // on "connecting" forever. No timer: the failed connection attempt has already published
      // a paced successor, and that generation dep re-runs the effect.
      onConnectionError: (error) => {
        setState(
          isItxTransportError(error)
            ? { status: "connecting" }
            : {
                status: "error",
                error: error instanceof Error ? error.message : String(error),
              },
        );
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

/**
 * Hold one raw stream callback connection for the component's lifetime.
 * Reconnects, silent connection death, and transport-failed open attempts recover
 * through the shared watchdog; permanent failures remain in `"error"` until
 * `refresh()` or a reconnect. Reopening replays the first push, so callbacks
 * must be replay-tolerant. Teardown closes and disposes the handle.
 *
 * `enabled: false` is inert; `deps` reopen on change. `opts.slug` targets
 * a project outside the ambient {@link ProjectScope} without suspending.
 */
export function useStreamConnection(
  open: (itx: ProjectStub) => Promise<ItxRecoverableConnectionHandle>,
  deps: unknown[],
  opts?: { enabled?: boolean; slug?: string },
): { status: ItxConnectionStatus; error?: string; refresh: () => void } {
  const scopedSlug = useContext(ProjectScopeContext);
  const slug = opts?.slug ?? scopedSlug;
  return useRecoveringConnection(
    open,
    deps,
    {
      key: slug,
      ...(slug === undefined
        ? {
            missingMessage:
              "useStreamConnection needs a project: pass { slug } or render under <ProjectScope slug>.",
          }
        : { connect: () => connectItx(slug) }),
    },
    opts?.enabled,
  );
}

/**
 * THE live-state primitive: subscribe to any `.liveState` node, render the slice
 * you pick. The server pushes a snapshot then minimal diffs; this hook
 * reassembles them and hands back `selector(state)`.
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
  status: ItxConnectionStatus;
  error?: string;
  refresh: () => void;
} {
  const scopedSlug = useContext(ProjectScopeContext);
  const slug = opts?.slug ?? scopedSlug;
  const useAmbientProvider =
    scopedSlug !== undefined && (opts?.slug === undefined || slug === scopedSlug);
  const makeConnection = useCallback(async () => {
    if (slug === undefined) {
      throw new Error(
        "useLiveState needs a project: pass { slug } or render under <ProjectScope slug>.",
      );
    }
    return (await connectItx(slug)).dup();
  }, [slug]);
  return useCapnWebLiveState(
    live,
    selector,
    deps,
    useAmbientProvider ? { enabled: opts?.enabled } : { enabled: opts?.enabled, makeConnection },
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
  status: ItxConnectionStatus;
  error?: string;
  refresh: () => void;
} {
  const makeConnection = useCallback(async () => (await connectIterateSession()).dup(), []);
  return useCapnWebLiveState(live, selector, deps, { enabled: opts?.enabled, makeConnection });
}
