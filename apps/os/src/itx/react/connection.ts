// Browser-side itx connection: the app shares ONE WebSocket per tab to
// /api/itx (the global context), session-cookie authenticated, with lazy
// connect and automatic reconnect. (The itx REPL deliberately keeps its own
// isolated session — see createBrowserReplSession in itx-repl.tsx — so it can
// dispose and reconnect without touching app subscriptions.)
//
// Project handles are derived in-session via itx.projects.get() (narrowing is
// construction, Law 4) and cached until the socket closes — live refs are
// runtime-only and rebuilt by reconnection (Law 1).
//
// Framework-free on purpose: provider.tsx/hooks.ts are the React 19 layer on
// top. The status surface (subscribeStatus/getStatus) is shaped for
// useSyncExternalStore.

import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { Itx } from "../handle.ts";

export type ItxConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export type ItxBrowserClient = ReturnType<typeof createItxBrowserClient>;

export function createItxBrowserClient() {
  let status: ItxConnectionStatus = "idle";
  const statusListeners = new Set<() => void>();

  let session: { socket: WebSocket; stub: RpcStub<Itx> } | null = null;
  let disposed = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let waiters: PromiseWithResolvers<RpcStub<Itx>>[] = [];
  const projectHandles = new Map<string, Promise<RpcStub<Itx>>>();

  function setStatus(next: ItxConnectionStatus) {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) listener();
  }

  function connect() {
    if (typeof window === "undefined") {
      throw new Error("The browser itx client cannot connect during SSR.");
    }
    const url = new URL("/api/itx", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    setStatus(status === "idle" ? "connecting" : "reconnecting");

    const socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      if (disposed) {
        socket.close();
        return;
      }
      const stub = newWebSocketRpcSession<Itx>(socket);
      session = { socket, stub };
      backoffMs = INITIAL_BACKOFF_MS;
      setStatus("connected");
      const settled = waiters;
      waiters = [];
      for (const waiter of settled) waiter.resolve(stub);
    });
    socket.addEventListener("close", () => {
      if (session?.socket === socket) {
        session = null;
        projectHandles.clear();
      }
      if (disposed) {
        setStatus("idle");
        return;
      }
      // Unexpected close (or failed connect): keep callers waiting and retry
      // with capped exponential backoff + jitter.
      setStatus("reconnecting");
      const delay = backoffMs + Math.random() * backoffMs * 0.25;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      retryTimer = setTimeout(connect, delay);
    });
  }

  /** Resolve the global-context handle, connecting (or reconnecting) lazily. */
  function itx(): Promise<RpcStub<Itx>> {
    if (disposed) return Promise.reject(new Error("The itx client has been disposed."));
    if (session) return Promise.resolve(session.stub);
    const waiter = Promise.withResolvers<RpcStub<Itx>>();
    waiters.push(waiter);
    if (status === "idle") connect();
    return waiter.promise;
  }

  /** A project-narrowed handle, derived in-session and cached until close. */
  function project(projectSlugOrId: string): Promise<RpcStub<Itx>> {
    const cached = projectHandles.get(projectSlugOrId);
    if (cached) return cached;
    // capnweb types projects.get() by its RpcTarget return; re-assert the
    // stub as the full Itx surface (a project handle IS an Itx handle).
    const handle = itx().then(
      (stub) => stub.projects.get(projectSlugOrId) as unknown as Promise<RpcStub<Itx>>,
    );
    projectHandles.set(projectSlugOrId, handle);
    handle.catch(() => {
      // Only evict our own entry — by the time an old handle rejects, the
      // cache may already hold a fresh post-reconnect one.
      if (projectHandles.get(projectSlugOrId) === handle) {
        projectHandles.delete(projectSlugOrId);
      }
    });
    return handle;
  }

  return {
    itx,
    project,
    getStatus: () => status,
    subscribeStatus: (listener: () => void) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    /**
     * Close the socket and stop reconnecting, permanently. Pending callers
     * reject. The app never calls this — the per-tab client lives until the
     * tab does — but tests and non-app embeddings need a clean teardown.
     */
    dispose() {
      disposed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const settled = waiters;
      waiters = [];
      for (const waiter of settled) {
        waiter.reject(new Error("The itx connection was closed."));
      }
      projectHandles.clear();
      const current = session;
      session = null;
      if (current) {
        current.stub[Symbol.dispose]?.();
        current.socket.close();
      }
      setStatus("idle");
    },
  };
}
