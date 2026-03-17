import type { WSEvents, WSMessageReceive } from "hono/ws";
import { onError } from "@orpc/server";
import { RPCHandler as WebSocketRPCHandler, type MinimalWebsocket } from "@orpc/server/websocket";
import type { WsTest2Context } from "./context.ts";
import { router } from "./router.ts";

type SharedWSEvents = Pick<WSEvents<any>, "onMessage" | "onClose" | "onError">;

const orpcWebSocketHandler = new WebSocketRPCHandler(router, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

function getRawSocket(ws: { raw?: unknown }, close: (code?: number, reason?: string) => void) {
  if (!ws.raw) {
    close(1011, "raw websocket unavailable");
    return null;
  }

  return ws.raw as MinimalWebsocket;
}

function normalizeMessageData(data: WSMessageReceive) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return data;
  return new Uint8Array(data).slice().buffer;
}

export function createOrpcWebSocketHandlers(params: { context: WsTest2Context }): SharedWSEvents {
  return {
    onMessage(event, ws) {
      const rawSocket = getRawSocket(ws, ws.close.bind(ws));
      if (!rawSocket) return;

      void orpcWebSocketHandler
        .message(rawSocket, normalizeMessageData(event.data), {
          context: params.context,
        })
        .catch((error) => {
          console.error(error);
          ws.close(1011, "oRPC websocket error");
        });
    },
    onClose(_event, ws) {
      const rawSocket = getRawSocket(ws, ws.close.bind(ws));
      if (!rawSocket) return;
      orpcWebSocketHandler.close(rawSocket);
    },
    onError(_event, ws) {
      const rawSocket = getRawSocket(ws, ws.close.bind(ws));
      if (!rawSocket) return;
      orpcWebSocketHandler.close(rawSocket);
    },
  };
}
