import { newWebSocketRpcSession } from "capnweb";
import { redirect } from "@tanstack/react-router";
import type { Session } from "../session.ts";
import { OAuthScopes } from "../oauth-scopes.ts";

/** Create once per TanStack app. Call authenticate in a client-only route's
 * beforeLoad; route loaders and actions share the returned public RPC session. */
export function createIterateClient(options: { scopes?: string[] } = {}) {
  const scopes = OAuthScopes.parse(options.scopes ?? []);
  let connecting: ReturnType<typeof connect> | undefined;
  async function connect(next: string) {
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
    const api = newWebSocketRpcSession<Session>(socket);
    const dispose = () => {
      api[Symbol.dispose]();
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
      return { api, info };
    } catch (error) {
      dispose();
      throw error;
    }
  }
  return {
    authenticate(next = "/") {
      connecting ??= connect(next).catch((error) => {
        connecting = undefined;
        throw error;
      });
      return connecting;
    },
  };
}
export type AuthenticatedApp = Awaited<
  ReturnType<ReturnType<typeof createIterateClient>["authenticate"]>
>;
