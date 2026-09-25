import { newWebSocketRpcSession } from "capnweb";
import { WebSocket } from "undici";
import type { SessionCredentials } from "iterate/api";

const connections: { socket: WebSocket; rpc: Disposable }[] = [];

/** The person's personal access token for the project (apps/os/docs/credentials.md), presented
 *  in-band on the bare socket `session()` opens; or, for a project no token at hand covers,
 *  APP_CONFIG_ADMIN_API_SECRET, the deployment's operator secret. */
export function credentials(): SessionCredentials {
  const operator = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (operator) return { type: "admin-secret", secret: operator };
  const token = process.env.ITERATE_BEARER_TOKEN;
  if (!token)
    throw new Error(
      "ITERATE_BEARER_TOKEN is required: a personal access token for the project (`pnpm exec iterate tokens create`, or the Dash's Sessions page)",
    );
  return { type: "bearer", token };
}

/** App scripts call installed capabilities such as voice, which are outside the platform's types. */
export function session(): any {
  const origin = process.env.WORKER_BASE_URL;
  if (!origin) throw new Error("WORKER_BASE_URL is required");
  const url = new URL("/api", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  // Undici implements the WebSocket transport capnweb expects; Workers adds unrelated members.
  const rpc = newWebSocketRpcSession(socket as unknown as globalThis.WebSocket);
  connections.push({ socket, rpc });
  return rpc;
}

export function disposeSessions(): void {
  for (const { socket, rpc } of connections.splice(0)) {
    rpc[Symbol.dispose]();
    socket.close();
  }
}
