import { Hono } from "hono";
import { createContext } from "./context.ts";
import { createConfettiSocketHandlers } from "./confetti.ts";
import { applySharedHttpRoutes } from "./http-app.ts";

type UpgradeWebSocket = (...args: any[]) => any;

export function configureApp(
  app: Hono<any>,
  params: {
    upgradeWebSocket: UpgradeWebSocket;
    getContext: () => ReturnType<typeof createContext>;
    createOrpcWebSocketHandlers: () => Record<string, unknown>;
    createPtyApp?: (params: { upgradeWebSocket: UpgradeWebSocket }) => Hono<any>;
  },
) {
  app.get(
    "/api/orpc/ws",
    params.upgradeWebSocket(() => params.createOrpcWebSocketHandlers()),
  );

  app.get(
    "/api/confetti/ws",
    params.upgradeWebSocket(() => createConfettiSocketHandlers()),
  );

  const ptyApp = params.createPtyApp?.({ upgradeWebSocket: params.upgradeWebSocket });
  if (ptyApp) {
    app.route("/api/pty", ptyApp);
  }

  applySharedHttpRoutes(app, {
    getContext: params.getContext,
  });
}
