import { newWebSocketRpcSession } from "capnweb";
import { WebSocket } from "undici";
import type { SessionCredentials } from "iterate/next/api";

const connections: { socket: WebSocket; rpc: Disposable }[] = [];

export function adminCredentials(): SessionCredentials {
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret) throw new Error("ADMIN_API_SECRET is required");
  return { type: "admin-secret", secret };
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
