/**
 * itx-session — the framework-free half of the itx client: ONE WebSocket per
 * process (browser tab, TUI, phone), dialed to an OS deployment's `/api`,
 * `authenticate()`d into a **Session** (the catalog that vends project itxs via
 * `session.projects.get(slug)`), and kept alive through transport gaps.
 *
 * React never appears in this module. The hooks in ../sdk/itx/react.ts are a thin
 * binding over the exact surface exported here (`subscribeSession` +
 * `currentSnapshot` feed `useSyncExternalStore`; everything else is shared
 * verbatim), so a non-React consumer — a node script, a future runtime —
 * gets the same one-socket semantics by importing `iterate/client`.
 *
 * WHERE THE CONNECTION TARGET COMES FROM
 *   • In a browser, nothing to configure: the keeper dials
 *     `window.location`'s `/api` and authenticates with the session cookie
 *     riding the WebSocket handshake.
 *   • Anywhere else (the chat TUI, tests, scripts that want the KEEPER rather
 *     than the one-shot node dial), call {@link configureIterateSession} with a
 *     base URL and credentials. Calling it again for the same deployment
 *     refreshes the credential source without disturbing the socket; changing
 *     deployments deliberately replaces the socket. The runtime's global
 *     WebSocket carries the dial — node ≥ 22, bun, and React Native all satisfy
 *     capnweb's WebSocket needs.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SESSION MODEL — one socket, generations, invisible reconnect
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  • ONE WebSocket for the whole process, kept in module state (so in a
 *    browser it persists across client-side navigation). A dial attempt is a
 *    GENERATION ({@link Generation}): its WebSocket and its connecting
 *    promise. The session is the AWAITED `authenticate()` result — one settled
 *    stub identity shared by the snapshot, imperative awaiters, and the
 *    project-stub cache (resolving with the raw pipelined RpcPromise would
 *    fork identities: native promises assimilate thenables). The dial timeout
 *    spans the whole handshake (TCP/TLS/upgrade AND authenticate), and a REAL
 *    auth rejection over a working socket is terminal — it surfaces from the
 *    connecting promise instead of looping.
 *
 *  • RECONNECT IS INVISIBLE. Readers see an immutable {@link Snapshot};
 *    `snapshot.session` holds the LAST live session and is kept across a
 *    transport gap. Before the FIRST session, awaiters share the STABLE
 *    {@link firstConnect} promise, which survives failed dial attempts (paced
 *    re-dials happen behind it; a per-dial rejection never reaches a suspended
 *    React tree) and rejects only on a TERMINAL failure. Kept-across-the-gap
 *    applies to TRANSPORT gaps only: a terminal auth rejection on a redial is
 *    an AUTHORITY loss — the parked snapshot drops the (already dead) session
 *    so the real error surfaces instead of zombie stubs.
 *
 *  • PROJECT STUBS ARE SESSION-OWNED. `session.projects.get` allocates a
 *    capnweb import-table entry, so deriving stubs ad hoc (or inside React
 *    renders that may be discarded) would leak them. The module
 *    {@link projectStubCaches} WeakMap keyed by the session stub caches one
 *    real stub per (session, slug); a retired generation disposes them. The
 *    stub stays the REAL capnweb stub (a lazy wrapper that awaited the session
 *    per call would break pipelining — capnweb fork v0.8.0), and its identity
 *    changes exactly once per successful reconnect.
 *
 *  • TRANSPORT HEALTH IS SOCKET-OWNED and GENERATION-GUARDED. A half-open
 *    socket (laptop sleep, network switch — no `close` event) is detected by
 *    one verifier per generation ({@link verifyTransport}: periodic +
 *    visibility/online probes, two-strike). Consumers REPORT suspicion
 *    ({@link reportTransportSuspicion}); they never close the shared socket
 *    themselves. Only two failed probes against the SAME generation retire it,
 *    and {@link reconnectIfCurrent} is a compare-and-swap on generation OBJECT
 *    IDENTITY — a late verdict against a superseded generation can never close
 *    its healthy successor. {@link reconnectIterateSession} is the separate,
 *    deliberate *semantic* reset (new claims after create/unlock).
 */
import { newWebSocketRpcSession, type RpcStub } from "@iterate-com/capnweb";
import type {
  ItxAuthCredentials,
  Project,
  Session,
  UnauthenticatedOs,
} from "../itx-api.generated.ts";
import { apiWebSocketUrl } from "./api-url.ts";

