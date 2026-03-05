import type { HttpBindings } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { exampleServiceManifest } from "@iterate-com/example-contract";
import {
  applyOpenAPIRoute,
  applyServiceMiddleware,
  createServiceObservabilityHandler,
  createServiceOpenAPIHandler,
  initializeServiceEvlog,
  initializeServiceOtel,
  type ServiceAppEnv,
} from "@iterate-com/shared/jonasland";
import { Hono } from "hono";
import { getExampleDbRuntimeConfig, initializeExampleDb } from "../db.ts";
import { exampleRouter } from "../router.ts";

const serviceName = "jonasland-example";

initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

const app = new Hono<ServiceAppEnv>();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

applyServiceMiddleware(app);

app.get("/api/observability", createServiceObservabilityHandler(getExampleDbRuntimeConfig));

app.all("/api/echo", async (c) => {
  const request = c.req.raw;
  const bodyText = await request.clone().text();
  return c.json({
    method: request.method,
    url: request.url,
    host: request.headers.get("host") ?? "",
    headers: Object.fromEntries(request.headers.entries()),
    body: bodyText,
  });
});

const openAPIHandler = createServiceOpenAPIHandler({
  router: exampleRouter,
  title: "jonasland example API",
  version: exampleServiceManifest.version,
});

applyOpenAPIRoute(app, openAPIHandler, serviceName);

await initializeExampleDb();

export default app;
export { injectWebSocket };
