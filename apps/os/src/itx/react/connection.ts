// Browser-side itx connection: ONE WebSocket per tab to /api/itx (the global
// context), session-cookie authenticated, with lazy connect and automatic
// reconnect. Project handles are derived in-session via itx.projects.get()
// (narrowing is construction, Law 4) and cached per connection epoch — live
// refs are runtime-only and rebuilt by reconnection (Law 1).
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

  // One "session" per successful socket open. Epoch increments on every new
  // session so per-session caches (derived project handles) never leak across
  // reconnects.
  let session: { socket: WebSocket; stub: RpcStub<Itx>; epoch: number } | null = null;
  let epoch = 0;
  let active = true;
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
      if (!active) {
        socket.close();
        return;
      }
      epoch += 1;
      const stub = newWebSocketRpcSession<Itx>(socket);
      session = { epoch, socket, stub };
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
      if (!active) {
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
    if (!active) return Promise.reject(new Error("The itx client has been disposed."));
    if (session) return Promise.resolve(session.stub);
    const waiter = Promise.withResolvers<RpcStub<Itx>>();
    waiters.push(waiter);
    if (status === "idle") connect();
    return waiter.promise;
  }

  /** A project-narrowed handle, derived in-session and cached per epoch. */
  function project(projectSlugOrId: string): Promise<RpcStub<Itx>> {
    const cached = projectHandles.get(projectSlugOrId);
    if (cached) return cached;
    const handle = itx().then(
      (stub) => stub.projects.get(projectSlugOrId) as unknown as Promise<RpcStub<Itx>>,
    );
    projectHandles.set(projectSlugOrId, handle);
    handle.catch(() => projectHandles.delete(projectSlugOrId));
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
    /** Re-arm after deactivate (StrictMode remounts). Lazy — no socket yet. */
    activate() {
      active = true;
    },
    /**
     * Close the socket and stop reconnecting. Pending callers reject. The
     * client can be re-activated; the next itx() call reconnects fresh.
     */
    deactivate() {
      active = false;
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
