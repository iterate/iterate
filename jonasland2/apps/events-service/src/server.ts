import { createServer } from "node:http";
import { ROOT_CONTEXT, context as otelContext, propagation } from "@opentelemetry/api";
import {
  createHandlerLoggingPlugin,
  createServiceLogger,
  getOtelRuntimeConfig,
  initializeServiceOtel,
} from "@jonasland2/orpc-shared";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { eventsRouter } from "./router.ts";

const serviceName = "jonasland2-events-service";
const port = Number(process.env.EVENTS_SERVICE_PORT || "19010");
const log = createServiceLogger(serviceName);
const loggingPlugin = createHandlerLoggingPlugin(log);

initializeServiceOtel(serviceName);

const openapiHandler = new OpenAPIHandler(eventsRouter, {
  plugins: [
    loggingPlugin,
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

function getRequestIdHeader(value: string | string[] | undefined) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value[0]) return value[0];
  return undefined;
}

function extractIncomingTraceContext(headers: Record<string, string | string[] | undefined>) {
  const carrier: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      carrier[key] = value;
    } else if (Array.isArray(value) && value[0]) {
      carrier[key] = value[0];
    }
  }

  return propagation.extract(ROOT_CONTEXT, carrier);
}

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
    const requestId = getRequestIdHeader(req.headers["x-request-id"]);
    const incomingContext = extractIncomingTraceContext(req.headers);
    const { matched } = await otelContext.with(incomingContext, () =>
      openapiHandler.handle(req, res, {
        prefix: "/api",
        context: {
          requestId,
        },
      }),
    );

    if (matched) return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  log.info({
    event: "service.started",
    service: serviceName,
    port,
    docs_path: "/api/docs",
    spec_path: "/api/openapi.json",
    otel: getOtelRuntimeConfig(),
  });
});
