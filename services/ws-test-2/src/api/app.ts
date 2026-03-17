import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents, WSMessageReceive } from "hono/ws";
import { onError } from "@orpc/server";
import { RPCHandler as WebSocketRPCHandler, type MinimalWebsocket } from "@orpc/server/websocket";
import type { WsTest2ServiceEnv } from "../manifest.ts";
import { createConfettiSocketHandlers } from "./confetti.ts";
import { createOrpcContext } from "./context.ts";
import { applySharedHttpRoutes } from "./http-app.ts";
import { router } from "./router.ts";

type SharedWSEvents = Pick<WSEvents<any>, "onMessage" | "onClose" | "onError">;

type RuntimeWebSocketAdapter = {
  upgradeWebSocket: UpgradeWebSocket<any, any, SharedWSEvents>;
};

type CreateAppParams<TBindings extends object, TRuntime extends RuntimeWebSocketAdapter> = {
  env: WsTest2ServiceEnv;
  createWebSocketRuntime: (app: Hono<{ Bindings: TBindings }>) => TRuntime;
  createPtyApp?: (params: {
    upgradeWebSocket: TRuntime["upgradeWebSocket"];
  }) => Hono<any> | undefined | Promise<Hono<any> | undefined>;
};

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

function createOrpcWebSocketHandlers(params: {
  context: ReturnType<typeof createOrpcContext>;
}): SharedWSEvents {
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

export async function createApp<TBindings extends object, TRuntime extends RuntimeWebSocketAdapter>(
  params: CreateAppParams<TBindings, TRuntime>,
) {
  const app = new Hono<{ Bindings: TBindings }>();
  const runtime = params.createWebSocketRuntime(app);
  const ptyApp = params.createPtyApp
    ? await params.createPtyApp({
        upgradeWebSocket: runtime.upgradeWebSocket,
      })
    : undefined;
  const createRequestContext = (_c: Context) => createOrpcContext(params.env);

  app.get(
    "/api/orpc/ws",
    runtime.upgradeWebSocket(
      (c) =>
        createOrpcWebSocketHandlers({
          context: createRequestContext(c),
        }),
      { protocol: "orpc" },
    ),
  );

  app.get(
    "/api/confetti/ws",
    runtime.upgradeWebSocket(() => createConfettiSocketHandlers()),
  );

  if (ptyApp) {
    app.route("/api/pty", ptyApp);
  }

  applySharedHttpRoutes(app, {
    createOrpcContext: createRequestContext,
  });

  return {
    app,
    ...runtime,
  };
}
