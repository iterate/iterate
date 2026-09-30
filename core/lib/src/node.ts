import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import type { IterateApi, SessionCredentials } from "./api.ts";
import { withTimeout } from "./lib.ts";

/** One connection to an Iterate deployment. Dispose the owner to close every child capability and its socket.
 * Operations are never retried: replaying a script could duplicate its effects. */
export type IterateConnection = Disposable & {
  session: Awaited<ReturnType<RpcStub<IterateApi>["authenticate"]>>;
  closed: Promise<{ code: number; reason: string }>;
};

/** THE CONNECTION'S HEARTBEAT: a WebSocket ping every `intervalMs`, which the edge answers without
 *  the Worker. A connection that answers none for `deadAfterMs` is dead and is terminated, so
 *  `closed` resolves and its owner can reconnect. A network that vanishes without a close — a
 *  laptop asleep, a NAT mapping expired — otherwise leaves a socket that never sends, never
 *  receives and never closes: on 2026-09-25 an idle `iterate tunnel` sat 55 minutes behind a
 *  carrier NAT that had dropped its mapping, its visitors hanging, the CLI unaware. The pings are
 *  also the traffic that keeps such a mapping from expiring. */
const HEARTBEAT = { intervalMs: 15_000, deadAfterMs: 45_000 };

// Explicit return type keeps declaration emit from expanding capnweb's recursive mapped types.
export async function connectIterate(input: {
  baseUrl: string;
  auth: SessionCredentials;
  /** the heartbeat's timing — a test's, `HEARTBEAT` otherwise */
  heartbeat?: { intervalMs: number; deadAfterMs: number };
}): Promise<IterateConnection> {
  const url = new URL("/api", input.baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Iterate URL must use http or https.");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url.href, { handshakeTimeout: 15_000 });
  // ws implements the DOM event/send/close interface consumed by capnweb.
  const root = newWebSocketRpcSession<IterateApi>(socket as unknown as globalThis.WebSocket);
  const heartbeat = input.heartbeat || HEARTBEAT;
  let lastPongAt = Date.now();
  let dead = "";
  socket.on("pong", () => (lastPongAt = Date.now()));
  const pinger = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPongAt < heartbeat.deadAfterMs) return socket.ping();
    dead = `no answer to a WebSocket ping for ${heartbeat.deadAfterMs / 1000} s`;
    socket.terminate();
  }, heartbeat.intervalMs);
  pinger.unref(); // the heartbeat never keeps a finished script's process alive
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => {
      clearInterval(pinger);
      resolve({ code, reason: dead || reason.toString() });
    });
  });
  // The transport surfaces failures through RPC and `closed`; ws also emits an EventEmitter error.
  socket.on("error", () => {});
  try {
    const session = await withTimeout(
      root.authenticate(input.auth),
      20_000,
      "Iterate authentication",
    );
    return {
      session,
      closed,
      [Symbol.dispose]() {
        try {
          session[Symbol.dispose]();
        } finally {
          try {
            root[Symbol.dispose]();
          } finally {
            socket.close();
          }
        }
      },
    };
  } catch (error) {
    try {
      root[Symbol.dispose]();
    } finally {
      socket.terminate();
    }
    throw error;
  }
}
