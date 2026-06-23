import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import type { UnauthenticatedItx } from "./types.ts";

const DEFAULT_BASE_URL = "http://localhost:8791";

export type ItxWebSocketMessage = {
  byteLength: number;
  data: unknown;
  direction: "in" | "out";
  timestamp: number;
};

export function buildUrl({
  path,
  protocol = "http",
}: {
  path: string;
  protocol?: "ws" | "http";
}): string {
  const url = new URL(path, process.env.ITX_BASE_URL ?? DEFAULT_BASE_URL);
  if (protocol === "ws") {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  }
  return url.toString();
}

function byteLength(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + byteLength(chunk), 0);
  return 0;
}

/**
 * Returns a bog standard capnweb websocket RpcStub using newWebSocketRpcSession but allows
 * the caller to pass in a function to record the websocket messages.
 */
export function withItxSession(
  input: {
    onWebSocketMessage?: (message: ItxWebSocketMessage) => void;
  } = {},
): RpcStub<UnauthenticatedItx> {
  const socket = new WebSocket(buildUrl({ path: "/api/itx", protocol: "ws" }), {
    handshakeTimeout: 10_000,
  });

  const record = (message: Omit<ItxWebSocketMessage, "byteLength" | "timestamp">) => {
    input.onWebSocketMessage?.({
      ...message,
      byteLength: byteLength(message.data),
      timestamp: Date.now(),
    });
  };

  const send = socket.send.bind(socket);
  socket.send = ((data: Parameters<WebSocket["send"]>[0], ...args: unknown[]) => {
    record({ data, direction: "out" });
    return send(data, ...(args as []));
  }) as WebSocket["send"];

  socket.on("message", (data) => record({ data, direction: "in" }));

  return newWebSocketRpcSession<UnauthenticatedItx>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}
