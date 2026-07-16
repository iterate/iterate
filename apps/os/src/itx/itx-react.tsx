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
 *     useIterateSession()            in render; suspends once on first connect
 *     connectIterateSession()        imperative (handlers/closures); a Promise
 *
 *   ITX (a project capability handle — session.projects.get(slug))
 *     useItx(slug?)           in render; slug (or prj_ id) from the arg or <ProjectScope>
 *     connectItx(slug)        imperative; a Promise
 *
 *   READ ONCE   useItxQuery({ key, query })              project read; SUSPENDS
 *               useIterateSessionQuery({ key, query })   session read; NON-suspending (shell)
 *   LIVE STATE  useLiveState((itx) => itx.liveState, selector)  snapshot + diffs; never suspends
 *   SUBSCRIBE   useItxSubscription((itx) => handle, deps)   raw event stream (escape hatch)
 *   MOUNT       <ProjectScope slug>   ambient project + socket pre-warm (no provider)
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
 *    (`Generation`): its WebSocket and its connecting promise. The session is
 *    the AWAITED `authenticate()` result — one settled stub identity shared by
 *    the snapshot, imperative awaiters, and the project-stub cache (resolving
 *    with the raw pipelined RpcPromise would fork identities: native promises
 *    assimilate thenables). The dial timeout spans the whole handshake
 *    (TCP/TLS/upgrade AND authenticate), and a REAL auth rejection over a
 *    working socket is terminal — it surfaces from the connecting promise
 *    instead of looping.
 *
 *  • RECONNECT IS INVISIBLE. React reads an immutable {@link Snapshot} via
 *    `useSyncExternalStore`; `snapshot.session` holds the LAST live session and
 *    is kept across a transport gap. So `useIterateSession()` suspends exactly
 *    once — first load, on the STABLE {@link firstConnect} promise, which
 *    survives failed dial attempts (paced re-dials happen behind it; a per-dial
 *    rejection never reaches the suspended tree) — and never again: when the
 *    socket dies we keep showing the last session while a fresh generation
 *    dials in the background, then swap `snapshot.session` when it establishes.
 *    TanStack keeps cached read data through a reconnect (no re-suspend, no
 *    spinner); only an in-flight read retries, on the transport-only policy —
 *    see useItxQuery. A stray action fired during the sub-second gap rides the
 *    dead stub and rejects — the one accepted edge.
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
 *    on generation OBJECT IDENTITY — a late verdict against a superseded
 *    generation can never close its healthy successor. {@link reconnectIterateSession}
 *    is the separate, deliberate *semantic* reset (new claims after create/unlock).
 *
 *  • CONNECTING THROWS ON THE SERVER (never SSRs): a forever-pending `use()`
 *    during streaming SSR would hang the response. Render itx consumers under an
 *    `ssr: false` route or `<ClientOnly>` + `<Suspense>`.
 */

