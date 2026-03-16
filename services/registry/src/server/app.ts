import { randomUUID } from "node:crypto";
import { registryServiceManifest } from "@iterate-com/registry-contract";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceOpenAPIHandler,
  createServiceRequestLogger,
  type ServiceAppEnv,
} from "@iterate-com/shared/jonasland";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { getEnv, getStore, serviceName } from "./context.ts";
import { createDbAuthorizeMiddleware } from "./db-browser.ts";
import { router } from "./router.ts";

const env = getEnv();
const app = new Hono<ServiceAppEnv>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

applyServiceMiddleware(app);

const openAPIHandler = createServiceOpenAPIHandler({
  router,
  title: "jonasland registry-service API",
  version: registryServiceManifest.version,
});
const wsHandler = new WebSocketRPCHandler(router);
const dbAuthorize = createDbAuthorizeMiddleware(env);

app.use("/db", dbAuthorize);
app.use("/api/db/*", dbAuthorize);

app.get(
  "/orpc/ws",
  upgradeWebSocket(() => ({
    onOpen: (_evt, ws) => {
      const requestId = randomUUID();
      void wsHandler.upgrade(ws.raw as import("ws").WebSocket, {
        context: {
          requestId,
          serviceName,
          log: createServiceRequestLogger({ requestId, method: "WS", path: "/orpc/ws" }),
          getStore,
          env,
        },
      });
    },
  })),
);

applyOpenAPIRoute(app, openAPIHandler, serviceName, {
  extraContext: () => ({ getStore, env }),
});

export default app;
export { injectWebSocket };
