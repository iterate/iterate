// The ONE browser itx primitive: useItx(context?) suspends until a WebSocket
// to /api/itx[/<context>] is connected and returns the live handle stub.
// Everything else — query caches, SSR prefetch, reconnect machinery, a
// shared-socket multiplexer — was deliberately deleted (DECISIONS D21).
//
// The contract:
//
//   - One socket per context key, per tab, held in a module-level map. The
//     map exists only so Suspense works (use() needs the same promise across
//     render replays) — NOT for connection pooling. Multiple sockets are
//     explicitly fine.
//   - No refcounting, no teardown on unmount: a context's socket lives until
//     it dies or the tab closes.
//   - Socket close → the map entry is evicted and subscribed components
//     re-render (useSyncExternalStore), find no entry, dial fresh, and
//     re-suspend. There is no backoff and no resume: re-fetching current
//     state IS the recovery — every kernel subscription pushes current state
//     on open (DECISIONS D20), so onStateChange re-fires with current state
//     on the new socket.
//   - Never SSRs. The hook THROWS on the server rather than suspending
//     forever: a forever-pending use() during streaming SSR keeps the
//     response stream open until the request aborts (React waits for every
//     suspended boundary), while a throw inside a Suspense boundary streams
//     the fallback and recovers client-side — and a throw outside one fails
//     loudly at the route instead of hanging the worker. Consumers render
//     under an `ssr: false` route or behind <ClientOnly> (the admin layout's
//     connect-effect gate counts too).
//   - Errors keep their codes: getItxErrorCode / isItxAccessError (errors.ts)
//     read ItxError codes off anything a catch block or error boundary sees.
//
// The repl keeps its own createBrowserReplSession (itx-repl.tsx): it needs
// dispose/reconnect-on-demand semantics this singleton deliberately lacks.

import { use, useCallback, useSyncExternalStore } from "react";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { Itx } from "./handle.ts";

/**
 * The map/evict core, framework-free for testability. `connect` dials and
 * must call `onDead` when the connection is gone (failed dial included) so
 * the entry is evicted and subscribers are notified — the next `get` dials
 * fresh. Eviction is identity-guarded: a stale connection's death never
 * removes the entry of a newer connection under the same key.
 */
export function createConnectionPool<T>(input: {
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
    /** The current entry without creating one (useSyncExternalStore snapshot). */
    peek(context?: string): Entry | undefined {
      return entries.get(keyOf(context));
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
  };
}

function dialItx(context: string | undefined, onDead: () => void): Promise<RpcStub<Itx>> {
  const url = new URL(
    context ? `/api/itx/${encodeURIComponent(context)}` : "/api/itx",
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const { promise, resolve, reject } = Promise.withResolvers<RpcStub<Itx>>();
  socket.addEventListener("open", () => resolve(newWebSocketRpcSession<Itx>(socket)));
  // `close` fires both for a failed dial (reject the pending promise; no-op
  // once resolved) and for a later death of an established socket — either
  // way the entry is dead and must go.
  socket.addEventListener("close", () => {
    reject(new Error(`The itx WebSocket to ${url.pathname} closed.`));
    onDead();
  });
  return promise;
}

const pool = createConnectionPool<RpcStub<Itx>>({ connect: dialItx });

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
export function getBrowserItx(context?: string): Promise<RpcStub<Itx>> {
  assertBrowser("getBrowserItx");
  return pool.get(context).promise;
}

/**
 * The itx handle for `context` ("global" when omitted, else a project id/slug
 * or ctx_… id; session-cookie auth). Suspends until the socket is connected;
 * re-suspends (fresh socket, fresh state) if it dies. See the module header
 * for the full contract. Wrap consumers in a Suspense boundary and keep them
 * out of SSR.
 */
export function useItx(context?: string): RpcStub<Itx> {
  assertBrowser("useItx");
  // Socket death evicts the pool entry; this store subscription is what turns
  // that into a re-render, so the component below re-dials and re-suspends.
  const subscribe = useCallback(
    (listener: () => void) => pool.subscribe(context, listener),
    [context],
  );
  // Server snapshot is never read: assertBrowser threw long before
  // useSyncExternalStore could ask.
  useSyncExternalStore(
    subscribe,
    () => pool.peek(context),
    () => undefined,
  );
  return use(pool.get(context).promise);
}
