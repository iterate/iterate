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
    orpcWebSocketHandlers: Record<string, unknown>;
    ptyApp?: Hono<any>;
  },
) {
  app.get(
    "/api/orpc/ws",
    params.upgradeWebSocket(() => params.orpcWebSocketHandlers),
  );

  app.get(
    "/api/confetti/ws",
    params.upgradeWebSocket(() => createConfettiSocketHandlers()),
  );

  if (params.ptyApp) {
    app.route("/api/pty", params.ptyApp);
  }

  applySharedHttpRoutes(app, {
    getContext: params.getContext,
  });
}
