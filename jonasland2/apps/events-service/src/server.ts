import { serve } from "@hono/node-server";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { eventsRouter } from "./router.ts";
import { getOtelConfig, initializeOtel, withSpan } from "./otel-init.ts";

const serviceName = "jonasland2-events-service";
const port = Number(process.env.EVENTS_SERVICE_PORT || "19010");

initializeOtel(serviceName);

const openapiHandler = new OpenAPIHandler(eventsRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "jonasland2 events-service API",
          version: "1.0.0",
        },
        servers: [{ url: "/api" }],
      },
    }),
  ],
});

const app = new Hono();

app.use("*", async (c, next) => {
  return withSpan(
    serviceName,
    "http.request",
    {
      "http.method": c.req.method,
      "http.route": c.req.path,
    },
    async () => next(),
  );
});

app.get("/healthz", (c) => c.text("ok"));

app.get("/api/observability", (c) => {
  return c.json({
    otel: getOtelConfig(),
  });
});

app.all("/api/*", async (c) => {
  const { matched, response } = await openapiHandler.handle(c.req.raw, {
    prefix: "/api",
    context: {},
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  return c.json({ error: "not_found" }, 404);
});

serve({
  fetch: app.fetch,
  port,
  hostname: "0.0.0.0",
});

console.log(
  JSON.stringify({
    event: "events_service_started",
    service: serviceName,
    port,
    otel: getOtelConfig(),
    docsPath: "/api/docs",
    specPath: "/api/openapi.json",
  }),
);
