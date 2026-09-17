import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { redirect } from "@tanstack/react-router";
import type { IterateApi, IterateSessionApi } from "./api.ts";
import { OAuthScopes } from "./oauth-scopes.ts";

/** What `authenticate` resolves to: the session as a capnweb stub (pipelined; disposable) and the
 *  bootstrap info it answered with. Declared, so the package's declarations stay serializable. */
export type AuthenticatedApp = {
  api: RpcStub<IterateSessionApi>;
  info: ReturnType<IterateSessionApi["info"]>;
};
export type IterateClient = { authenticate(next?: string): Promise<AuthenticatedApp> };

/** Create once per TanStack app. Call authenticate in a client-only route's
 * beforeLoad; route loaders and actions share the returned public RPC session. */
export function createIterateClient(options: { scopes?: string[] } = {}): IterateClient {
  const scopes = OAuthScopes.parse(options.scopes || []);
  let connecting: Promise<AuthenticatedApp> | undefined;
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
    if (probe.status === 401) throw redirect({ href: login, reloadDocument: true });
    if (!probe.ok) throw new Error(`Iterate is unavailable (${probe.status}). Please retry.`);
    const url = new URL("/api", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    // The public root is the IterateApi (os-next's IterateRpcTarget satisfies it); `authenticate({ from-server-cookie })` vends the
    // session the OAuth gate already resolved. capnweb pipelines, so `api` is usable immediately.
    const iterate = newWebSocketRpcSession<IterateApi>(socket);
    const api = iterate.authenticate({ type: "from-server-cookie" });
    const dispose = () => {
      iterate[Symbol.dispose]();
      connecting = undefined;
    };
    socket.addEventListener(
      "close",
      () => {
        connecting = undefined;
        window.removeEventListener("pagehide", dispose);
      },
      { once: true },
    );
    window.addEventListener("pagehide", dispose, { once: true });
    try {
      const info = await api.info();
      if (!scopes.every((scope) => info.scopes.includes(scope))) {
        dispose();
        throw redirect({ href: login, reloadDocument: true });
      }
      // The pipelined  answer IS the session stub (capnweb: a promise that proxies).
      return { api: api as unknown as RpcStub<IterateSessionApi>, info };
    } catch (error) {
      dispose();
      throw error;
    }
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
