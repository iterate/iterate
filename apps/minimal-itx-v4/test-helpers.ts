import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import type { UnauthenticatedItx } from "./src/domains/itx/types.ts";

const DEFAULT_BASE_URL = "http://localhost:8791";

export type ItxWebSocketMessage = [timestamp: number, direction: "in" | "out", data: unknown];

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

/** Decode a raw ws frame (outbound string, inbound Buffer/ArrayBuffer) into its parsed JSON value. */
function parseFrame(data: unknown): unknown {
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : undefined;
  return text === undefined ? data : JSON.parse(text);
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

  const start = Date.now();
  const record = (direction: "in" | "out", data: unknown) => {
    input.onWebSocketMessage?.([Date.now() - start, direction, parseFrame(data)]);
  };

  const send = socket.send.bind(socket);
  socket.send = ((data: Parameters<WebSocket["send"]>[0], ...args: unknown[]) => {
    record("out", data);
    return send(data, ...(args as []));
  }) as WebSocket["send"];

  socket.on("message", (data) => record("in", data));

  return newWebSocketRpcSession<UnauthenticatedItx>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}
