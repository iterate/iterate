import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { ROOT_CONTEXT, context as otelContext, propagation } from "@opentelemetry/api";
import react from "@vitejs/plugin-react";
import {
  createHandlerLoggingPlugin,
  createServiceLogger,
  getOtelRuntimeConfig,
  initializeServiceOtel,
} from "@jonasland2/orpc-shared";
import { eventsServiceManifest } from "@jonasland2/events-contract";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { createServer as createViteServer, type Plugin, type ViteDevServer } from "vite";
import { initializeEventsDb } from "./db.ts";
import { eventsRouter } from "./router.ts";

const BROWSER_ERROR_EVENT = "events-service:browser-console-error";
const serviceName = "jonasland2-events-service";
const env = eventsServiceManifest.envVars.parse(process.env);
const port = env.EVENTS_SERVICE_PORT;
const log = createServiceLogger(serviceName);
const loggingPlugin = createHandlerLoggingPlugin(log);

initializeServiceOtel(serviceName);

const browserErrorBridgePlugin = (): Plugin => ({
  name: "events-service-browser-error-bridge",
  configureServer(server) {
    server.ws.on(BROWSER_ERROR_EVENT, (payload) => {
      log.error({
        event: "events-ui.browser-error",
        payload,
      });
    });
  },
  transformIndexHtml() {
    return [
      {
        tag: "script",
        attrs: { type: "module" },
        injectTo: "body",
        children: `
          if (import.meta.hot) {
            const normalizeErrorData = (value) => {
              if (value instanceof Error) {
                return { name: value.name, message: value.message, stack: value.stack ?? null };
              }
              if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
                return value;
              }
              try {
                return JSON.parse(JSON.stringify(value));
              } catch {
                return String(value);
              }
            };
            const send = (kind, data) => {
              import.meta.hot.send("${BROWSER_ERROR_EVENT}", {
                kind,
                data,
                href: location.href,
                userAgent: navigator.userAgent,
                timestamp: new Date().toISOString(),
              });
            };
            const originalConsoleError = console.error.bind(console);
            console.error = (...args) => {
              send("console.error", { args: args.map(normalizeErrorData) });
              originalConsoleError(...args);
            };
            window.addEventListener("error", (event) => {
              send("window.error", {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                error: normalizeErrorData(event.error),
              });
            });
            window.addEventListener("unhandledrejection", (event) => {
              send("window.unhandledrejection", {
                reason: normalizeErrorData(event.reason),
              });
            });
          }
        `,
      },
    ];
  },
});

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

let vite: ViteDevServer | undefined;

async function handleViteRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>) {
  const viteServer = vite;
  if (!viteServer) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "ui_not_ready" }));
    return;
  }

  await new Promise<void>((resolve) => {
    viteServer.middlewares(req, res, () => {
      if (!res.writableEnded) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      }
      resolve();
    });
  });
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (pathname === "/api/observability" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ otel: getOtelRuntimeConfig() }));
    return;
  }

  if (pathname.startsWith("/api")) {
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

    if (matched) {
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  await handleViteRequest(req, res);
});

await initializeEventsDb();

vite = await createViteServer({
  configFile: false,
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  plugins: [react(), browserErrorBridgePlugin()],
  appType: "spa",
  server: {
    middlewareMode: true,
    hmr: { server },
  },
});

server.listen(port, "0.0.0.0", () => {
  log.info({
    event: "service.started",
    service: serviceName,
    port,
    docs_path: "/api/docs",
    spec_path: "/api/openapi.json",
    ui_path: "/",
    otel: getOtelRuntimeConfig(),
  });
});

const shutdown = async () => {
  await Promise.allSettled([vite?.close() ?? Promise.resolve()]);
  server.close(() => process.exit(0));
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
