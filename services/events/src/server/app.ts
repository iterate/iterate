import { randomUUID } from "node:crypto";
import type { ServiceAppEnv } from "@iterate-com/shared/jonasland";
import { createNodeWebSocket } from "@hono/node-ws";
import { serviceManifest } from "@iterate-com/events-contract";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceObservabilityHandler,
  createServiceOpenAPIHandler,
  createServiceRequestLogger,
  getOtelRuntimeConfig,
  initializeServiceEvlog,
  initializeServiceOtel,
  serviceLog,
} from "@iterate-com/shared/jonasland";
import { Hono } from "hono";
import { RPCHandler } from "@orpc/server/fetch";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { getEventsDbRuntimeConfig } from "../db.ts";
import { disposeEventsRouterOperations, eventsRouter } from "../router.ts";

const serviceName = "jonasland-events-service";

initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

const app = new Hono<ServiceAppEnv>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

applyServiceMiddleware(app);

const wsHandler = new WebSocketRPCHandler(eventsRouter);
const rpcHandler = new RPCHandler(eventsRouter);

app.get(
  "/orpc/ws",
  upgradeWebSocket(() => ({
    onOpen: (_evt, ws) => {
      const requestId = randomUUID();
      serviceLog.info({ event: "orpc.ws.upgrade", pathname: "/orpc/ws" });
      void wsHandler.upgrade(ws.raw as import("ws").WebSocket, {
        context: {
          requestId,
          serviceName,
          log: createServiceRequestLogger({
            requestId,
            method: "WS",
            path: "/orpc/ws",
          }),
        },
      });
    },
  })),
);

app.all("/orpc/*", async (c) => {
  const context = {
    requestId: c.get("requestId"),
    serviceName,
    log: c.get("requestLog"),
  };
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: "/orpc",
    context,
  });
  if (matched) return c.newResponse(response.body, response);
  return c.json({ error: "not_found" }, 404);
});

app.get("/api/observability", createServiceObservabilityHandler(getEventsDbRuntimeConfig));

const openAPIHandler = createServiceOpenAPIHandler({
  router: eventsRouter,
  title: "jonasland events-service API",
  version: serviceManifest.version,
});

applyOpenAPIRoute(app, openAPIHandler, serviceName);

export { disposeEventsRouterOperations };
export default app;
export { injectWebSocket, serviceName, getOtelRuntimeConfig };
