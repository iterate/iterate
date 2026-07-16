/**
 * itx-react — the entire React surface for itx, in one file.
 *
 * ONE WebSocket per browser tab. It dials `/api`, calls `authenticate()`, and
 * the result is a **Session** — the catalog the README's "four nouns" describe:
 * it vends project **itxs** (`session.projects.get(slug)`). Everything a
 * component needs to talk to the backend lives here: the single socket's
 * lifecycle AND the React primitives.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE PRIMITIVES
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   SESSION (the catalog authenticate() returned)
 *     useSession()            in render; suspends once on first connect
 *     connectSession()        imperative (handlers/closures); a Promise
 *
 *   ITX (a project capability handle — session.projects.get(slug))
 *     useItx(slug?)           in render; slug from the arg or <ProjectScope>
 *     connectItx(slug)        imperative; a Promise
 *
 *   READ ONCE   useItxQuery({ key, query })            suspends until resolved
 *   SUBSCRIBE   useItxSubscription((itx) => handle, deps)   live server push
 *   LIVE STATE  useLiveState((itx) => itx.liveState, selector)  snapshot + diffs
 *
 *   ACTIONS (mutations) — imperative on the handle, no extra primitive:
 *     const itx = useItx();
 *     <button onClick={() => itx.chat.sendMessage(text)} />
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SESSION MODEL — one socket, generations, invisible reconnect
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  • ONE WebSocket for the whole tab, kept in module state outside React (so it
 *    persists across client-side navigation). A dial attempt is a GENERATION
 *    (`Generation`): its WebSocket, its connecting promise, and the live
 *    `Session` stub (the pipelined `authenticate()` root, settled on WebSocket
 *    `open`). Auth rides the cookie handshake — `_app` has already gated it — so
 *    a bad cookie surfaces on the first read, like any RPC error, not here.
 *
 *  • RECONNECT IS INVISIBLE. React reads an immutable {@link Snapshot} via
 *    `useSyncExternalStore`; `snapshot.session` holds the LAST live session and
 *    is kept across a transport gap. So `useSession()` suspends exactly once
 *    (first load, on `snapshot.connecting`) and never again: when the socket
 *    dies we keep showing the last session while a fresh generation dials in the
 *    background, then swap `snapshot.session` when it opens. A dropped socket
 *    always re-dials — with a session in hand invisibly, without one by
 *    re-pointing `use()` to a fresh (backoff-paced) connecting promise, never a
 *    wedge. Reads are stale-while-revalidate (TanStack keeps cached data; only
 *    in-flight reads retry — see useItxQuery). A stray action fired during the
 *    sub-second gap rides the dead stub and rejects — the one accepted edge.
 *
 *  • PROJECT STUBS ARE SESSION-OWNED, not React-owned. `session.projects.get`
 *    allocates a capnweb import-table entry, and React may run/discard a
 *    `useMemo` during Strict Mode or an abandoned concurrent render — so
 *    memoizing the derivation there would leak undisposed stubs. Instead a
 *    module {@link projectStubCaches} WeakMap keyed by the session stub caches
 *    one real stub per (session, slug); a retired generation disposes them. The
 *    stub stays the REAL capnweb stub (a lazy wrapper that awaited the session
 *    per call would break pipelining — capnweb fork v0.8.0), and its identity
 *    changes exactly once per successful reconnect, which correctly re-runs the
 *    effects/memos keyed on it.
 *
 *  • TRANSPORT HEALTH IS SOCKET-OWNED and GENERATION-GUARDED. A half-open socket
 *    (laptop sleep, network switch — no `close` event) is detected by one
 *    verifier per generation ({@link verifyTransport}: periodic +
 *    visibility/online probes, two-strike). The mirror and the subscription
 *    watchdog REPORT suspicion ({@link reportTransportSuspicion}); they never
 *    close the shared socket themselves. Only two failed probes against the SAME
 *    generation retire it, and {@link reconnectIfCurrent} is a compare-and-swap
 *    on the generation id — a late verdict against a superseded generation can
 *    never close its healthy successor. {@link reconnectItx} is the separate,
 *    deliberate *semantic* reset (new claims after create/unlock).
 *
 *  • CONNECTING THROWS ON THE SERVER (never SSRs): a forever-pending `use()`
 *    during streaming SSR would hang the response. Render itx consumers under an
 *    `ssr: false` route or `<ClientOnly>` + `<Suspense>`.
 */