// oxlint-disable react/only-export-components -- the itx hooks are colocated with <ProjectScope> by design (see module header); this file is the whole itx React surface, not a Fast Refresh component module.
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
import {
  useQuery,
  useSuspenseQuery,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { LiveStateRpc } from "../domains/streams/rpc-types.ts";
import type { Project, Session, UnauthenticatedOs } from "../itx-api.generated.ts";
import { createLiveStateStore } from "../lib/live-state/store.ts";

// A handle is a capnweb `RpcStub` — a chainable proxy over the contract
// interface. `authenticate()` / `projects.get()` return an `RpcPromise` (a stub
// that is *also* awaitable); an RpcPromise is assignable to the plain RpcStub,
// so the pipelined calls narrow to these without a cast. `RpcStub<Session>` (not
// the awaitable RpcPromise) keeps `Promise<SessionStub>` from nesting.

/** The Session catalog (what `authenticate()` returns): vends project itxs. */
type SessionStub = RpcStub<Session>;
/** A project capability handle — `session.projects.get(slug)`. */
type ProjectStub = RpcStub<Project>;
export type { ProjectStub as Itx };

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
/**
 * How often a live transport (the socket verifier) and a mounted subscription
 * (the watchdog) prove they are not silently dead. ONE shared cadence: the two
 * lanes are deliberately coordinated, so a change here moves both.
 */
const LIVENESS_INTERVAL_MS = 45_000;
/** A probe slower than this counts as a strike (two strikes ⇒ half-open). */
const LIVENESS_TIMEOUT_MS = 10_000;

/**
 * One dial attempt = one WebSocket lifetime. OBJECT IDENTITY is the
 * compare-and-swap token that makes every reconnect verdict identity-safe
 * (`current === generation` — only the CURRENT generation may be retired or
 * published). `connecting` settles with the session once `authenticate()`
 * returns over the open socket; `ping` doubles as the "session established"
 * marker.
 */
type Generation = {
  ws: WebSocket | undefined;
  connecting: Promise<SessionStub>;
  /** One cheap authenticated round trip proving the transport is alive. */
  ping: (() => Promise<void>) | undefined;
  liveness: ReturnType<typeof setInterval> | undefined;
  /** Single-flight latch for {@link verifyTransport}, per generation. */
  verifying: boolean;
  /**
   * PARKED after a terminal auth rejection: the generation keeps owning the
   * slot (so a render can never trigger a fresh dial — every re-render of an
   * always-mounted hook reads {@link currentSnapshot}, which dials when the
   * slot is empty, and the failure's own setState re-renders: an unbounded
   * socket storm otherwise) and its close handler must not redial. Only an
   * explicit {@link reconnectIterateSession} (or a page load) revives.
   */
  failed: boolean;
};

/**
 * The immutable value React reads (`useSyncExternalStore` + `use()`). Replaced
 * wholesale on every transition, always BEFORE listeners are notified, so a
 * concurrent render can never tear. `session` is the last live session and
 * survives transport gaps — that is what makes reconnect invisible. `generation`
 * is a monotonic number whose only job is being the reconnect dep for
 * {@link useReconnectableItxEffect} (the CAS is generation object identity, not
 * this number). `connecting` is what `useIterateSession` suspends on: before the
 * FIRST session it is the stable {@link firstConnect} promise (survives
 * closed-before-open retries without rejecting the suspended tree); afterwards
 * `use()` never runs again, because `session` is always defined.
 */
type Snapshot = {
  generation: number;
  session: SessionStub | undefined;
  connecting: Promise<SessionStub>;
};

let current: Generation | undefined;
let snapshot: Snapshot | undefined;
let generationCounter = 0;
/** Consecutive dials that died before establishing a session — the backoff input. */
let consecutiveDialFailures = 0;
/**
 * The promise `use()` suspends on until the FIRST session exists. One stable
 * promise across dial retries: a dial that closes before opening rejects its
 * own per-dial `connecting` (imperative awaiters fail fast) but must NOT reject
 * the suspended tree — React replays a suspended (never-committed) component
 * against the thenable it first used, so a rejected first promise would surface
 * in the error boundary even though a paced re-dial is already underway. It
 * rejects only on a TERMINAL failure (authenticate answered with a real
 * application error over a working socket).
 */
let firstConnect: PromiseWithResolvers<SessionStub> | undefined;

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
    stub = session.projects.get(slug);
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
 * imperative sibling of {@link useIterateSession}: for handlers, `mutationFn`s, and
 * lazy closures that can't call a hook. Same one socket the hooks use. After a
 * TERMINAL auth rejection this keeps returning that failure (the parked
 * generation — see Generation.failed) until {@link reconnectIterateSession}.
 */
export function connectIterateSession(): Promise<SessionStub> {
  if (typeof window === "undefined") serverSnapshot();
  return (current ?? dial()).connecting;
}

/**
 * The project itx for a slug (or `prj_…` id), imperatively. Pipelines through
 * the returned promise — `(await connectItx(slug)).streams.get(path)`. Returns
 * the session-owned cached stub, re-derived automatically after a reconnect.
 */
export function connectItx(slug: string): Promise<ProjectStub> {
  return connectIterateSession().then((session) => projectStubFor(session, slug));
}

function dial(): Generation {
  if (typeof window === "undefined") serverSnapshot();

  const id = ++generationCounter;
  const { promise, resolve, reject } = Promise.withResolvers<SessionStub>();
  // Keep an internal handler so a dial that rejects with no live awaiter never
  // surfaces as an unhandledrejection — real `connectIterateSession()` awaiters still observe it.
  void promise.catch(() => {});
  const generation: Generation = {
    ws: undefined,
    connecting: promise,
    ping: undefined,
    liveness: undefined,
    verifying: false,
    failed: false,
  };
  current = generation;
  // Keep showing the last session while the new generation dials (invisible
  // reconnect). Before the FIRST session, `use()` must suspend on the stable
  // first-connect promise (see {@link firstConnect}) — never a per-dial promise
  // whose closed-before-open rejection React would replay into an error boundary.
  const priorSession = snapshot?.session;
  if (priorSession === undefined && firstConnect === undefined) {
    firstConnect = Promise.withResolvers<SessionStub>();
    void firstConnect.promise.catch(() => {});
  }
  setSnapshot({
    generation: id,
    session: priorSession,
    connecting: firstConnect?.promise ?? promise,
  });

  /** The dial established a session: publish it and retire the predecessor. */
  const publish = (root: SessionStub, ping: () => Promise<void>) => {
    consecutiveDialFailures = 0;
    generation.ping = ping;
    generation.liveness = setInterval(() => {
      if (current === generation) void verifyTransport(generation);
    }, LIVENESS_INTERVAL_MS);
    // Retire the PREVIOUS published session — exactly once, now that its
    // successor is live. It was kept alive through the reconnect gap so
    // useIterateSession()/useItx() never handed out a disposed stub; dispose its
    // project-stub cache + the stub itself only here.
    //
    // Safe even though this runs the same turn as setSnapshot (before React
    // commits the re-render whose subscription cleanups unsubscribe): a
    // successor only dials after `current` was cleared, and every path clears
    // it AFTER closing the prior socket (the close handler, reconnectIfCurrent,
    // reconnectIterateSession). So the prior transport is ALWAYS already closed
    // here — its subscriptions are already dead (capnweb rejects on close) and
    // their unsubscribe cleanups are catch-wrapped. This releases already-dead
    // local refs, never a live subscription.
    const retiring = snapshot?.session;
    setSnapshot({ generation: id, session: root, connecting: promise });
    resolve(root);
    firstConnect?.resolve(root);
    firstConnect = undefined;
    if (retiring !== undefined) disposeSession(retiring);
  };

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
    let established = false;
    // The timeout spans the WHOLE dial — TCP/TLS/upgrade AND the authenticate
    // round trip — so a server that accepts the socket but never answers
    // authenticate is a failed dial (close → paced re-dial), not a wedge.
    const timeout = setTimeout(() => ws.close(), DIAL_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      // Generation CAS: a superseded generation's late `open` (its successor was
      // already dialed) must never publish over the live one. Close and bail.
      if (current !== generation) {
        clearTimeout(timeout);
        ws.close();
        return;
      }
      // ONE awaited authenticate: its result is THE session identity — the same
      // settled stub for the snapshot, the imperative promise, and the
      // project-stub cache. (Resolving with the raw pipelined RpcPromise would
      // fork identities: a native promise ASSIMILATES a thenable, so imperative
      // awaiters would receive the pulled resolution while the snapshot held the
      // RpcPromise — two WeakMap keys, doubled project stubs, and a
      // disposeSession that misses half of them.) Auth rides the session cookie
      // on the handshake; `_app` middleware has already gated the page.
      const unauthenticated = newWebSocketRpcSession<UnauthenticatedOs>(ws);
      void (async () => {
        let root: SessionStub;
        try {
          // The runtime value IS a session stub (same callable surface); the
          // cast bridges capnweb's Awaited-type nesting (`Stubify<Session>`
          // re-wraps every member in promise types) back to the nominal handle.
          // This is the module's ONE cast, at the identity boundary.
          root = (await unauthenticated.authenticate({
            type: "from-server-cookie",
          })) as unknown as SessionStub;
        } catch (error) {
          clearTimeout(timeout);
          if (current !== generation) return;
          if (isItxTransportError(error)) {
            // The socket died mid-handshake; the close handler owns recovery.
            ws.close();
            return;
          }
          // The server ANSWERED with a real application error (bad principal,
          // rejected handshake): this dial is terminally failed. Surface it to
          // imperative awaiters AND the suspended tree — retrying would loop.
          // Reject BEFORE closing: the close handler's generic dial-close
          // rejection must never mask the real error. Then PARK: the failed
          // generation keeps owning the slot (see Generation.failed) so a
          // render can't storm fresh dials; publish the parked snapshot so
          // effects observe one final generation and settle in "error".
          const terminal = error instanceof Error ? error : new Error(String(error));
          generation.failed = true;
          reject(terminal);
          firstConnect?.reject(terminal);
          firstConnect = undefined;
          setSnapshot({ generation: id, session: snapshot?.session, connecting: promise });
          retireGeneration(generation);
          return;
        }
        clearTimeout(timeout);
        if (current !== generation) {
          // Superseded while authenticating: never publish; release the stub.
          (root as Partial<Disposable>)[Symbol.dispose]?.();
          ws.close();
          return;
        }
        established = true;
        publish(root, async () => {
          // Any round trip proves the transport; authenticate rides the session
          // cookie. Dispose the probe stub so probes don't grow the cap table.
          const probe = await unauthenticated.authenticate({ type: "from-server-cookie" });
          (probe as Partial<Disposable>)[Symbol.dispose]?.();
        });
      })();
    });

    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      // A PARKED generation stays the owner: its socket closing must not
      // redial (that would restart the terminal-auth loop it exists to stop).
      const wasCurrent = current === generation && !generation.failed;
      // The socket is already closed — release resources WITHOUT re-closing it
      // (that would re-enter this handler); disposeGeneration is idempotent.
      disposeGeneration(generation);
      if (wasCurrent) {
        // A dial that never established a session counts toward backoff; a
        // post-establish death is a transient to recover from immediately.
        if (!established) consecutiveDialFailures += 1;
        current = undefined;
        // Re-dial: with a live session in hand this is the INVISIBLE reconnect
        // (the snapshot keeps showing it); with none it keeps `use()` suspended
        // on the stable first-connect promise — a paced retry, never a wedge or
        // an error boundary.
        dial();
      }
      // Once a dial has resolved this is a no-op; a dial that closed BEFORE
      // establishing rejects so imperative `connectIterateSession()` awaiters fail fast.
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
 * Release a generation's TRANSPORT resources — its liveness timer. Naturally
 * idempotent, and it does NOT close the socket or dispose the session stub: the
 * session is retired separately, by its successor's publish (see the open
 * handler), so invisible reconnect never hands out a disposed stub. Safe to
 * call from the `close` handler without re-entering it.
 */
