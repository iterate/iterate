import { randomUUID } from "node:crypto";
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { ROOT_CONTEXT, context as otelContext, propagation } from "@opentelemetry/api";
import { ordersServiceManifest } from "@jonasland5/orders-contract";
import {
  createOrpcErrorInterceptor,
  createHealthzHandler,
  createServiceObservabilityHandler,
  createServiceRequestLogger,
  extractIncomingTraceContext,
  getOtelRuntimeConfig,
  getRequestIdHeader,
  initializeServiceEvlog,
  initializeServiceOtel,
  serviceLog,
  type ServiceRequestLogger,
} from "@jonasland5/shared";
import { Hono, type Context } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { RPCHandler } from "@orpc/server/fetch";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { WebSocketServer, type WebSocket } from "ws";
import { getOrdersDbRuntimeConfig, initializeOrdersDb } from "./db.ts";
import { ordersRouter } from "./router.ts";

type AppVariables = {
  requestId: string;
  requestLog: ServiceRequestLogger;
};

const BODY_PARSER_METHODS = new Set(["arrayBuffer", "blob", "formData", "json", "text"] as const);
type BodyParserMethod = typeof BODY_PARSER_METHODS extends Set<infer T> ? T : never;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createBodyParserSafeRequest(
  c: Context<{ Bindings: HttpBindings; Variables: AppVariables }>,
): Request {
  return new Proxy(c.req.raw, {
    get(target, prop) {
      if (BODY_PARSER_METHODS.has(prop as BodyParserMethod)) {
        return () => c.req[prop as BodyParserMethod]();
      }

      return Reflect.get(target, prop, target);
    },
  });
}

const serviceName = "jonasland5-orders-service";
const env = ordersServiceManifest.envVars.parse(process.env);
const port = env.ORDERS_SERVICE_PORT;

initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

const openAPIHandler = new OpenAPIHandler(ordersRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "jonasland5 orders-service API",
          version: ordersServiceManifest.version,
        },
        servers: [{ url: "/api" }],
      },
    }),
  ],
  interceptors: [createOrpcErrorInterceptor()],
});

const rpcHandler = new RPCHandler(ordersRouter, {
  interceptors: [createOrpcErrorInterceptor()],
});

const wsHandler = new WebSocketRPCHandler(ordersRouter);
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket) => {
  const requestId = randomUUID();
  void wsHandler.upgrade(ws, {
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
});

const app = new Hono<{ Bindings: HttpBindings; Variables: AppVariables }>();

app.use("*", async (c, next) => {
  const incomingContext = extractIncomingTraceContext(c.req.raw.headers, (carrier) =>
    propagation.extract(ROOT_CONTEXT, carrier),
  );

  return otelContext.with(incomingContext, next);
});

app.use("*", async (c, next) => {
  const requestId = getRequestIdHeader(c.req.header("x-request-id")) ?? randomUUID();
  const requestLog = createServiceRequestLogger({
    requestId,
    method: c.req.method,
    path: c.req.path,
  });
  const startedAt = Date.now();

  c.set("requestId", requestId);
  c.set("requestLog", requestLog);

  let status = 500;

  try {
    await next();
    status = c.res.status;
  } catch (error) {
    requestLog.error(toError(error));
    status = 500;
    throw error;
  } finally {
    const outgoingStatus = c.env.outgoing.statusCode;
    if (typeof outgoingStatus === "number" && outgoingStatus > 0) {
      status = outgoingStatus;
    }

    requestLog.emit({
      status,
      durationMs: Date.now() - startedAt,
    });
  }
});

app.get("/healthz", createHealthzHandler());
app.get("/api/observability", createServiceObservabilityHandler(getOrdersDbRuntimeConfig));

app.all("/orpc/*", async (c) => {
  const { matched, response } = await rpcHandler.handle(createBodyParserSafeRequest(c), {
    prefix: "/orpc",
    context: {
      requestId: c.get("requestId"),
      serviceName,
      log: c.get("requestLog"),
    },
  });

  if (matched) return c.newResponse(response.body, response);
  return c.json({ error: "not_found" }, 404);
});

app.all("/api/*", async (c) => {
  const { matched, response } = await openAPIHandler.handle(c.req.raw, {
    prefix: "/api",
    context: {
      requestId: c.get("requestId"),
      serviceName,
      log: c.get("requestLog"),
    },
  });

  if (matched) return c.newResponse(response.body, response);
  return c.json({ error: "not_found" }, 404);
});

app.all("*", (c) => c.json({ error: "not_found" }, 404));

const server = createAdaptorServer({ fetch: app.fetch });

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname !== "/orpc/ws" && pathname !== "/orpc/ws/") {
    socket.destroy();
    return;
  }

  serviceLog.info({ event: "orpc.ws.upgrade", pathname });
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

await initializeOrdersDb();

server.listen(port, "0.0.0.0", () => {
  serviceLog.info({
    event: "service.started",
    service: serviceName,
    port,
    docs_path: "/api/docs",
    spec_path: "/api/openapi.json",
    orpc_path: "/orpc",
    orpc_ws_path: "/orpc/ws",
    otel: getOtelRuntimeConfig(),
  });
});

const shutdown = async () => {
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });

  server.close(() => process.exit(0));
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