// oxlint-disable react/only-export-components -- the itx hooks are colocated with ItxProvider by design (see module header); this file is the whole itx React surface, not a Fast Refresh component module.
import {
  createContext,
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
import { useSuspenseQuery, type QueryKey } from "@tanstack/react-query";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { LiveStateRpc } from "../domains/streams/rpc-types.ts";
import type { Project, Session, UnauthenticatedOs } from "../itx-api.generated.ts";
import { createLiveStateStore } from "../lib/live-state/store.ts";

/** The Session catalog (what `authenticate()` returns): vends project itxs. */
type SessionStub = RpcStub<Session>;
/** A project capability handle — `session.projects.get(slug)`. */
type ProjectStub = RpcStub<Project>;
export type { ProjectStub as ItxReactHandle };

// ─────────────────────────────────────────────────────────────────────────────
// The one socket: a single live WebSocket per tab, kept outside React.
// ─────────────────────────────────────────────────────────────────────────────

const DIAL_TIMEOUT_MS = 15_000;
// Pacing for re-dials after a dial that closed before opening. Without it, a
// fast-REFUSING endpoint (offline after mobile resume, dev-server restart)
// loops dial → instant close → re-dial with zero delay, unbounded. The wait
// lives inside the connecting promise, so `use()` semantics are unchanged.
const REDIAL_BACKOFF_MIN_MS = 250;
const REDIAL_BACKOFF_MAX_MS = 10_000;
/** How often a live generation proves its transport is not half-open. */
const LIVENESS_PROBE_INTERVAL_MS = 45_000;
/** A probe slower than this counts as a strike (two strikes ⇒ half-open). */
const LIVENESS_PROBE_TIMEOUT_MS = 10_000;

/**
 * One dial attempt = one WebSocket lifetime. `id` is the compare-and-swap token
 * that makes every reconnect verdict identity-safe (only the CURRENT generation
 * may be retired). `session` and `connecting` are settled on WebSocket `open`
 * with the pipelined root stub (auth rides the cookie handshake; a bad cookie
 * surfaces on the first read, like any RPC error).
 */
type Generation = {
  readonly id: number;
  ws: WebSocket | undefined;
  connecting: Promise<SessionStub>;
  session: SessionStub | undefined;
  /** One cheap authenticated round trip proving the transport is alive. */
  ping: (() => Promise<void>) | undefined;
  liveness: ReturnType<typeof setInterval> | undefined;
  /** Idempotency latch: resources released once, and a re-fired close is a no-op. */
  disposed: boolean;
};

/**
 * The immutable value React reads (`useSyncExternalStore` + `use()`). Replaced
 * wholesale on every transition, always BEFORE listeners are notified, so a
 * concurrent render can never tear. `session` is the last live session and
 * survives transport gaps — that is what makes reconnect invisible. `generation`
 * is the reconnect dep for {@link useItxEffect}.
 */
type Snapshot = {
  generation: number;
  session: SessionStub | undefined;
  connecting: Promise<SessionStub>;
};

let current: Generation | undefined;
/** Last confirmed session; kept across a transport gap for invisible reconnect. */
let liveSession: SessionStub | undefined;
let snapshot: Snapshot | undefined;
let generationCounter = 0;
/** Consecutive closed-before-open dials — the re-dial backoff input. */
let consecutiveDialFailures = 0;

const listeners = new Set<() => void>();
const subscribeSession = (onChange: () => void) => {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
};

/**
 * One real project stub per (session, slug), cached OUTSIDE React so React's
 * render lifecycle can't leak undisposed capnweb import entries (see module
 * header). Keyed by the session stub identity, so it is implicitly scoped to a
 * generation and torn down with it. `slug` may be a slug or a `prj_…` id —
 * `session.projects.get` accepts either.
 */
const projectStubCaches = new WeakMap<SessionStub, Map<string, ProjectStub>>();

function projectStubFor(session: SessionStub, slug: string): ProjectStub {
  let cache = projectStubCaches.get(session);
  if (cache === undefined) {
    cache = new Map();
    projectStubCaches.set(session, cache);
  }
  let stub = cache.get(slug);
  if (stub === undefined) {
    stub = session.projects.get(slug) as unknown as ProjectStub;
    cache.set(slug, stub);
  }
  return stub;
}

/** getSnapshot for useSyncExternalStore: stable between transitions; dials when idle. */
function currentSnapshot(): Snapshot {
  // `dial()` sets `current` synchronously, so this fires at most once per idle
  // window (first load, or after a retry exhausted its own re-dial) — never a
  // per-render loop.
  if (current === undefined) dial();
  return snapshot!;
}

const serverSnapshot = (): never => {
  throw new Error(
    "itx is browser-only: it dials a WebSocket to /api and never SSRs. " +
      "Render itx consumers under an `ssr: false` route or inside <ClientOnly>.",
  );
};

/**
 * Ensure a live-or-connecting session and return its connecting promise. The
 * imperative sibling of {@link useSession}: for handlers, `mutationFn`s, and
 * lazy closures that can't call a hook. Same one socket the hooks use.
 */
export function connectSession(): Promise<SessionStub> {
  if (typeof window === "undefined") serverSnapshot();
  return (current ?? dial()).connecting;
}

/**
 * The project itx for a slug (or `prj_…` id), imperatively. Pipelines through
 * the returned promise — `(await connectItx(slug)).streams.get(path)`. Returns
 * the session-owned cached stub, re-derived automatically after a reconnect.
 */
export function connectItx(slug: string): Promise<ProjectStub> {
  return connectSession().then((session) => projectStubFor(session, slug));
}

function dial(): Generation {
  if (typeof window === "undefined") serverSnapshot();

  const id = ++generationCounter;
  const { promise, resolve, reject } = Promise.withResolvers<SessionStub>();
  // Keep an internal handler so a dial that rejects with no live awaiter never
  // surfaces as an unhandledrejection — real `connectSession()` awaiters still observe it.
  void promise.catch(() => {});
  const generation: Generation = {
    id,
    ws: undefined,
    connecting: promise,
    session: undefined,
    ping: undefined,
    liveness: undefined,
    disposed: false,
  };
  current = generation;
  // Keep showing the last session while the new generation dials (invisible
  // reconnect); `session` is undefined only before the very first connect.
  setSnapshot({ generation: id, session: liveSession, connecting: promise });

  const beginDial = () => {
    // Superseded while waiting out the backoff: this attempt no longer owns the
    // slot — settle and let the owner dial.
    if (current !== generation) {
      reject(new Error("itx WebSocket closed before connecting"));
      return;
    }
    const url = new URL("/api", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    generation.ws = ws;
    let opened = false;
    const timeout = setTimeout(() => ws.close(), DIAL_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      opened = true;
      consecutiveDialFailures = 0;
      // The pipelined, real root stub — usable immediately, no extra round trip.
      // Auth rides the session cookie on the handshake; a bad cookie surfaces on
      // the first read (like any RPC error), and `_app` middleware has already
      // gated the page's auth, so a live socket here is effectively authenticated.
      const unauthenticated = newWebSocketRpcSession<UnauthenticatedOs>(ws);
      const root = unauthenticated.authenticate({
        type: "from-server-cookie",
      }) as unknown as SessionStub;
      generation.session = root;
      generation.ping = async () => {
        // Any round trip proves the transport; authenticate rides the session
        // cookie. Dispose the probe stub so probes don't grow the cap table.
        const probe = await unauthenticated.authenticate({ type: "from-server-cookie" });
        (probe as Partial<Disposable>)[Symbol.dispose]?.();
      };
      generation.liveness = setInterval(() => {
        if (current === generation) void verifyTransport(generation);
      }, LIVENESS_PROBE_INTERVAL_MS);
      liveSession = root;
      setSnapshot({ generation: id, session: root, connecting: promise });
      resolve(root);
    });

    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      const wasCurrent = current === generation;
      // The socket is already closed — release resources WITHOUT re-closing it
      // (that would re-enter this handler). `disposed` makes it idempotent.
      disposeGeneration(generation);
      if (wasCurrent) {
        // A dial that never opened counts toward backoff; a post-open death is a
        // transient to recover from immediately.
        if (!opened) consecutiveDialFailures += 1;
        current = undefined;
        // Re-dial: with a live session in hand this is the INVISIBLE reconnect
        // (the snapshot keeps showing it); with none it re-points to a fresh
        // connecting promise so `use()` keeps suspending — a paced retry, not a
        // wedge or an error boundary.
        dial();
      }
      // Once a dial has resolved this is a no-op; a dial that closed BEFORE
      // opening rejects so imperative `connectSession()` awaiters fail fast.
      reject(new Error("itx WebSocket closed before connecting"));
    });
  };

  // The FIRST retry is immediate (a one-off blip should recover instantly);
  // pacing kicks in from the second consecutive failure — that's the storm.
  const delay =
    consecutiveDialFailures <= 1
      ? 0
      : Math.min(
          REDIAL_BACKOFF_MAX_MS,
          REDIAL_BACKOFF_MIN_MS * 2 ** Math.min(consecutiveDialFailures - 2, 6),
        );
  if (delay === 0) beginDial();
  else setTimeout(beginDial, delay);
  return generation;
}

