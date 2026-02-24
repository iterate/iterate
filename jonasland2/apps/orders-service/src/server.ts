import { createServer } from "node:http";
import {
  createServiceLogger,
  getOtelRuntimeConfig,
  initializeServiceOtel,
} from "@jonasland2/orpc-shared";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { ordersRouter } from "./router.ts";

const serviceName = "jonasland2-orders-service";
const port = Number(process.env.ORDERS_SERVICE_PORT || "19020");
const log = createServiceLogger(serviceName);

initializeServiceOtel(serviceName);

const openapiHandler = new OpenAPIHandler(ordersRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "jonasland2 orders-service API",
          version: "1.0.0",
        },
        servers: [{ url: "/api" }],
      },
    }),
  ],
});

const server = createServer(async (req, res) => {
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.url === "/api/observability" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ otel: getOtelRuntimeConfig() }));
    return;
  }

  if ((req.url || "").startsWith("/api")) {
    const { matched } = await openapiHandler.handle(req, res, {
      prefix: "/api",
      context: {},
    });

    if (matched) return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  log("service.started", {
    port,
    docs_path: "/api/docs",
    spec_path: "/api/openapi.json",
    otel: getOtelRuntimeConfig(),
  });
});