// A handle is a capnweb `RpcStub` — a chainable proxy over the contract
// interface. `authenticate()` / `projects.get()` return an `RpcPromise` (a stub
// that is *also* awaitable); an RpcPromise is assignable to the plain RpcStub,
// so the pipelined calls narrow to these without a cast. `RpcStub<Session>` (not
// the awaitable RpcPromise) keeps `Promise<SessionStub>` from nesting.

/** The Session catalog (what `authenticate()` returns): vends project itxs. */
export type SessionStub = RpcStub<Session>;
/** A project capability handle — `session.projects.get(slug)`. */
export type ProjectStub = RpcStub<Project>;
export type { ProjectStub as Itx };

// ─────────────────────────────────────────────────────────────────────────────
// The connection target: browser defaults, or an explicit configuration.
// ─────────────────────────────────────────────────────────────────────────────

export type IterateSessionConfig = {
  /** OS deployment base URL, e.g. `https://os.iterate.com`; `/api` is appended. */
  baseUrl: string;
  /**
   * How `authenticate()` identifies the caller. A provider is resolved for
   * every dial, so rotating credentials stay fresh across transport reconnects.
   * If authentication rejects with an auth-shaped error, providers get one
   * forced-refresh attempt before the failure becomes terminal. Default: the
   * browser session cookie.
   */
  credentials?:
    | ItxAuthCredentials
    | ((options: { forceRefresh: boolean }) => ItxAuthCredentials | Promise<ItxAuthCredentials>);
};

let explicitConfig: IterateSessionConfig | undefined;

/**
 * Point the keeper at a deployment explicitly — the non-browser entry into the
 * one-socket model (the chat TUI, React Native, keeper-based scripts). Repeating
 * the same target updates its credential source without disturbing the live
 * socket. A different target retires the old deployment immediately and dials
 * the new one, so authority can never cross deployments. In a browser this is
 * optional (the default is `window.location`'s `/api` with cookie auth).
 */
export function configureIterateSession(config: IterateSessionConfig): void {
  const targetChanged =
    explicitConfig !== undefined &&
    apiWebSocketUrl(explicitConfig.baseUrl).href !== apiWebSocketUrl(config.baseUrl).href;
  explicitConfig = config;
  if (!targetChanged || current === undefined) return;

  const generation = current;
  current = undefined;
  retireGeneration(generation);
  const retiredSession = snapshot?.session;
  snapshot = undefined;
  if (retiredSession !== undefined) disposeSession(retiredSession);
  consecutiveDialFailures = 0;
  // Dial now so mounted hooks see one coherent target transition rather than
  // retaining the previous deployment until their next read.
  if (firstConnect === undefined) {
    firstConnect = Promise.withResolvers<SessionStub>();
    void firstConnect.promise.catch(() => {});
  }
  dial();
}

function dialTarget(): {
  url: URL;
  credentials: NonNullable<IterateSessionConfig["credentials"]>;
} {
  const base =
    explicitConfig?.baseUrl ??
    (typeof window === "undefined" ? noDialTarget() : window.location.href);
  return {
    url: apiWebSocketUrl(base),
    credentials: explicitConfig?.credentials || { type: "from-server-cookie" },
  };
}

