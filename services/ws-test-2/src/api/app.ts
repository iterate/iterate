import type { HttpBindings } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { createContext } from "./context.ts";
import { createConfettiSocketHandlers } from "./confetti.ts";
import { applySharedHttpRoutes } from "./http-app.ts";
import { createPtyRouter } from "./pty.ts";

const app = new Hono<{ Bindings: HttpBindings }>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

applySharedHttpRoutes(app, {
  getContext: () => createContext(),
});

app.get(
  "/api/confetti/ws",
  upgradeWebSocket(() => createConfettiSocketHandlers()),
);

app.route("/api/pty", createPtyRouter({ upgradeWebSocket }));

export default app;
export { injectWebSocket };
