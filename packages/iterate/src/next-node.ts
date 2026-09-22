import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import type { IterateApi, SessionCredentials } from "./next/api.ts";

/** One OS Next connection. Dispose the owner to close every child capability and its socket.
 * Operations are never retried: replaying a script could duplicate its effects. */
export type OsNextConnection = Disposable & {
  session: Awaited<ReturnType<RpcStub<IterateApi>["authenticate"]>>;
  closed: Promise<{ code: number; reason: string }>;
};

// Explicit return type keeps declaration emit from expanding capnweb's recursive mapped types.
export async function connectOsNext(input: {
  baseUrl: string;
  auth: SessionCredentials;
}): Promise<OsNextConnection> {
  const url = new URL("/api", input.baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OS Next URL must use http or https.");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url.href, { handshakeTimeout: 15_000 });
  // ws implements the DOM event/send/close interface consumed by capnweb.
  const root = newWebSocketRpcSession<IterateApi>(socket as unknown as globalThis.WebSocket);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  // The transport surfaces failures through RPC and `closed`; ws also emits an EventEmitter error.
  socket.on("error", () => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = await Promise.race([
      root.authenticate(input.auth),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("OS Next authentication timed out")), 20_000);
      }),
    ]);
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
  } finally {
    clearTimeout(timeout);
  }
}