function disposeGeneration(generation: Generation): void {
  if (generation.liveness !== undefined) clearInterval(generation.liveness);
  generation.liveness = undefined;
}

/** Dispose a retired session's project-stub cache and the session stub itself. */
function disposeSession(session: SessionStub): void {
  const cache = projectStubCaches.get(session);
  if (cache) for (const stub of cache.values()) (stub as Partial<Disposable>)[Symbol.dispose]?.();
  (session as Partial<Disposable>)[Symbol.dispose]?.();
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
  if (generation?.ping === undefined) return;
  void verifyTransport(generation);
}

async function verifyTransport(generation: Generation): Promise<void> {
  // Single-flight PER GENERATION, not process-wide: a probe still racing on a
  // retired generation (its ping hung and never settled) must not block
  // verifying the fresh successor.
  if (generation.verifying || current !== generation || generation.ping === undefined) return;
  generation.verifying = true;
  try {
    // A probe is a STRIKE only when the transport itself failed — a timeout, or
    // a rejection classified as a transport close. Any other rejection means the
    // socket ANSWERED (an application/auth error came back over it), so the
    // transport is alive. Rejections are caught here, never left unhandled.
    const probeOnce = (): Promise<"alive" | "strike"> =>
      Promise.race([
        generation.ping!().then(
          () => "alive" as const,
          (error: unknown) =>
            (isItxTransportError(error) ? "strike" : "alive") as "alive" | "strike",
        ),
        new Promise<"strike">((resolve) =>
          setTimeout(() => resolve("strike"), LIVENESS_TIMEOUT_MS),
        ),
      ]);
    // Two-strike: one slow answer is a busy server, not a dead socket.
    let verdict = await probeOnce();
    if (verdict === "strike" && current === generation) verdict = await probeOnce();
    if (verdict === "strike") reconnectIfCurrent(generation);
  } finally {
    generation.verifying = false;
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
export function reconnectIterateSession(): void {
  const generation = current;
  if (generation !== undefined) {
    current = undefined; // FIRST: the close retireGeneration triggers must not auto-redial
    retireGeneration(generation);
  }
  // A deliberate reset dials NOW: clear any backoff inherited from earlier
  // closed-before-open failures so the new-claims socket doesn't wait out a
  // transient storm that's already irrelevant.
  consecutiveDialFailures = 0;
  dial();
}

// Baseline half-open recovery for the whole tab: on the moments transports die
// (waking a tab, coming back online), verify the current socket. Consumer-owned
// watchdogs (subscriptions) recover their lanes faster; this covers a
// query-only page whose socket nobody else probes.
if (typeof document !== "undefined") {
  // Becoming visible → verify (a tab going hidden shouldn't trigger a probe).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reportTransportSuspicion();
  });
  // Connectivity returning → verify UNCONDITIONALLY: a backgrounded tab must
  // recover a half-open socket when the network comes back, not wait for focus.
  window.addEventListener("online", () => reportTransportSuspicion());
}

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
export function ProjectScope({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <ProjectScopeContext value={slug}>
      <Suspense fallback={null}>
        <SessionPrewarm />
      </Suspense>
      {children}
    </ProjectScopeContext>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reads: useItxQuery() — suspends until resolved, then stale-while-revalidate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three — and only three — transport-close rejections a caller may treat as
 * "the socket died, retry on a fresh one": our own dial-close reject, and
 * capnweb's two aborts when the WebSocket dies (`Peer closed WebSocket:
 * <code> <reason>` after a close frame, `WebSocket connection failed.` on an
 * error event — both capnweb `websocket.ts`). Deliberately NARROW: an
 * application/auth/validation error that merely mentions "WebSocket" must never
 * be mistaken for a transport failure and retried. This is the one discriminant
 * shared by the query retry, the subscribe retry, and the liveness verifier.
 */
export function isItxTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("itx WebSocket closed before connecting") ||
    message.includes("Peer closed WebSocket") ||
    message.includes("WebSocket connection failed")
  );
}

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
// 3. Live subscriptions: useReconnectableItxEffect() — a reconnect-aware effect
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cancellation contract an async {@link useReconnectableItxEffect} setup
 * runs under. `disposed` flips the moment THIS run is superseded — unmount,
 * deps change, or a reconnect re-run — and it flips BEFORE the run's own
 * cleanup executes. Everything a setup does after an `await` must be gated on
 * it: without the shared signal, a run cancelled mid-await can't know, and its
 * late continuation would overwrite the successor's state.
 */
type ItxEffectSignal = { readonly disposed: boolean };

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
 *   useReconnectableItxEffect(async (itx, signal) => {
 *     const sub = await itx.streams.get("/logs").subscribe({ processEventBatch });
 *     if (signal.disposed) { sub.unsubscribe(); return; }
 *     return () => sub.unsubscribe();
 *   }, []);
 *
 * A late cleanup (setup resolved after this run was superseded) still executes.
 * `itx` resolves from `opts.slug`, else the ambient <ProjectScope>.
 * `enabled: false` renders it fully inert.
 */
function useReconnectableItxEffect(
  setup: (itx: ProjectStub, signal: ItxEffectSignal) => Promise<void | (() => void)>,
  deps: unknown[],
  opts?: {
    slug?: string;
    enabled?: boolean;
    onConnectionError?: (error: unknown) => void;
  },
): void {
  const scopedSlug = useContext(ProjectScopeContext);
  const enabled = opts?.enabled ?? true;
  const slug = opts?.slug ?? scopedSlug;
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
    if (slug !== undefined) {
      // Await the connection INSIDE the effect: mounting never suspends the tree.
      connectItx(slug).then(
        (itx) => {
          if (signal.disposed) return;
          setup(itx, signal).then(
            (late) => {
              // Setup resolved after this run was superseded: run its cleanup now.
              if (signal.disposed) late?.();
              else cleanup = late;
            },
            (error: unknown) => {
              if (!signal.disposed) {
                console.error("useReconnectableItxEffect: setup failed", error);
              }
            },
          );
        },
        (error: unknown) => {
          if (signal.disposed) return;
          if (opts?.onConnectionError) opts.onConnectionError(error);
          else console.error("useReconnectableItxEffect: connect failed", error);
        },
      );
    } else {
      // No resolvable project: fail loudly rather than sit on "connecting"
      // forever (a subscription with no <ProjectScope>).
      const error = new Error(
        "useReconnectableItxEffect needs a project: pass { slug } or render under <ProjectScope slug>.",
      );
      if (opts?.onConnectionError) opts.onConnectionError(error);
      else console.error(error.message);
    }
    return () => {
      signal.disposed = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connection + caller's deps; setup read fresh per run
  }, [enabled, slug, generation, ...deps]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Live subscriptions: useItxSubscription() — recovery + watchdog; useLiveState()
// ─────────────────────────────────────────────────────────────────────────────

/** How long useItxSubscription waits before retrying a transport-failed subscribe. */
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
  onDead: () => void,
): () => void {
  let stopped = false;
  let checking = false;

  // The reason stays internal: on "timed-out" the watchdog itself reports the
  // transport suspicion; either way the caller's only move is a re-subscribe.
  const report = (reason: "dead" | "timed-out") => {
    if (stopped) return;
    stop();
    if (reason === "timed-out") reportTransportSuspicion();
    onDead();
  };

  const pingOnce = () => {
    const timeout = new Promise<typeof PING_TIMED_OUT>((resolve) =>
      setTimeout(() => resolve(PING_TIMED_OUT), LIVENESS_TIMEOUT_MS),
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

  // Becoming visible → check (going hidden shouldn't). Connectivity returning →
  // check UNCONDITIONALLY, so a backgrounded tab holding a live subscription
  // recovers a half-open socket when the network comes back, not on next focus.
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  const onOnline = () => void check();
  const interval = setInterval(() => void check(), LIVENESS_INTERVAL_MS);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
  };
  return stop;
}

/**
 * The live handle shape every itx subscription API returns — `Stream.subscribe`
 * and `LiveStateRpc.subscribe` both hand back `ping()` + `unsubscribe()`. The
 * real handles are capnweb stubs and therefore Disposable: `unsubscribe()`
 * closes the SERVER side, `[Symbol.dispose]` releases the caller-owned stub —
 * on the tab-long shared socket, skipping the dispose leaks one import-table
 * entry per subscribe cycle, so the hook always does both.
 */
export type ItxLiveSubscriptionHandle = {
  ping(): boolean | Promise<boolean>;
  unsubscribe(): unknown;
  [Symbol.dispose]?(): void;
};

export type ItxSubscriptionStatus = "connecting" | "live" | "error";

/**
 * Hold ONE live server-push subscription for as long as the component is
 * mounted, owning the whole recovery story so consumers never hand-roll it:
 *
 *   - reconnect → re-subscribes on the fresh generation (via
 *     {@link useReconnectableItxEffect}'s generation dep); a failed dial rides
 *     the same dep — the failing dial has already published a paced successor;
 *   - SILENT death — DO restart, dropped callback, half-open TCP — → the
 *     {@link watchItxSubscription} watchdog re-subscribes (and, on a ping
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
export function useItxSubscription(
  subscribe: (itx: ProjectStub) => Promise<ItxLiveSubscriptionHandle>,
  deps: unknown[],
  opts?: { enabled?: boolean; slug?: string },
): { status: ItxSubscriptionStatus; error?: string; refresh: () => void } {
  const enabled = opts?.enabled ?? true;
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<{ status: ItxSubscriptionStatus; error?: string }>({
    status: "connecting",
  });

  // Disabling makes the whole effect inert; reset status so a subscription
  // disabled after a live period doesn't keep reporting "live".
  useEffect(() => {
    if (!enabled) setState({ status: "connecting" });
  }, [enabled]);

  useReconnectableItxEffect(
    async (effectItx, signal) => {
      setState({ status: "connecting" });

      let subscription: ItxLiveSubscriptionHandle;
      try {
        subscription = await subscribe(effectItx);
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
      const dispose = () =>
        void Promise.resolve()
          .then(() => subscription.unsubscribe())
          .catch(() => {
            // The server side of a dead subscription is already gone.
          })
          .finally(() => subscription[Symbol.dispose]?.());
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
    {
      slug: opts?.slug,
      enabled,
      // A failed connect never reaches setup, so without this the hook would sit
      // on "connecting" forever. No timer: the failed dial has already published
      // a paced successor generation, and that dep re-runs the effect.
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
  // useState, not useMemo: the store holds the accumulated live value.
  const [store] = useState(() => createLiveStateStore<State>());
  // The node this hook points at — the caller's deps AND the EFFECTIVE project
  // (exactly what re-points the subscription): `opts.slug` if given, else the
  // ambient <ProjectScope>. The ambient slug matters — the router does NOT
  // remount route components on param-only navigation, so /projects/a/repos →
  // /projects/b/repos changes the scope under a mounted hook, and without it
  // in the key project A's state would render under project B until B's first
  // push.
  const scopedSlug = useContext(ProjectScopeContext);
  const nodeKey = [opts?.slug ?? scopedSlug, ...deps];
  // Node change = a different node: drop the held state (its slice is
  // meaningless now).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- node identity by design
  useEffect(() => () => store.reset(), nodeKey);

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
        // Forward the stub release so the hook's teardown frees the capnweb
        // import-table entry (the wrapper would otherwise swallow it).
        [Symbol.dispose]: () => (handle as Partial<Disposable>)[Symbol.dispose]?.(),
      };
    },
    deps,
    { slug: opts?.slug, enabled: opts?.enabled },
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