function setSnapshot(next: Snapshot): void {
  // Replace the immutable snapshot, then wake readers — always in this order so
  // a concurrent render can't observe listeners firing against a stale value.
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Release a generation's resources — its liveness timer and cached project +
 * session stubs. Idempotent (the `disposed` latch), and it does NOT close the
 * socket, so it is safe to call from the `close` handler (the socket is already
 * gone) without re-entering it.
 */
function disposeGeneration(generation: Generation): void {
  if (generation.disposed) return;
  generation.disposed = true;
  if (generation.liveness !== undefined) clearInterval(generation.liveness);
  generation.liveness = undefined;
  if (generation.session !== undefined) {
    const cache = projectStubCaches.get(generation.session);
    if (cache) for (const stub of cache.values()) (stub as Partial<Disposable>)[Symbol.dispose]?.();
    (generation.session as Partial<Disposable>)[Symbol.dispose]?.();
  }
}

/**
 * FORCED retirement (a reconnect, not an observed close): release resources and
 * CLOSE the socket. capnweb tears the session down — rejecting every pending and
 * future call — only on transport close, and a half-open socket may never fire
 * `close` for us. Callers set `current = undefined` FIRST, so the `close` this
 * triggers won't auto-redial (re-dialing is the caller's job).
 */
function retireGeneration(generation: Generation): void {
  disposeGeneration(generation);
  generation.ws?.close();
}

/**
 * Report that the shared transport may be half-open (a call hung). The mirror
 * and the subscription watchdog call this instead of closing the socket
 * themselves — {@link verifyTransport} probes and, only on two strikes against
 * the SAME generation, retires it. A stale report is a no-op.
 */
export function reportTransportSuspicion(): void {
  const generation = current;
  // A generation still mid-dial owns its own dial timeout; nothing to verify.
  if (generation?.session === undefined || generation.ping === undefined) return;
  void verifyTransport(generation);
}

let verifying = false;

async function verifyTransport(generation: Generation): Promise<void> {
  if (verifying || current !== generation || generation.ping === undefined) return;
  verifying = true;
  try {
    const probeOnce = () =>
      Promise.race([
        generation.ping!().then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), LIVENESS_PROBE_TIMEOUT_MS),
        ),
      ]);
    // Two-strike: one slow answer is a busy server, not a dead socket.
    let alive = await probeOnce();
    if (!alive && current === generation) alive = await probeOnce();
    if (!alive) reconnectIfCurrent(generation);
  } finally {
    verifying = false;
  }
}