function noDialTarget(): never {
  throw new Error(
    "itx has no connection target: in a browser the session dials the page's /api " +
      "(never during SSR — render itx consumers under an `ssr: false` route or <ClientOnly>); " +
      "anywhere else call configureIterateSession({ baseUrl, credentials }) before connecting.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The one socket: a single live WebSocket per process, in module state.
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
  /**
   * The capnweb bootstrap stub owns the whole RPC session. Disposing it aborts
   * every pending import immediately, which is stronger than WebSocket.close()
   * on a half-open socket (that close handshake may never produce an event).
   */
  rpcRoot: RpcStub<UnauthenticatedOs> | undefined;
  connecting: Promise<SessionStub>;
  /** Settles an imperative waiter if forced retirement happens before publish. */
  rejectConnecting: (reason?: unknown) => void;
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
 * The immutable value readers see (React reads it via `useSyncExternalStore` +
 * `use()`). Replaced wholesale on every transition, always BEFORE listeners are
 * notified, so a concurrent render can never tear. `session` is the last live
 * session and survives transport gaps — that is what makes reconnect
 * invisible. `generation` is a monotonic number whose only job is being the
 * reconnect dep for the React layer's reconnect-aware effect (the CAS is
 * generation object identity, not this number). `connecting` is what
 * first-load consumers await/suspend on: before the FIRST session it is the
 * stable {@link firstConnect} promise (survives closed-before-open retries
 * without rejecting a suspended tree); afterwards `session` is always defined.
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
 * The promise first-load consumers share until the FIRST session exists. One
 * stable promise across dial retries: a dial that closes before opening rejects
 * its own per-dial `connecting` (imperative awaiters fail fast) but must NOT
 * reject a suspended React tree — React replays a suspended (never-committed)
 * component against the thenable it first used, so a rejected first promise
 * would surface in the error boundary even though a paced re-dial is already
 * underway. It rejects only on a TERMINAL failure (authenticate answered with
 * a real application error over a working socket).
 */
let firstConnect: PromiseWithResolvers<SessionStub> | undefined;

const listeners = new Set<() => void>();
export const subscribeSession = (onChange: () => void) => {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
};

/**
 * One real project stub per (session, slug), cached in module state so a
 * consumer's lifecycle (React renders that may be discarded, repeated
 * imperative calls) can't leak undisposed capnweb import entries (see module
 * header). Keyed by the session stub identity, so it is implicitly scoped to a
 * generation and torn down with it. `slug` may be a slug or a `prj_…` id —
 * `session.projects.get` accepts either.
 */
const projectStubCaches = new WeakMap<SessionStub, Map<string, ProjectStub>>();

export function projectStubFor(session: SessionStub, slug: string): ProjectStub {
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
export function currentSnapshot(): Snapshot {
  // `dial()` sets `current` synchronously, so this fires at most once per idle
  // window (first load, or after a retry exhausted its own re-dial) — never a
  // per-render loop.
  if (current === undefined) dial();
  return snapshot!;
}

export const serverSnapshot = (): never => noDialTarget();

/**
 * Ensure a live-or-connecting session and return its connecting promise. The
 * imperative sibling of the React `useIterateSession()`: for handlers,
 * `mutationFn`s, scripts, and lazy closures. Same one socket the hooks use.
 * After a TERMINAL auth rejection this keeps returning that failure (the
 * parked generation — see Generation.failed) until {@link reconnectIterateSession}.
 */
export function connectIterateSession(): Promise<SessionStub> {
  // No runtime guard here: `dial()` resolves its target first thing, so an
  // unconfigured non-browser call throws the no-target error synchronously.
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
  const target = dialTarget();

  const id = ++generationCounter;
  const { promise, resolve, reject } = Promise.withResolvers<SessionStub>();
  // Keep an internal handler so a dial that rejects with no live awaiter never
  // surfaces as an unhandledrejection — real `connectIterateSession()` awaiters still observe it.
  void promise.catch(() => {});
  const generation: Generation = {
    ws: undefined,
    rpcRoot: undefined,
    connecting: promise,
    rejectConnecting: reject,
    ping: undefined,
    liveness: undefined,
    verifying: false,
    failed: false,
  };
  current = generation;
  // Keep showing the last session while the new generation dials (invisible
  // reconnect). Before the FIRST session, awaiters must share the stable
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
    const ws = new WebSocket(target.url.href);
    generation.ws = ws;
    let established = false;
    // The timeout spans the WHOLE dial — TCP/TLS/upgrade AND the authenticate
    // round trip — so a server that accepts the socket but never answers
    // authenticate is a failed dial (close → paced re-dial), not a wedge.
    const timeout = setTimeout(() => {
      // Do not delegate progress to `close`: a half-open socket can accept the
      // close request without ever firing a close event. Settle this attempt,
      // abort its RPC session, and transfer ownership to a fresh dial here.
      if (current !== generation || established) return;
      current = undefined;
      consecutiveDialFailures += 1;
      reject(new Error("itx WebSocket closed before connecting"));
      retireGeneration(generation);
      dial();
    }, DIAL_TIMEOUT_MS);

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
      // disposeSession that misses half of them.) In a browser the default
      // credentials ride the session cookie on the handshake; configured
      // consumers authenticate with their explicit credentials.
      const unauthenticated = newWebSocketRpcSession<UnauthenticatedOs>(ws);
      generation.rpcRoot = unauthenticated;
      void (async () => {
        let root: SessionStub;
        try {
          // The runtime value IS a session stub (same callable surface); the
          // cast bridges capnweb's Awaited-type nesting (`Stubify<Session>`
          // re-wraps every member in promise types) back to the nominal handle.
          // This is the module's ONE cast, at the identity boundary.
          const credentialProvider = target.credentials;
          if (typeof credentialProvider === "function") {
            const authenticate = async (forceRefresh: boolean) =>
              (await unauthenticated.authenticate(
                await credentialProvider({ forceRefresh }),
              )) as unknown as SessionStub;
            try {
              root = await authenticate(false);
            } catch (error) {
              if (
                !(error instanceof Error) ||
                !/auth|token|unauthorized|401/i.test(error.message)
              ) {
                throw error;
              }
              root = await authenticate(true);
            }
          } else {
            root = (await unauthenticated.authenticate(
              credentialProvider,
            )) as unknown as SessionStub;
          }
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
          //
          // The parked snapshot carries NO session. Keeping the last session is
          // the invisible-reconnect move for TRANSPORT gaps — but this is an
          // AUTHORITY loss (claims revoked / signed out elsewhere): the prior
          // session's socket is already closed and no redial will revive it, so
          // handing it out would wedge hooks on zombie stubs whose calls fail
          // with transport-shaped errors while the real auth error never
          // surfaces. Dropping it makes useIterateSession() re-throw the
          // terminal error to the boundary; the prior session's refs are
          // released here (they were dead already).
          const terminal = error instanceof Error ? error : new Error(String(error));
          generation.failed = true;
          reject(terminal);
          firstConnect?.reject(terminal);
          firstConnect = undefined;
          const zombieSession = snapshot?.session;
          setSnapshot({ generation: id, session: undefined, connecting: promise });
          if (zombieSession !== undefined) disposeSession(zombieSession);
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
          // Any round trip proves the transport. Probe the already-authorized
          // Session capability: re-running authenticate would needlessly
          // re-verify the cookie/token (and can cross into the auth worker)
          // every 45 seconds per tab merely to test socket health.
          await root.__describe();
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
        // (the snapshot keeps showing it); with none it keeps first-load
        // consumers on the stable first-connect promise — a paced retry, never
        // a wedge or an error boundary.
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
 * FORCED retirement (a reconnect, not an observed close): release resources,
 * abort capnweb through its bootstrap stub, then ask the socket to close.
 * Disposing the bootstrap synchronously rejects every pending and future call;
 * relying on WebSocket.close() alone is insufficient because a half-open socket
 * may never finish its close handshake or fire `close`. Callers set
 * `current = undefined` FIRST, so any close event won't auto-redial (re-dialing
 * is the caller's job).
 */
function retireGeneration(generation: Generation): void {
  disposeGeneration(generation);
  generation.rejectConnecting(new Error("itx WebSocket closed before connecting"));
  generation.rpcRoot?.[Symbol.dispose]?.();
  generation.rpcRoot = undefined;
  generation.ws?.close();
}

/**
 * Report that the shared transport may be half-open (a call hung). Consumers —
 * the subscription watchdog, any long-lived reader — call this instead of
 * closing the socket themselves — {@link verifyTransport} probes and, only on
 * two strikes against the SAME generation, retires it. A stale report is a
 * no-op.
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
 * a fresh one so the next reads run under the caller's CURRENT claims. Call
 * after creating a project or unlocking admin — the live socket carries the
 * connect-time principal. React callers that need already-cached data refreshed
 * should also `invalidateQueries({ queryKey: ["itx"] })`.
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

/**
 * Revive only a generation parked by a terminal authentication failure. This
 * is the imperative retry boundary for query/mutation clients: calling it
 * before a repeated operation lets refreshed credentials dial again without
 * disturbing a healthy or merely reconnecting session.
 */
export function retryFailedIterateSession(): void {
  if (current?.failed) reconnectIterateSession();
}

/**
 * Release the current transport and authority without reconnecting. Intended
 * for process-local lifecycle boundaries such as signing out of a native app;
 * mounted consumers should be removed in the same transition. The explicit
 * deployment configuration remains, so a later connect can dial it again.
 */
export function disconnectIterateSession(): void {
  const generation = current;
  current = undefined;
  if (generation !== undefined) retireGeneration(generation);
  const retiredSession = snapshot?.session;
  snapshot = undefined;
  if (retiredSession !== undefined) disposeSession(retiredSession);
  firstConnect?.reject(new Error("itx session disconnected"));
  firstConnect = undefined;
  consecutiveDialFailures = 0;
}

/**
 * The four — and only four — transport-close rejections a caller may treat as
 * "the socket died, retry on a fresh one": our own dial-close reject, capnweb's
 * two WebSocket aborts (`Peer closed WebSocket: <code> <reason>` and
 * `WebSocket connection failed.`), and capnweb's exact local-shutdown error
 * from our forced bootstrap disposal. Deliberately NARROW: an
 * application/auth/validation error that merely mentions "WebSocket" must never
 * be mistaken for a transport failure and retried. This is the one discriminant
 * shared by the query retry, the subscribe retry, and the liveness verifier.
 */
export function isItxTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("itx WebSocket closed before connecting") ||
    message.includes("Peer closed WebSocket") ||
    message.includes("WebSocket connection failed") ||
    message.includes("RPC session was shut down by disposing the main stub")
  );
}

// Baseline half-open recovery for the whole browser tab: on the moments
// transports die (waking a tab, coming back online), verify the current socket.
// Consumer-owned watchdogs (subscriptions) recover their lanes faster; this
// covers a query-only page whose socket nobody else probes. Non-browser
// runtimes have no equivalent signal — their timers carry the whole story.
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
// Subscription liveness: the handle shape + the watchdog that polls it.
// ─────────────────────────────────────────────────────────────────────────────

const PING_TIMED_OUT = Symbol("itx-ping-timed-out");

/**
 * The live handle shape every itx subscription API returns — `Stream.subscribe`
 * and `LiveStateRpc.subscribe` both hand back `ping()` + `unsubscribe()`. The
 * real handles are capnweb stubs and therefore Disposable: `unsubscribe()`
 * closes the SERVER side, `[Symbol.dispose]` releases the caller-owned stub —
 * on the process-long shared socket, skipping the dispose leaks one
 * import-table entry per subscribe cycle, so holders always do both.
 */
export type ItxLiveSubscriptionHandle = {
  ping(): boolean | Promise<boolean>;
  unsubscribe(): unknown;
  [Symbol.dispose]?(): void;
};

/**
 * Release a live subscription handle completely: `unsubscribe()` closes the
 * server side (already-dead is fine — the rejection is swallowed), then
 * `[Symbol.dispose]` frees the caller-owned stub. One helper because
 * forgetting either half leaks (see {@link ItxLiveSubscriptionHandle}).
 */
export function releaseItxSubscription(handle: ItxLiveSubscriptionHandle): void {
  void Promise.resolve()
    .then(() => handle.unsubscribe())
    .catch(() => {})
    .finally(() => handle[Symbol.dispose]?.());
}

/**
 * Poll a subscription handle's `ping()` until it stops answering `true`, then
 * recover. Server pushes fail SILENTLY: a dead Durable Object or half-open TCP
 * stops delivering with no client-visible signal, so a consumer can show
 * "live" forever while stale. The watchdog checks on an interval and — because
 * those are exactly when sockets die — when a browser tab becomes visible or
 * comes online (in runtimes without those signals, the interval carries it).
 *
 *   `dead`      → ping answered `false` or REJECTED: the socket works but the
 *                 server-side subscription is gone (DO restart / dropped
 *                 callback). Recovery is a re-subscribe on the same socket.
 *   `timed-out` → ping never answered: the shared WebSocket is half-open. The
 *                 watchdog REPORTS the suspicion to the socket-owned verifier
 *                 ({@link reportTransportSuspicion}) — it never closes the socket
 *                 itself — and the holder re-subscribes once the generation
 *                 re-dials.
 */
export function watchItxSubscription(
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

  // Browser wake signals (guarded: node/TUI runs interval-only). Becoming
  // visible → check (going hidden shouldn't). Connectivity returning → check
  // UNCONDITIONALLY, so a backgrounded tab holding a live subscription recovers
  // a half-open socket when the network comes back, not on next focus.
  const inBrowser = typeof document !== "undefined";
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  const onOnline = () => void check();
  const interval = setInterval(() => void check(), LIVENESS_INTERVAL_MS);
  if (inBrowser) {
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    if (inBrowser) {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    }
  };
  return stop;
}
