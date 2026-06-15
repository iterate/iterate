import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { StreamRpc } from "~/domains/streams/engine/types.ts";

export type WebSocketFrame = {
  direction: "in" | "out";
  data: string;
  byteLength: number;
  timestamp: number;
};

export type StreamConnection = Disposable & {
  stream: RpcStub<StreamRpc>;
  onWebSocketFrame(listener: (frame: WebSocketFrame) => void): Disposable;
};

export function streamConnectionFromWebSocket(webSocket: WebSocket): StreamConnection {
  const frameListeners = new Set<(frame: WebSocketFrame) => void>();
  const send = webSocket.send.bind(webSocket);
  webSocket.send = ((data: Parameters<WebSocket["send"]>[0]) => {
    emitFrame(frameListeners, "out", data);
    return send(data);
  }) as WebSocket["send"];
  webSocket.addEventListener("message", (event) => emitFrame(frameListeners, "in", event.data));

  const stream = newWebSocketRpcSession<StreamRpc>(webSocket);
  return {
    stream,
    onWebSocketFrame(listener) {
      frameListeners.add(listener);
      return {
        [Symbol.dispose]() {
          frameListeners.delete(listener);
        },
      };
    },
    [Symbol.dispose]() {
      stream[Symbol.dispose]();
      // capnweb has already flushed; closing is fire-and-forget.
      if (webSocket.readyState !== WebSocket.CLOSED) webSocket.close();
    },
  };
}

export function toWebSocketUrl(url: string | URL) {
  const webSocketUrl = new URL(url);
  if (webSocketUrl.protocol === "http:") webSocketUrl.protocol = "ws:";
  if (webSocketUrl.protocol === "https:") webSocketUrl.protocol = "wss:";
  return webSocketUrl;
}

function emitFrame(
  listeners: Set<(frame: WebSocketFrame) => void>,
  direction: "in" | "out",
  data: unknown,
) {
  if (listeners.size === 0) return;
  const text = describeWebSocketFrameData(data);
  const frame = {
    direction,
    data: text,
    byteLength: new TextEncoder().encode(text).byteLength,
    timestamp: Date.now(),
  };
  for (const listener of listeners) listener(frame);
}

function describeWebSocketFrameData(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  throw new TypeError(`unexpected WebSocket frame data: ${String(data)}`);
}