/**
 * Retire + re-dial the transport, but ONLY if `generation` still owns the slot —
 * the compare-and-swap that stops a late verdict (a probe that timed out on a
 * corpse) from closing the healthy successor another path already dialed.
 */
function reconnectIfCurrent(generation: Generation): void {
  if (current !== generation) return;
  current = undefined; // FIRST: the close retireGeneration triggers must not auto-redial
  retireGeneration(generation);
  dial();
}

/**
 * The SEMANTIC reset (not a transport reconnect): drop the live socket and dial
 * a fresh one so the next reads run under the browser session's CURRENT claims.
 * Call after creating a project or unlocking admin — the live socket carries the
 * connect-time principal. Callers that need already-cached data refreshed should
 * also `invalidateQueries({ queryKey: ["itx"] })`.
 */
export function reconnectItx(): void {
  const generation = current;
  if (generation !== undefined) {
    current = undefined; // FIRST: the close retireGeneration triggers must not auto-redial
    retireGeneration(generation);
  }
  dial();
}

// Baseline half-open recovery for the whole tab: on the moments transports die
// (waking a tab, coming back online), verify the current socket. Consumer-owned
// watchdogs (subscriptions) recover their lanes faster; this covers a
// query-only page whose socket nobody else probes.
if (typeof document !== "undefined") {
  const onResume = () => {
    if (document.visibilityState === "visible") reportTransportSuspicion();
  };
  document.addEventListener("visibilitychange", onResume);
  window.addEventListener("online", onResume);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Connection: <ItxProvider> (session gate) + <ProjectScope> + useSession/useItx
// ─────────────────────────────────────────────────────────────────────────────

/** The ambient project slug for `useItx()` / `useItxQuery()` — set by <ProjectScope>. */
const ProjectScopeContext = createContext<string | undefined>(undefined);

/**
 * The Session — the catalog `authenticate()` returned (`projects.list/create`,
 * admin `streams`). Suspends exactly ONCE, on first connect; a later reconnect
 * keeps returning the last session (no re-suspend — see module header).
 */
export function useSession(): SessionStub {
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
  return projectStubFor(useSession(), slug);
}

function SessionPrewarm() {
  useSession();
  return null;
}

/**
 * The session auth gate. Dials the one socket and pre-warms it in a SIBLING
 * Suspense boundary, so children paint immediately and only components that
 * actually read through itx suspend (each into its own nearest boundary). Mount
 * it once, high in the CLIENT tree — it never SSRs (dialing throws on the
 * server), so keep it under an `ssr: false` route (or `<ClientOnly>`).
 */
export function ItxProvider({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <SessionPrewarm />
      </Suspense>
      {children}
    </>
  );
}

/**
 * Set the ambient project for a subtree so `useItx()` / `useItxQuery()` resolve
 * without an explicit slug. A plain value carrier (the URL slug) — NO socket of
 * its own; the one session socket is shared. Pass the route's `params.projectSlug`.
 */
export function ProjectScope({ slug, children }: { slug: string; children: ReactNode }) {
  return <ProjectScopeContext value={slug}>{children}</ProjectScopeContext>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reads: useItxQuery() — suspends until resolved, then stale-while-revalidate
// ─────────────────────────────────────────────────────────────────────────────

/** Transport-shaped rejections that a read may retry — NOT auth/authz/validation. */
function isTransientItxTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /closed before connecting|Peer closed WebSocket|WebSocket|half-open|transport/i.test(
    message,
  );
}

/**
 * Read once through a project itx, suspending until it resolves. A thin adapter
 * over TanStack Query's `useSuspenseQuery`. The key is automatically namespaced
 * by the ambient project slug (`["itx", slug, ...key]`), so two projects' data
 * can never collide and a forgotten key can't show another project's cache.
 *
 *   const files = useItxQuery({
 *     key: ["repo-files", repoPath],
 *     query: (itx) => itx.repos.get(repoPath).listFiles(),
 *   });
 *
 * The connection is resolved PER FETCH (never a render-captured stub — that
 * would pin a dead socket after a reconnect), and the per-fetch project stub is
 * disposed once the read resolves. A resolved query keeps its cached data across
 * a reconnect (no re-suspend, no spinner); only an in-flight read retries, on a
 * finite transport-only policy. Errors with no cached data throw to the nearest
 * error boundary; refetch after a mutation with
 * `queryClient.invalidateQueries({ queryKey: ["itx", slug, ...key] })`.
 */
export function useItxQuery<T>({
  key,
  query,
  slug: slugOverride,
}: {
  key: QueryKey;
  query: (itx: ProjectStub) => Promise<T>;
  slug?: string;
}): T {
  const scopedSlug = useContext(ProjectScopeContext);
  const slug = slugOverride ?? scopedSlug;
  if (slug === undefined) {
    throw new Error(
      "useItxQuery needs a project: pass { slug } or render under <ProjectScope slug>.",
    );
  }
  const result = useSuspenseQuery({
    queryKey: ["itx", slug, ...(Array.isArray(key) ? key : [key])],
    queryFn: async () => {
      const session = await connectSession();
      const itx = session.projects.get(slug) as unknown as ProjectStub;
      // `return await` is load-bearing: dispose only AFTER the RPC result has
      // fully resolved (the serialized result is already pulled, so disposing
      // the short-lived stub can't invalidate it).
      try {
        return await query(itx);
      } finally {
        (itx as Partial<Disposable>)[Symbol.dispose]?.();
      }
    },
    retry: (failureCount, error) => isTransientItxTransportError(error) && failureCount < 3,
    retryDelay: (failureCount) => Math.min(250 * 2 ** failureCount, 2_000),
  });
  // A background-refetch failure (cached data still showing) doesn't throw —
  // surface it so a silently-stale panel is at least visible in the console.
  if (result.error && !result.isFetching) {
    console.warn("useItxQuery: background refetch failed", key, result.error);
  }
  return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Live subscriptions: useItxEffect() — a reconnect-aware itx effect
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set up a live itx subscription (or any mount-scoped itx work) and tear it down
 * on unmount. The itx is awaited INSIDE the effect (never in render), so this
 * hook NEVER suspends — the component paints its last value + status while the
 * connection resolves, and a reconnect silently re-runs the effect (the effect
 * is keyed on the session generation), whose first server push is the recovery.
 * A hand-rolled `useEffect` reaching itx through a closure would omit that dep
 * and not recover on reconnect.
 *
 *   useItxEffect((itx) => {
 *     const sub = itx.streams.get("/logs").subscribe({ processEventBatch });
 *     return () => sub.unsubscribe();
 *   }, []);
 *
 * The callback may be sync OR async; an async setup's late cleanup still runs if
 * you unmounted mid-await. `itx` resolves from `opts.itx` (a handle you hold),
 * else `opts.slug`, else the ambient <ProjectScope>. `enabled: false` renders it
 * fully inert.
 */
function useItxEffect(
  setup: (itx: ProjectStub) => void | (() => void) | Promise<void | (() => void)>,
  deps: unknown[],
  opts?: {
    itx?: ProjectStub;
    slug?: string;
    enabled?: boolean;
    onDialError?: (error: unknown) => void;
  },
): void {
  const scopedSlug = useContext(ProjectScopeContext);
  const enabled = opts?.enabled ?? true;
  const slug = opts?.slug ?? scopedSlug;
  // A socket death replaces the generation; that number in the deps re-runs the
  // effect on it (the reconnect recovery). `{ itx }` opts out — the caller owns
  // the handle's lifecycle.
  const generation = useSyncExternalStore(
    subscribeSession,
    () => (enabled && opts?.itx === undefined ? currentSnapshot().generation : 0),
    () => 0,
  );
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let cleanup: void | (() => void);
    const apply = (itx: ProjectStub) => {
      if (disposed) return;
      const result = setup(itx);
      if (result instanceof Promise) {
        // Async: cleanup lands later. If we unmounted meanwhile, run it now.
        void result.then(
          (c) => {
            if (disposed) c?.();
            else cleanup = c;
          },
          (error: unknown) => {
            if (!disposed) console.error("useItxEffect: async setup failed", error);
          },
        );
      } else {
        cleanup = result;
      }
    };
    if (opts?.itx !== undefined) {
      apply(opts.itx);
    } else if (slug !== undefined) {
      // Await the connection INSIDE the effect: mounting never suspends the tree.
      connectItx(slug).then(apply, (error: unknown) => {
        if (disposed) return;
        if (opts?.onDialError) opts.onDialError(error);
        else console.error("useItxEffect: dial failed", error);
      });
    }
    return () => {
      disposed = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connection + caller's deps; setup read fresh per run
  }, [enabled, opts?.itx, slug, generation, ...deps]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Live subscriptions: useItxSubscription() — recovery + watchdog; useLiveState()
// ─────────────────────────────────────────────────────────────────────────────

/** How often a mounted subscription verifies it is still alive server-side. */
const LIVENESS_INTERVAL_MS = 45_000;
/** A ping slower than this means the socket is half-open: report + recover. */
const LIVENESS_PING_TIMEOUT_MS = 10_000;
/** How long useItxSubscription waits before retrying a failed subscribe. */
const SUBSCRIBE_RETRY_MS = 10_000;
const PING_TIMED_OUT = Symbol("itx-ping-timed-out");

/**
 * Poll a subscription handle's `ping()` until it stops answering `true`, then
 * recover. Server pushes fail SILENTLY: a dead Durable Object or half-open TCP
 * stops delivering with no client-visible signal, so a page can show "live"
 * forever while stale. The watchdog checks on an interval and — because those
 * are exactly when sockets die — when the tab becomes visible or comes online.
 *
 *   `dead`      → ping answered `false` or REJECTED: the socket works but the
 *                 server-side subscription is gone (DO restart / dropped
 *                 callback). Recovery is a re-subscribe on the same socket.
 *   `timed-out` → ping never answered: the shared WebSocket is half-open. The
 *                 watchdog REPORTS the suspicion to the socket-owned verifier
 *                 ({@link reportTransportSuspicion}) — it never closes the socket
 *                 itself — and re-subscribes once the generation re-dials.
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
    if (reason === "timed-out") reportTransportSuspicion();
    onDead(reason);
  };

  const pingOnce = () => {
    const timeout = new Promise<typeof PING_TIMED_OUT>((resolve) =>
      setTimeout(() => resolve(PING_TIMED_OUT), LIVENESS_PING_TIMEOUT_MS),
    );
    return Promise.race([Promise.resolve(ping()), timeout]);
  };

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      let alive: boolean | typeof PING_TIMED_OUT;
      try {
        alive = await pingOnce();
        // One slow answer is a busy/cold DO, not a dead socket — two-strike.
        if (alive === PING_TIMED_OUT && !stopped) alive = await pingOnce();
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
 * and `LiveStateRpc.subscribe` both hand back `ping()` + `unsubscribe()`.
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
 *   - reconnect → re-subscribes on the fresh generation (via {@link useItxEffect}'s
 *     generation dep);
 *   - SILENT death — DO restart, dropped callback, half-open TCP — → the
 *     {@link watchItxSubscription} watchdog re-subscribes (dead) or reports
 *     transport suspicion (timed-out);
 *   - a failed subscribe (incl. a failed lazy dial) → status "error", retried on
 *     a watchdog-shaped delay.
 *
 * `subscribe` opens the subscription and returns its handle; pushes go wherever
 * the caller's callbacks put them. A re-subscription's first push is the
 * recovery, so consumers must be replay-tolerant (merge by offset, or let
 * last-write-wins absorb it). `status` is "live" only while actually
 * established; `refresh()` force re-subscribes; `enabled: false` is inert;
 * `deps` re-subscribe on change. `opts.slug` subscribes to a specific project
 * (e.g. ⌘K reaching a project from the app shell) without suspending the tree.
 */
export function useItxSubscription(
  subscribe: (itx: ProjectStub) => Promise<ItxLiveSubscriptionHandle>,
  deps: unknown[],
  opts?: { enabled?: boolean; itx?: ProjectStub; slug?: string },
): { status: ItxSubscriptionStatus; error?: string; refresh: () => void } {
  const enabled = opts?.enabled ?? true;
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<{ status: ItxSubscriptionStatus; error?: string }>({
    status: "connecting",
  });
  // The dial-error retry outlives its effect run (the failure IS the run never
  // starting), so its timer is cleared on unmount rather than by an effect cleanup.
  const dialRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(dialRetry.current), []);

  // Disabling makes the whole effect inert; reset status so a subscription
  // disabled after a live period doesn't keep reporting "live".
  useEffect(() => {
    if (!enabled) setState({ status: "connecting" });
  }, [enabled]);

  useItxEffect(
    async (effectItx) => {
      setState({ status: "connecting" });
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
          // Re-subscribe unconditionally. On "dead" the socket is fine and this
          // is the whole recovery; on "timed-out" the transport verifier may be
          // re-dialing, and the generation dep will also re-run this effect —
          // the epoch bump covers both, and a doubled re-subscribe is idempotent.
          setEpoch((current) => current + 1);
        },
      );

      return () => {
        disposed = true;
        stopWatchdog();
        dispose();
      };
    },
    [epoch, ...deps],
    {
      itx: opts?.itx,
      slug: opts?.slug,
      enabled,
      // A failed lazy dial never reaches setup, so without this the hook would
      // sit on "connecting" forever: status "error", then an epoch bump retries.
      onDialError: (error) => {
        setState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        clearTimeout(dialRetry.current);
        dialRetry.current = setTimeout(
          () => setEpoch((current) => current + 1),
          SUBSCRIBE_RETRY_MS,
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
 * THE live-state primitive: subscribe to any `.liveState` node, render the slice
 * you pick. The server pushes a snapshot then minimal diffs; this hook
 * reassembles them (see lib/live-state/store) and hands back `selector(state)`.
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
 * last value while the subscription silently re-establishes. `deps` re-point the
 * hook at a different node. To read a DIFFERENT project's live state from OUTSIDE
 * its scope (⌘K in the app shell), pass `opts.slug`.
 */
export function useLiveState<State, Selected = State>(
  live: (itx: ProjectStub) => LiveStateRpc<State>,
  selector: (state: State) => Selected,
  deps: unknown[] = [],
  opts?: { itx?: ProjectStub; slug?: string; enabled?: boolean },
): {
  value: Selected | undefined;
  status: ItxSubscriptionStatus;
  error?: string;
  refresh: () => void;
} {
  // useState, not useMemo: the store holds the accumulated live value.
  const [store] = useState(() => createLiveStateStore<State>());
  // deps change = a different node: drop the held state (its slice is meaningless now).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- caller's deps by design
  useEffect(() => () => store.reset(), deps);

  // The sink needs `refresh` to resync on a gap, but `refresh` comes from the
  // subscription below — a ref bridges the cycle (the sink only fires later).
  const refreshRef = useRef<() => void>(() => {});
  const subscription = useItxSubscription(
    async (itx) => {
      // The stale-sink guard: revision lines RESTART per subscription, so a
      // straggler push from a dying subscription could apply a wrong patch — or
      // read as a gap and tear the healthy subscription down. Marking the sink
      // stale on unsubscribe closes both.
      let stale = false;
      const handle = await live(itx).subscribe((update) => {
        if (stale) return;
        store.apply(update, () => refreshRef.current());
      });
      return {
        ping: () => handle.ping(),
        unsubscribe: () => {
          stale = true;
          return handle.unsubscribe();
        },
      };
    },
    deps,
    { itx: opts?.itx, slug: opts?.slug, enabled: opts?.enabled },
  );
  // In an effect, not during render (a discarded concurrent render must not
  // write refs); `refresh` is stable, so this runs once.
  useEffect(() => {
    refreshRef.current = subscription.refresh;
  }, [subscription.refresh]);

  // Selector memo cache keyed on STATE identity: same `Selected` ref while state
  // is unchanged, so useSyncExternalStore bails out (and can never loop).
  const cache = useRef<{ state: State | undefined; value: Selected | undefined }>({
    state: undefined,
    value: undefined,
  });
  const getSelected = () => {
    const state = store.getState();
    if (state === cache.current.state) return cache.current.value;
    cache.current = { state, value: state === undefined ? undefined : selector(state) };
    return cache.current.value;
  };
  const value = useSyncExternalStore(store.subscribe, getSelected, getSelected);

  return { value, ...subscription };
}
