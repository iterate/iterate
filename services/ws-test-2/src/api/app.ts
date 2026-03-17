import { Hono, type Context } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import type { WsTest2ServiceEnv } from "../manifest.ts";
import { createConfettiSocketHandlers } from "./confetti.ts";
import { createOrpcWebSocketHandlers } from "./orpc-websocket.ts";
import { createOrpcContext } from "./context.ts";
import { applySharedHttpRoutes } from "./http-app.ts";

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
