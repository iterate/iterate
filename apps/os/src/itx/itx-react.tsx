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
 *   5. LIVE STATE       → useLiveState((itx) => itx.liveState, selector)
 *                                                           (subscribe to any `.liveState` node; the
 *                                                            server pushes a snapshot then minimal
 *                                                            diffs and the selector picks the slice you
 *                                                            render — see its docstring)
 *
 *   (useItxEffect — the reconnect-aware raw effect — is the internal foundation
 *   under the live hooks; it stops being module-private the day a consumer
 *   needs mount-scoped itx work that isn't a subscription.)
 *
 *   ACTIONS (mutations) → imperative on the handle, no extra primitive:
 *                           const itx = useItx();
 *                           <button onClick={() => itx.chat.sendMessage(text)} />
 *                         or, for pending/error/refetch tracking, TanStack Query's useMutation.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SOCKET MODEL — a Map, not a "pool"
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  • ONE WebSocket per CONTEXT by default (a project id, or the global
 *    context), memoized in a module-level `Map` right here in this file. React
 *    19's `use()` needs a STABLE promise across render replays, so the
 *    connecting promise is cached: same context = same socket, different
 *    contexts = different sockets. A caller can add a `connectionKey` for an
 *    intentionally isolated transport in the same authenticated context — the
 *    browser stream mirror does this so its catch-up/reconnect loop cannot
 *    abort unrelated page reads. The Map lives outside React, so sockets
 *    persist across client-side navigation.
 *
 *  • On socket death the entry is dropped and mounted readers are woken, so the
 *    next render re-dials and re-suspends on a fresh socket. There is no resume:
 *    re-reading current state IS the recovery (kernel subscriptions push current
 *    state on open), so a useItxEffect subscription re-fires after a reconnect.
 *    Connecting THROWS on the server (never SSRs): a forever-pending `use()`
 *    during streaming SSR would hang the response. Render itx consumers under an
 *    `ssr: false` route or `<ClientOnly>` + `<Suspense>`.
 *
 *  • CONNECTIONS are addressed by a plain
 *    { projectId?, connectionKey?, path?, baseUrl? } tuple. `projectId` and
 *    `connectionKey` key the socket today; `path`/`baseUrl` are reserved for
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
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
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

/**
 * The handle type is context-dependent: a project connection holds the project
 * itx, the global connection holds the Session catalog. One pragmatic
 * intersection keeps the four primitives monomorphic — a wrong call for the
 * context fails at runtime exactly like a missing capability would.
 */
type ItxHandle = RpcStub<Session & Project>;
export type { ItxHandle as ItxReactHandle };

/**
 * How you address an itx connection — a plain, comparable value (that's what lets
 * the provider hold it in context and `useItx` resolve it with `??`). The empty
 * address `{}` is the global context. `projectId` is a project id (`prj_…`);
 * `connectionKey` opts into an isolated transport within that context;
 * `path`/`baseUrl` are reserved (not yet used to key the socket).
 */
type ItxAddress = {
  projectId?: string;
  path?: string;
  baseUrl?: string;
  /**
   * Keep a long-lived subsystem on its own transport while preserving the
   * same authenticated project scope. Most callers omit this and share the
   * provider socket; stream mirrors use it because their reconnect loop must
   * not abort unrelated page reads on the ordinary project socket.
   */
  connectionKey?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// The socket: one live WebSocket per context, kept outside React.
// ─────────────────────────────────────────────────────────────────────────────

const DIAL_TIMEOUT_MS = 15_000;
// Pacing for re-dials after a dial that closed before opening. Without it, a
// fast-REFUSING endpoint (offline after mobile resume, dev-server restart)
// loops dial → instant close → wake() → synchronous getSnapshot re-dial with
// zero delay, unbounded — the 15s dial timeout only paces the HANGING failure
// shape. The wait lives inside the connecting promise, so `use()` semantics
// are unchanged (readers just suspend a little longer).
const REDIAL_BACKOFF_MIN_MS = 250;
const REDIAL_BACKOFF_MAX_MS = 10_000;

/**
 * ONE entry per context (a project id, or `undefined` = global): the
 * connecting promise, the raw transport, and the dial time travel together.
 * They used to live in three parallel maps that had to agree — and disagreed:
 * eviction read the transport slot after wake()'s synchronous re-dial had
 * overwritten it, closing the fresh successor while the corpse (carrying
 * every pending call) survived (#1894). With one entry, eviction is an atomic
 * entry removal and the confusion is unrepresentable.
 *
 * `ws` is set once the (possibly backoff-delayed) dial actually constructs
 * the WebSocket. Closing the raw transport is what tears the capnweb session
 * down (rejecting every pending and future call); disposing the resolved
 * handle releases only the derived project stub.
 */
type SocketEntry = {
  address: ItxAddress;
  promise: Promise<ItxHandle>;
  ws: WebSocket | undefined;
  dialedAt: number;
  /**
   * One cheap authenticated round trip proving the transport is alive — set
   * once the dial opens. The resume sweep uses it: a half-open socket answers
   * nothing, and a socket with no mounted watchdog/probe consumer (a
   * queries-only page; the global socket on a project page) would otherwise
   * never be found dead — every later call through it just hung.
   */
  ping?: () => Promise<void>;
};
type SocketKey = string;

function socketKey(address: ItxAddress): SocketKey {
  return JSON.stringify([address.projectId ?? null, address.connectionKey ?? null]);
}

const socketEntries = new Map<SocketKey, SocketEntry>();
/** Consecutive closed-before-open dials per context — the re-dial backoff input. */
const dialFailures = new Map<SocketKey, number>();
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
function socketFor(address: ItxAddress): Promise<ItxHandle> {
  if (typeof window === "undefined") {
    throw new Error(
      "itx is browser-only: it dials a WebSocket to /api and never SSRs. " +
        "Render itx consumers under an `ssr: false` route or inside <ClientOnly>.",
    );
  }
  const key = socketKey(address);
  const existing = socketEntries.get(key);
  if (existing) {
    return existing.promise;
  }

  const { promise, resolve, reject } = Promise.withResolvers<ItxHandle>();
  // Keep an internal handler so a dial that rejects with no live awaiter (the
  // reader unmounted, or only the hook ever held it) never surfaces as an
  // unhandledrejection — real `connectItxBrowser()` awaiters still observe it.
  void promise.catch(() => {});
  const entry: SocketEntry = { address, promise, ws: undefined, dialedAt: Date.now() };
  socketEntries.set(key, entry);

  const beginDial = () => {
    // Evicted while waiting out the backoff (a session change, a watchdog):
    // this attempt no longer owns the slot — settle and let the owner dial.
    if (socketEntries.get(key) !== entry) {
      reject(new Error("itx WebSocket closed before connecting"));
      return;
    }
    // Context resolution is client-side: one endpoint, authenticate(), then
    // projects.get(<project id>) — the context key is a project ID, not a slug.
    const url = new URL("/api", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    entry.ws = ws;
    entry.dialedAt = Date.now();
    let opened = false;
    // A dial that never connects must not suspend forever: time out and close, so
    // the close handler below drops the entry and the next render re-dials.
    const timeout = setTimeout(() => ws.close(), DIAL_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      opened = true;
      dialFailures.delete(key);
      // Pipelined, no extra round trips: authenticate() rides the session cookie
      // on the WebSocket handshake, projects.get narrows to the project context.
      // The session/root stubs live as long as the socket; they are never
      // disposed individually.
      const unauthenticated = newWebSocketRpcSession<UnauthenticatedOs>(ws);
      const root = unauthenticated.authenticate({ type: "from-server-cookie" });
      entry.ping = async () => {
        // Any round trip proves the transport; authenticate rides the session
        // cookie and is the one call every context supports. Dispose the
        // probe stub so resume sweeps don't grow the cap table.
        const probe = await unauthenticated.authenticate({ type: "from-server-cookie" });
        (probe as Partial<Disposable>)[Symbol.dispose]?.();
      };
      resolve(
        (address.projectId ? root.projects.get(address.projectId) : root) as unknown as ItxHandle,
      );
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
      if (socketEntries.get(key) === entry) {
        // Failure bookkeeping only for the entry that still owns the slot: a
        // stale or intentionally-evicted socket's close must not count
        // against its successor's backoff history.
        if (!opened) dialFailures.set(key, (dialFailures.get(key) ?? 0) + 1);
        socketEntries.delete(key);
        wake();
      }
      reject(new Error("itx WebSocket closed before connecting"));
    });
  };

  // The FIRST retry is immediate (a one-off blip should recover instantly);
  // pacing kicks in from the second consecutive failure — that's the storm.
  const failures = dialFailures.get(key) ?? 0;
  const delay =
    failures <= 1
      ? 0
      : Math.min(REDIAL_BACKOFF_MAX_MS, REDIAL_BACKOFF_MIN_MS * 2 ** Math.min(failures - 2, 6));
  if (delay === 0) beginDial();
  else {
    setTimeout(beginDial, delay);
  }
  return promise;
}

/**
 * Evict a context's socket on SUSPICION of a half-open transport (a probe or
 * dial timed out) — the {@link reconnectItx} lane for liveness machinery, with
 * one guard reconnectItx must not have: a socket dialed less than one dial
 * timeout ago cannot be the corpse the suspicion accumulated against (timeouts
 * take ≥5-15s to fire), so refuse to evict it. Without this, two stream
 * runtimes sharing a socket double-evict: the second runtime's late strike
 * would kill the healthy successor the first runtime's eviction just dialed.
 */
export function evictItxSocket(address?: ItxAddress): void {
  const entry = socketEntries.get(socketKey(address ?? {}));
  if (entry === undefined || Date.now() - entry.dialedAt < DIAL_TIMEOUT_MS) return;
  reconnectItx(address);
}

/**
 * Evict a context's socket ONLY if it is still the one the suspicion was
 * accumulated against — the connecting promise IS the socket's identity, and
 * callers that dialed through {@link connectItxBrowser} hold it. This is the
 * exact form of {@link evictItxSocket}'s age heuristic: a late verdict against
 * an already-replaced corpse cannot evict the successor no matter how old the
 * successor is, and a genuinely-dead YOUNG socket can still be evicted by its
 * own consumer (the age guard would refuse for 15s).
 */
export function evictItxSocketIfCurrent(
  address: ItxAddress | undefined,
  suspect: Promise<unknown>,
): void {
  const entry = socketEntries.get(socketKey(address ?? {}));
  if (entry === undefined || entry.promise !== suspect) return;
  reconnectItx(address);
}

/**
 * Drop a context's socket (default: global) and dispose it, so the next read
 * re-dials with the browser session's CURRENT claims. Call after a session
 * change such as creating a project or unlocking admin — the live socket carries
 * the connect-time principal, so `itx.projects.list` would otherwise omit the new
 * project until a reload.
 */
export function reconnectItx(address?: ItxAddress): void {
  const key = socketKey(address ?? {});
  const entry = socketEntries.get(key);
  if (!entry) return;
  // Remove the ENTRY first (promise + transport travel together), then wake:
  // useSyncExternalStore's change handler synchronously re-reads getSnapshot →
  // socketFor, which installs a NEW entry — closing OURS below cannot touch it
  // (#1894 was eviction closing the fresh successor out of a shared slot).
  // An INTENTIONAL eviction also resets the dial backoff: the successor should
  // dial immediately, not inherit pacing from failures it didn't have.
  dialFailures.delete(key);
  socketEntries.delete(key);
  wake();
  // CLOSE the transport, don't just unmap it: capnweb tears the session down
  // (rejecting every pending and future call) only on transport close.
  // Unmapping alone leaves a ghost session that in-flight calls — a composer
  // send, a suspended query — hang on forever, and on a half-open socket the
  // OS may never deliver a close for us.
  entry.ws?.close();
  void entry.promise
    .then((itx) => (itx as Partial<Disposable>)[Symbol.dispose]?.())
    .catch(() => {});
}

/**
 * Baseline resume liveness for EVERY live socket, owned by the socket map
 * itself: on visibilitychange/online — exactly when transports die — prove
 * each opened socket with one cheap authenticated round trip and evict (by
 * identity) the ones that answer nothing twice. Consumer-mounted watchdogs
 * (useItxSubscription, the stream runtimes' probes) recover their OWN lanes
 * faster; this sweep is for the sockets nobody probes — a queries-only page,
 * the global socket on a project page — which otherwise stayed half-open
 * forever, hanging every later call through them.
 */
const RESUME_SWEEP_SINGLE_FLIGHT_MS = 5_000;
const RESUME_PING_TIMEOUT_MS = 5_000;
let lastResumeSweepAt = 0;

function sweepSocketsOnResume(): void {
  const now = Date.now();
  if (now - lastResumeSweepAt < RESUME_SWEEP_SINGLE_FLIGHT_MS) return;
  lastResumeSweepAt = now;
  for (const [key, entry] of [...socketEntries]) {
    const ping = entry.ping;
    if (ping === undefined) continue; // mid-dial: the dial's own timeout owns it
    void (async () => {
      const pingOnce = () =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("resume sweep ping timed out")),
            RESUME_PING_TIMEOUT_MS,
          );
          ping().then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
        });
      try {
        // Two-strike, like every other liveness lane: one slow answer is a
        // busy server, not a dead socket.
        try {
          await pingOnce();
        } catch {
          if (socketEntries.get(key) !== entry) return;
          await pingOnce();
        }
      } catch {
        // Identity-bound: only evict if this exact socket still owns the slot.
        evictItxSocketIfCurrent(entry.address, entry.promise);
      }
    })();
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sweepSocketsOnResume();
  });
  window.addEventListener("online", sweepSocketsOnResume);
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
  // One storm → one reconnect. Routed through the young-socket guard for the
  // same reason: a stream runtime's probe may have already evicted the corpse
  // and dialed a successor — a watchdog ping that was in flight on the corpse
  // still times out afterwards, and raw eviction here would kill that healthy
  // successor (the #1894 bug class through the second liveness system).
  const now = Date.now();
  if (now - lastReconnectAllAt < LIVENESS_PING_TIMEOUT_MS) return;
  lastReconnectAllAt = now;
  for (const entry of [...socketEntries.values()]) {
    evictItxSocket(entry.address);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Connection: <ItxProvider> + useItx() + connectItxBrowser()
// ─────────────────────────────────────────────────────────────────────────────

/** Default address = the global context. Lets useItx() work with NO provider. */
const ItxAddressContext = createContext<ItxAddress>({});

/** Subscribe to the socket map, suspend until this context's socket connects. */
function useSocket(address: ItxAddress): ItxHandle {
  const promise = useSyncExternalStore(
    subscribeSockets,
    () => socketFor(address),
    () => socketFor(address),
  );
  return use(promise);
}

function ItxPrewarm({ address }: { address: ItxAddress }) {
  useSocket(address);
  return null;
}

/**
 * Sets the default itx address for a subtree (and pre-warms its socket). It hands
 * down an ADDRESS, not a handle — and pre-opens the connection here so children's
 * `useItx()` resolve synchronously to the same socket. "Almost an optimization":
 * `useItx()` works without a provider (falls back to global).
 *
 * One <ItxProvider> serves every context — they're just different addresses:
 *   <ItxProvider />                          → global (home / projects list / admin)
 *   <ItxProvider projectId={project.id} />  → a project (the 99% case)
 *
 * The pre-warm dials the socket in a SIBLING Suspense boundary, so children
 * render immediately: only the components that actually read through itx
 * suspend, each into its own nearest boundary. It never SSRs (dialing throws
 * on the server), so render the provider under an `ssr: false` route (or
 * `<ClientOnly>`).
 */
export function ItxProvider({
  projectId,
  path,
  baseUrl,
  connectionKey,
  prewarm = true,
  children,
}: ItxAddress & { children: ReactNode; prewarm?: boolean }) {
  // Stable value so a fresh object literal each render doesn't thrash consumers.
  const address = useMemo<ItxAddress>(
    () => ({ projectId, path, baseUrl, connectionKey }),
    [projectId, path, baseUrl, connectionKey],
  );
  return (
    <ItxAddressContext value={address}>
      {prewarm ? (
        <Suspense fallback={null}>
          <ItxPrewarm address={address} />
        </Suspense>
      ) : null}
      {children}
    </ItxAddressContext>
  );
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
 *   const onSend = () => itx.chat.sendMessage(text);
 */
export function useItx(override?: ItxAddress): ItxHandle {
  const contextAddress = use(ItxAddressContext);
  return useSocket(override ?? contextAddress);
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
 * the same subtree already warmed — address it by the same key (the project ID)
 * to land on that socket. Running outside render there is no provider context to
 * read: pass the address explicitly (defaults to global).
 */
export function connectItxBrowser(address?: ItxAddress): Promise<ItxHandle> {
  return socketFor(address ?? {});
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
 * `itx` defaults to the provider's CONNECTION, resolved per fetch attempt (a
 * render-captured handle would pin whatever socket that render saw — TanStack's
 * retries and refetches would then ride a dead session even after the socket
 * map re-dialed, the captured-stub bug class); pass `itx` to read through a
 * specific handle you already hold. Errors throw to the nearest error boundary;
 * refetch after a mutation with
 * `queryClient.invalidateQueries({ queryKey: ["itx", ...key] })`.
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
  const contextAddress = use(ItxAddressContext);
  return useSuspenseQuery({
    queryKey: ["itx", ...(Array.isArray(key) ? key : [key])],
    queryFn: () => (itx !== undefined ? query(itx) : socketFor(contextAddress).then(query)),
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
 * THE LOAD-BEARING REASON it exists (not just sugar over `useEffect`): it keys
 * the effect on the connection's own connecting promise, so when the socket
 * dies and re-dials, the effect RE-RUNS and re-subscribes on the fresh
 * socket — its subscription's first push is the recovery. A hand-rolled
 * `useEffect` that reaches itx through a closure silently omits that dep and does
 * NOT recover on reconnect (the codebase has exactly that bug, papered over with
 * a manual "Refresh" button in some panels). A dedicated subscription
 * hook is also the universal shape — Apollo/urql/tRPC/Relay/Convex all ship one
 * rather than asking callers to wire raw effects.
 *
 * For the must-NOT-suspend case — a component whose main content does not
 * depend on itx (the ⌘K palette in the app shell) — pass `opts.address`: the
 * effect then awaits the connection instead of the render unwrapping it, so a
 * slow/down socket degrades just that widget and never suspends the page.
 * One-off closures (the agent feed) can still dial {@link connectItxBrowser}
 * directly.
 *
 * Subscribe to live pushes:
 *   useItxEffect((itx) => {
 *     const sub = itx.streams.get("/logs").subscribe({ processEventBatch });
 *     return () => sub.unsubscribe();                 // tell the server to stop
 *   }, []);
 *
 * Async setup (await, then subscribe) — same hook, no extra ceremony:
 *   useItxEffect(async (itx) => {
 *     const cfg = await itx.project.getConfig();
 *     const sub = await itx.streams.get("/logs").subscribe({ processEventBatch: onBatch(cfg) });
 *     return () => sub.unsubscribe();
 *   }, []);
 *
 * The callback may be sync OR async; you don't pick. An async setup's late cleanup
 * still runs if you unmounted mid-await (React's documented async-effect guard).
 * Cleanup contract = `useEffect`'s: return a cleanup function (or nothing) —
 * typically disposing a capnweb stub via `Symbol.dispose`. `itx` defaults to the
 * provider; the connection is added to the deps internally. `enabled: false`
 * renders the hook fully inert — no dial, no setup.
 */
function useItxEffect(
  setup: (itx: ItxHandle) => void | (() => void) | Promise<void | (() => void)>,
  deps: unknown[],
  opts?: {
    itx?: ItxHandle;
    address?: ItxAddress;
    enabled?: boolean;
    onDialError?: (error: unknown) => void;
  },
): void {
  const contextAddress = use(ItxAddressContext);
  const address = opts?.address;
  const enabled = opts?.enabled ?? true;
  const selectedAddress = address ?? contextAddress;
  // ONE subscription to the socket map, keyed on the connection this effect
  // rides — a socket death re-renders us with a FRESH connecting promise, and
  // that promise in the effect deps is what re-runs the effect on it (the
  // reconnect recovery, for both lanes). Reading dials (socketFor memoizes, so
  // render replays are safe); a disabled effect — or one handed `{ itx }` —
  // must not even dial. On the server there is no socket, ever.
  const promise = useSyncExternalStore(
    subscribeSockets,
    () => (enabled && opts?.itx === undefined ? socketFor(selectedAddress) : undefined),
    () => undefined,
  );
  // Only the AMBIENT lane unwraps in render — the suspend-OK case (the page IS
  // this connection's content). The `address` lane awaits the same promise
  // inside the effect, so mounting never suspends the surrounding tree (the ⌘K
  // contract: the palette lives in the app shell and must not blank it — not
  // even while a socket re-dials). `use()`, unlike a hook, is legal here.
  const itx =
    opts?.itx ?? (promise !== undefined && address === undefined ? use(promise) : undefined);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let cleanup: void | (() => void);
    const apply = (handle: ItxHandle) => {
      if (disposed) return;
      const result = setup(handle);
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
        cleanup = result; // cleanup captured now, like a normal effect
      }
    };
    if (itx !== undefined) {
      apply(itx); // synchronous, exactly like a plain effect
    } else if (promise !== undefined) {
      // Address lane: the dial resolves inside the effect. A FAILED dial never
      // reaches `setup`, so a caller owning status (useItxSubscription) must
      // take `onDialError` to surface + retry it — else it can only be logged.
      void promise.then(apply, (error: unknown) => {
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
  }, [enabled, opts?.itx ?? promise, ...deps]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Live subscriptions: useItxSubscription() — recovery + watchdog; useLiveState() — live values
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
        // One slow answer is a busy/cold DO, not a dead socket — and this
        // watchdog's timed-out recovery is FLEET-wide (reconnectAllItx closes
        // every context's socket, rejecting every in-flight call in the tab).
        // Hold it to the same two-strike standard as the stream runtimes'
        // probes: only a second consecutive timeout reports.
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
 *   - socket death with a `close` event → re-subscribes on the fresh socket
 *     (via {@link useItxEffect}'s reconnect-aware [itx] dep);
 *   - SILENT death — hosting DO restart, dropped callback, half-open TCP —
 *     → the {@link watchItxSubscription} watchdog detects it and either
 *     re-subscribes (dead) or drops the sockets so everything re-dials
 *     (timed-out);
 *   - a failed subscribe attempt — including a failed lazy dial when
 *     subscribing via `{ address }` — → status "error", retried on a
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
  opts?: { enabled?: boolean; itx?: ItxHandle; address?: ItxAddress },
): { status: ItxSubscriptionStatus; error?: string; refresh: () => void } {
  const enabled = opts?.enabled ?? true;
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<{ status: ItxSubscriptionStatus; error?: string }>({
    status: "connecting",
  });
  // The dial-error retry outlives its effect run (the failure IS the run never
  // starting), so its timer is cleared on unmount rather than by an effect
  // cleanup. A bump landing after a later successful run only re-subscribes,
  // which is idempotent (see the watchdog note below).
  const dialRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(dialRetry.current), []);

  // Disabling makes the whole effect inert (no dial, no setup — see
  // useItxEffect), so the status reset happens here: a subscription disabled
  // after a live period must not keep reporting "live" over its torn-down
  // handle (consumers would render stale data as fresh).
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
    [epoch, ...deps],
    // Subscribe through a specific connection: `{ itx }` uses a handle you already
    // hold; `{ address }` (e.g. ⌘K reaching a project from the app shell) dials
    // lazily inside the effect so render never suspends.
    {
      itx: opts?.itx,
      address: opts?.address,
      enabled,
      // A failed lazy dial never reaches the setup above, so without this the
      // hook would sit on "connecting" forever: put it on the SAME lane as a
      // failed subscribe — status "error", then an epoch bump retries the dial
      // (the socket pool dropped the failed promise, so the retry re-dials).
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

  // Stable identity: `refresh` lands in consumer deps and memoized children
  // (useLiveState holds it in a ref); its captured setters are stable.
  const refresh = useCallback(() => {
    setState({ status: "connecting" });
    setEpoch((current) => current + 1);
  }, []);

  return { ...state, refresh };
}

/**
 * THE live-state primitive: subscribe to any `.liveState` node, render the slice
 * you pick. The server pushes a snapshot then minimal diffs; this hook reassembles
 * them (see lib/live-state/store) and hands back `selector(state)`.
 *
 *   const streams = useLiveState((itx) => itx.liveState, (s) => s.streamsIndex);
 *   // re-renders ONLY when streamsIndex changes — a change elsewhere in the
 *   // project's live state does not re-render this component.
 *
 * THE SELECTOR CONTRACT — a pure function of the state, and nothing else:
 * - Return a STABLE slice (`s => s.rows`), not a fresh object
 *   (`s => Object.values(s.rows)`); map in a downstream `useMemo`.
 * - Do NOT close over props/state (`s => s.rows[props.id]`): selection is
 *   cached by STATE identity, so a closure-captured value going stale is
 *   invisible until the next server push. Select the broader slice and index
 *   into it in render, or route the changing input through `deps`.
 *
 * `value` is `undefined` between mount and the first snapshot (one round trip);
 * render a loading row for that window. `deps` re-point the hook at a different
 * node — a change drops the held state so a stale slice never shows. All
 * reconnect/liveness recovery is {@link useItxSubscription}'s.
 *
 * Every mounted hook holds its OWN server subscription (deliberate for now:
 * ⌘K is the only always-mounted consumer). If composite-state panels multiply,
 * share one subscription per (connection, node) behind a refcounted store map
 * — the same shape as the socket map above — rather than mounting N hooks on
 * one node.
 *
 * By default it subscribes through the ambient connection. To read a DIFFERENT
 * project's live state from OUTSIDE its provider (the ⌘K palette mounts in the
 * app shell but wants a project's streams index), pass `opts.address =
 * { projectId }`: the connection resolves inside the effect, so it never
 * suspends the surrounding tree (the documented ⌘K contract). `opts.itx` is
 * the eager sibling for when you already hold the handle. `opts.enabled =
 * false` makes the hook inert (no dial, no subscription) while keeping the
 * last value.
 */
export function useLiveState<State, Selected = State>(
  live: (itx: ItxHandle) => LiveStateRpc<State>,
  selector: (state: State) => Selected,
  deps: unknown[] = [],
  opts?: { itx?: ItxHandle; address?: ItxAddress; enabled?: boolean },
): {
  value: Selected | undefined;
  status: ItxSubscriptionStatus;
  error?: string;
  refresh: () => void;
} {
  // useState, not useMemo: the store holds the accumulated live value, and
  // React documents useMemo as droppable (a dropped store would cost a resync).
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
      // straggler push from a dying subscription (its unsubscribe is
      // best-effort) could collide with the fresh line and apply a wrong
      // patch — or read as a gap and tear the healthy subscription down.
      // Marking the sink stale on unsubscribe closes both.
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
    { itx: opts?.itx, address: opts?.address, enabled: opts?.enabled },
  );
  // In an effect, not during render (a discarded concurrent render must not
  // write refs); `refresh` is stable, so this runs once.
  useEffect(() => {
    refreshRef.current = subscription.refresh;
  }, [subscription.refresh]);

  // Selector memo cache keyed on STATE identity: returns the same `Selected` ref
  // while the state is unchanged, so useSyncExternalStore bails out (and can never
  // loop). An unstable selector costs a re-render, not a loop; a closure-capturing
  // selector goes stale — that's the documented contract above.
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
