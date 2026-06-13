// The ONE browser itx primitive. useItx(context?) suspends until a WebSocket
// to /api/itx[/<context>] is connected and returns the live handle stub;
// getBrowserItx(context?) is the same for non-hook code. There is exactly one
// route (/api/itx[/<context>]) and one pool — "admin", "global", and a project
// are just different context keys (= the connect endpoint), never different
// sockets or different primitives. Everything else — query caches, SSR
// prefetch, reconnect machinery, a shared-socket multiplexer, the repl's old
// private socket — was deliberately deleted (DECISIONS D21).
//
// The model, exactly:
//
//   - ONE socket per context key, per tab, held in a module-level map. Every
//     component on a context shares that one socket: the project page, its
//     repl, its activity tail, and the admin layout (global key) all ride the
//     same connection. The map is module-scoped (outside React), so the socket
//     persists across client-side route navigations untouched — components
//     mount and unmount, the socket does not. The map also makes Suspense work
//     (use() needs the same promise across render replays). Multiple sockets
//     across DIFFERENT contexts (global + each project) are expected; one per
//     context is the invariant, not one globally.
//   - No refcounting, no teardown on unmount: a context's socket lives until
//     it dies or the tab closes. Components NEVER own the connection.
//   - Disposal contract. The pool owns the socket's lifetime. A component must
//     NEVER dispose the root handle stub or close the socket on unmount — the
//     root stub IS the socket's lifetime handle (capnweb: disposing it closes
//     the WebSocket), and it is shared. The ONLY deliberate root-dispose is
//     evict()/reconnectBrowserItx(), used when the connect-time principal must
//     change (e.g. after creating a project, or unlocking admin). Per-component
//     RPC objects (subscription stubs, callbacks, any returned stub) ARE owned
//     by that component and must be disposed on unmount — on a long-lived
//     pooled socket an undisposed stub accumulates in the session import table
//     for the life of the tab (see itx-activity-tail / stream-tree-browser).
//   - Socket close → the map entry is evicted and subscribed components
//     re-render (an effect subscription bumps a reducer), find no entry, dial
//     fresh, and re-suspend. There is no backoff and no resume: re-fetching current
//     state IS the recovery — every kernel subscription pushes current state
//     on open (DECISIONS D20), so onStateChange re-fires with current state
//     on the new socket.
//   - Never SSRs. The hook THROWS on the server rather than suspending
//     forever: a forever-pending use() during streaming SSR keeps the
//     response stream open until the request aborts (React waits for every
//     suspended boundary), while a throw inside a Suspense boundary streams
//     the fallback and recovers client-side — and a throw outside one fails
//     loudly at the route instead of hanging the worker. Consumers render
//     under an `ssr: false` route or behind <ClientOnly> + <Suspense>.
//   - Errors keep their codes: getItxErrorCode / isItxAccessError (errors.ts)
//     read ItxError codes off anything a catch block or error boundary sees.

import { use, useCallback, useSyncExternalStore } from "react";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { ItxHandle } from "./handle.ts";

/**
 * The map/evict core, framework-free for testability. `connect` dials and
 * must call `onDead` when the connection is gone (failed dial included) so
 * the entry is evicted and subscribers are notified — the next `get` dials
 * fresh. Eviction is identity-guarded: a stale connection's death never
 * removes the entry of a newer connection under the same key.
 */
