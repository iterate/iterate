import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { IterateApi, IterateSessionApi } from "./api.ts";
import { openSocketWithRetry } from "./client/socket.ts";
import { OAuthScopes } from "./oauth-scopes.ts";

/** What `authenticate` resolves to: the session as a capnweb stub (pipelined; disposable) and the
 *  bootstrap info it answered with. Declared, so the package's declarations stay serializable. */
export type AuthenticatedApp = {
  api: RpcStub<IterateSessionApi>;
  info: ReturnType<IterateSessionApi["info"]>;
};
export type IterateClient = { authenticate(next?: string): Promise<AuthenticatedApp> };

/** The browser leaves for the issuer's login (a document navigation) and this never settles — no
 *  framework in the loop: a TanStack `beforeLoad` awaiting it ends the way a thrown
 *  `redirect({ reloadDocument: true })` did, a plain page simply navigates. */
function leaveForLogin(login: string): Promise<never> {
  window.location.assign(login);
  return new Promise<never>(() => {});
}

/** One socket to `/api` with the session the OAuth gate resolved from the cookie. The `api` is
 *  capnweb's pipelined `authenticate(...)` answer: usable before the socket has even opened, calls
 *  queue until it has. */
type Connection = { api: RpcStub<IterateSessionApi>; socket: WebSocket; dispose(): void };
function connectionOn(socket: WebSocket): Connection {
  const iterate = newWebSocketRpcSession<IterateApi>(socket);
  const api = iterate.authenticate({
    type: "from-server-cookie",
  }) as unknown as RpcStub<IterateSessionApi>;
  return { api, socket, dispose: () => iterate[Symbol.dispose]() };
}

/** Create once per app — a TanStack route's client-only `beforeLoad`, or a plain page's entry.
 *  Every loader and action of the page shares the returned public RPC session.
 *
 *  Connecting tries for a while (client/socket.ts: ≈16 s of attempts) before an error reaches the
 *  page — a phone waking up or a flapping tunnel is not a reason to show "connection failed". And
 *  the `api` the page holds is a proxy to the CURRENT connection: when the socket closes, the next
 *  call opens a fresh one and pipelines onto it, so a dropped connection costs a reconnect, not the
 *  page. A reconnect the platform refuses (the session ended elsewhere) rejects that call; the
 *  page's retry runs `authenticate` again — a fresh one, the socket's close forgot the last — whose
 *  probe sends the browser to log in. */
export function createIterateClient(options: { scopes?: string[] } = {}): IterateClient {
  const scopes = OAuthScopes.parse(options.scopes || []);
  let live: Connection | null = null;
  let connecting: Promise<AuthenticatedApp> | undefined;
  const socketUrl = () => {
    const url = new URL("/api", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  };
  /** Adopt a connection as the live one until its socket closes. A close also forgets the settled
   *  `authenticate` — the next one probes `/api` again, so a session that ended elsewhere sends the
   *  browser to log in instead of a retry that can only fail. */
  function adopt(socket: WebSocket): Connection {
    const connection = connectionOn(socket);
    live = connection;
    const forget = () => {
      if (live !== connection) return;
      live = null;
      connecting = undefined;
    };
    const dispose = () => {
      forget();
      connection.dispose();
    };
    socket.addEventListener(
      "close",
      () => {
        forget();
        window.removeEventListener("pagehide", dispose);
      },
      { once: true },
    );
    window.addEventListener("pagehide", dispose, { once: true });
    return connection;
  }
  // Every property read goes to the live connection — or to a fresh one when the last socket
  // closed (a new WebSocket, no wait: capnweb queues the call until it opens). What comes back is
  // capnweb's own stub for that property — a method stub carries its path, so it is returned as
  // is, never bound or otherwise touched (a capnweb stub answers `.bind` with another stub).
  const api = new Proxy({} as RpcStub<IterateSessionApi>, {
    get(_target, property) {
      const connection = live || adopt(new WebSocket(socketUrl()));
      return Reflect.get(connection.api as object, property);
    },
  });
  async function connect(next: string): Promise<AuthenticatedApp> {
    const login = `/.auth/login?${new URLSearchParams({ next, scope: scopes.join(" ") })}`;
    // HTTP distinguishes 401 from outages; a failed WebSocket is not evidence
    // that the visitor needs to log in. Errors reach the route's error boundary.
    const probe = await fetch("/api", {
      method: "POST",
      body: "",
      signal: AbortSignal.timeout(10_000),
    });
    await probe.body?.cancel();
    if (probe.status === 401) return leaveForLogin(login);
    if (!probe.ok) throw new Error(`Iterate is unavailable (${probe.status}). Please retry.`);
    if (!live) adopt(await openSocketWithRetry(socketUrl()));
    // Consent is task-based: the person may have granted fewer scopes than the app asked for
    // (every scope but `iterate` is optional on the consent page). The granted set is
    // `info.scopes` — an app reads it and offers a step-up link (`/.auth/login?scope=…`) for what
    // it lacks; it is never bounced back to consent for a permission the person declined.
    const info = await api.info();
    return { api, info };
  }
  return {
    authenticate(next = "/") {
      connecting ||= connect(next).catch((error) => {
        connecting = undefined;
        throw error;
      });
      return connecting;
    },
  };
}
