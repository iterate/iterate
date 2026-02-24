import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { ROOT_CONTEXT, context as otelContext, propagation } from "@opentelemetry/api";
import react from "@vitejs/plugin-react";
import { ordersServiceManifest } from "@jonasland2/orders-contract";
import {
  createBrowserErrorBridgePlugin,
  createOpenApiHandlerWithDocs,
  createRpcHttpHandler,
  createRpcWebSocketBridge,
  createServiceLogger,
  extractIncomingTraceContext,
  getOtelRuntimeConfig,
  getRequestIdHeader,
  handleViteSpaRequest,
  initializeServiceOtel,
} from "@jonasland2/shared";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { getOrdersDbRuntimeConfig, initializeOrdersDb } from "./db.ts";
import { ordersRouter } from "./router.ts";

const BROWSER_ERROR_EVENT = "orders-service:browser-console-error";
const serviceName = "jonasland2-orders-service";
const env = ordersServiceManifest.envVars.parse(process.env);
const port = env.ORDERS_SERVICE_PORT;
const log = createServiceLogger(serviceName);

initializeServiceOtel(serviceName);

const openapiHandler = createOpenApiHandlerWithDocs({
  router: ordersRouter,
  logger: log,
  title: "jonasland2 orders-service API",
  version: "1.0.0",
});

const rpcHandler = createRpcHttpHandler({
  router: ordersRouter,
  logger: log,
});

const rpcWebSocketBridge = createRpcWebSocketBridge({
  router: ordersRouter,
  logger: log,
  upgradePath: "/orpc/ws",
});

let vite: ViteDevServer | undefined;

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (pathname === "/api/observability" && req.method === "GET") {
    const sqlite = await getOrdersDbRuntimeConfig();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ otel: getOtelRuntimeConfig(), sqlite }));
    return;
  }

  if (pathname.startsWith("/api")) {
    const requestId = getRequestIdHeader(req.headers["x-request-id"]);
    const incomingContext = extractIncomingTraceContext(req.headers, (carrier) =>
      propagation.extract(ROOT_CONTEXT, carrier),
    );

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

  if (pathname.startsWith("/orpc")) {
    const requestId = getRequestIdHeader(req.headers["x-request-id"]);
    const incomingContext = extractIncomingTraceContext(req.headers, (carrier) =>
      propagation.extract(ROOT_CONTEXT, carrier),
    );

    const { matched } = await otelContext.with(incomingContext, () =>
      rpcHandler.handle(req, res, {
        prefix: "/orpc",
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

  await handleViteSpaRequest({
    vite,
    req,
    res: res as ServerResponse<IncomingMessage>,
  });
});

server.on("upgrade", (req, socket, head) => {
  const upgraded = rpcWebSocketBridge.handleUpgrade(req, socket, head);
  if (!upgraded) {
    socket.destroy();
  }
});

await initializeOrdersDb();

vite = await createViteServer({
  configFile: false,
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  plugins: [
    react(),
    createBrowserErrorBridgePlugin({
      eventName: BROWSER_ERROR_EVENT,
      logEventName: "orders-ui.browser-error",
      logger: log,
    }),
  ],
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
    orpc_path: "/orpc",
    orpc_ws_path: "/orpc/ws",
    ui_path: "/",
    otel: getOtelRuntimeConfig(),
  });
});

const shutdown = async () => {
  await Promise.allSettled([vite?.close() ?? Promise.resolve(), rpcWebSocketBridge.close()]);
  server.close(() => process.exit(0));
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