export function createSocketSuspenseCache<T>(input: {
  connect: (context: string | undefined, onDead: () => void) => Promise<T>;
}) {
  type Entry = { promise: Promise<T> };
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();
  const keyOf = (context: string | undefined) => context ?? "";

  return {
    /** The entry for this context, creating (and dialing) it if absent. */
    get(context?: string): Entry {
      const key = keyOf(context);
      const existing = entries.get(key);
      if (existing) return existing;
      const created: Entry = {
        promise: input.connect(context, () => {
          if (entries.get(key) !== created) return;
          entries.delete(key);
          for (const listener of listeners.get(key) ?? []) listener();
        }),
      };
      entries.set(key, created);
      return created;
    },
    /** Re-render trigger: fires when this context's entry is evicted. */
    subscribe(context: string | undefined, listener: () => void): () => void {
      const key = keyOf(context);
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    /**
     * Drop this context's socket so the next `get` re-dials. Used after the
     * browser session's claims change (e.g. creating a project) — the live
     * socket carries the connect-time principal, so a fresh dial is the only
     * way the new claims take effect. Disposes the resolved stub to close the
     * underlying session; subscribers re-render and re-suspend on a new dial.
     */
    evict(context?: string): void {
      const key = keyOf(context);
      const entry = entries.get(key);
      if (!entry) return;
      entries.delete(key);
      for (const listener of listeners.get(key) ?? []) listener();
      void entry.promise
        .then((value) => (value as Partial<Disposable>)[Symbol.dispose]?.())
        .catch(() => {});
    },
  };
}

const ITX_DIAL_TIMEOUT_MS = 15_000;

function dialItx(context: string | undefined, onDead: () => void): Promise<RpcStub<ItxHandle>> {
  const url = new URL(
    context ? `/api/itx/${encodeURIComponent(context)}` : "/api/itx",
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const { promise, resolve } = Promise.withResolvers<RpcStub<ItxHandle>>();
  // A dial that never connects (e.g. the worker restarting behind the dev
  // proxy) must not suspend consumers forever: time out and close, so the
  // close handler below evicts the entry and the next render re-dials.
  const dialTimeout = setTimeout(() => {
    socket.close();
  }, ITX_DIAL_TIMEOUT_MS);
  socket.addEventListener("open", () => {
    clearTimeout(dialTimeout);
    resolve(newWebSocketRpcSession<ItxHandle>(socket));
  });
  // `close` fires both for a failed dial and for a later death of an
  // established socket — either way the entry is dead and must be evicted.
  // We deliberately never reject the suspense promise: rejecting makes
  // `use()` THROW to an error boundary (blanking the subtree on a transient
  // dial failure) instead of re-suspending. Eviction + onDead notify is the
  // recovery — the next render gets a fresh entry and re-dials. A pre-open
  // death leaves this promise pending forever, but its entry is already gone,
  // so nothing reads it again; getBrowserItx callers re-call and re-dial.
  socket.addEventListener("close", () => {
    clearTimeout(dialTimeout);
    onDead();
  });
  return promise;
}

const pool = createSocketSuspenseCache<RpcStub<ItxHandle>>({ connect: dialItx });

function assertBrowser(caller: string): void {
  if (typeof window === "undefined") {
    throw new Error(
      `${caller} is browser-only: it dials a WebSocket to /api/itx and never SSRs. ` +
        "Render itx consumers under an `ssr: false` route or inside <ClientOnly> " +
        "from @tanstack/react-router (see ~/itx/use-itx.ts for why we throw instead of suspending).",
    );
  }
}

/**
 * A connected itx handle promise for non-hook code (event handlers, effects
 * outside the suspense path). Same singleton map as {@link useItx}; same
 * browser-only contract.
 */
export function getBrowserItx(context?: string): Promise<RpcStub<ItxHandle>> {
  assertBrowser("getBrowserItx");
  return pool.get(context).promise;
}

/**
 * Drop a context's socket (default: the global handle) so the next use re-dials
 * with the browser session's current claims. Call after a session change such
 * as creating a project — the live socket still carries the connect-time
 * principal, so `itx.projects.list` would otherwise omit the new project until
 * a reload.
 */
export function reconnectBrowserItx(context?: string): void {
  pool.evict(context);
}

/**
 * The itx handle for `context` ("global" when omitted, else a project id/slug
 * or itx_… id; session-cookie auth). Suspends until the socket is connected;
 * re-suspends (fresh socket, fresh state) if it dies. See the module header
 * for the full contract. Wrap consumers in a Suspense boundary and keep them
 * out of SSR.
 */
export function useItx(context?: string): RpcStub<ItxHandle> {
  assertBrowser("useItx");
  // The pool IS an external store: `subscribe` fires when a socket dies (its
  // entry is evicted) and `get` returns a stable Entry identity until then.
  // useSyncExternalStore coordinates the subscription with commit, so an
  // eviction in the render→commit gap can't be missed; on death the snapshot
  // is a fresh entry, the component re-renders, re-dials, and re-suspends.
  const entry = useSyncExternalStore(
    useCallback((onChange) => pool.subscribe(context, onChange), [context]),
    () => pool.get(context),
    () => pool.get(context),
  );
  return use(entry.promise);
}
