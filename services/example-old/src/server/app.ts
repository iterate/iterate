import { createNodeWebSocket } from "@hono/node-ws";
import { exampleServiceManifest } from "@iterate-com/example-old-contract";
import {
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

const { injectWebSocket } = createNodeWebSocket({ app });

applyServiceMiddleware(app);

app.get("/api/observability", createServiceObservabilityHandler(getExampleDbRuntimeConfig));

const openAPIHandler = createServiceOpenAPIHandler({
  router: exampleRouter,
  title: "jonasland example API",
  version: exampleServiceManifest.version,
});

app.all("/api/*", async (c) => {
  const context = {
    requestId: c.get("requestId"),
    serviceName,
    log: c.get("requestLog"),
    request: c.req.raw,
  };
  const { matched, response } = await openAPIHandler.handle(c.req.raw, {
    prefix: "/api",
    context,
  });
  if (matched) return c.newResponse(response.body, response);
  return c.json({ error: "not_found" }, 404);
});

await initializeExampleDb();

export default app;
export { injectWebSocket };
