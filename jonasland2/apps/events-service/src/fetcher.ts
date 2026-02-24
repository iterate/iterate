import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT, context as otelContext, propagation } from "@opentelemetry/api";
import { eventsServiceManifest, type EventsServiceEnv } from "@jonasland2/events-contract";
import {
  createHealthzHandler,
  createOrpcErrorInterceptor,
  createServiceObservabilityHandler,
  createServiceRequestLogger,
  extractIncomingTraceContext,
  getRequestIdHeader,
  initializeServiceEvlog,
  initializeServiceOtel,
  serviceLog,
  type ServiceRequestLogger,
} from "@jonasland2/shared";
import { Hono, type Context } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { RPCHandler } from "@orpc/server/fetch";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { WebSocketServer } from "ws";
import { getEventsDbRuntimeConfig, initializeEventsDb } from "./db.ts";
import { eventsRouter } from "./router.ts";

type AppVariables = {
  requestId: string;
  requestLog: ServiceRequestLogger;
};

const BODY_PARSER_METHODS = new Set(["arrayBuffer", "blob", "formData", "json", "text"] as const);
type BodyParserMethod = typeof BODY_PARSER_METHODS extends Set<infer T> ? T : never;

const serviceName = "jonasland2-events-service";

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createBodyParserSafeRequest(c: Context<{ Variables: AppVariables }>): Request {
  return new Proxy(c.req.raw, {
    get(target, prop) {
      if (BODY_PARSER_METHODS.has(prop as BodyParserMethod)) {
        return () => c.req[prop as BodyParserMethod]();
      }

      return Reflect.get(target, prop, target);
    },
  });
}

export async function eventsService(_env: EventsServiceEnv) {
  initializeServiceOtel(serviceName);
  initializeServiceEvlog(serviceName);
  await initializeEventsDb();

  const openAPIHandler = new OpenAPIHandler(eventsRouter, {
    plugins: [
      new OpenAPIReferencePlugin({
        docsProvider: "scalar",
        docsPath: "/docs",
        specPath: "/openapi.json",
        schemaConverters: [new ZodToJsonSchemaConverter()],
        specGenerateOptions: {
          info: {
            title: "jonasland2 events-service API",
            version: eventsServiceManifest.version,
          },
          servers: [{ url: "/api" }],
        },
      }),
    ],
    interceptors: [createOrpcErrorInterceptor()],
  });

  const rpcHandler = new RPCHandler(eventsRouter, {
    interceptors: [createOrpcErrorInterceptor()],
  });

  const wsHandler = new WebSocketRPCHandler(eventsRouter);
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    void wsHandler.upgrade(ws);
  });

  const app = new Hono<{ Variables: AppVariables }>();

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

    try {
      await next();
    } catch (error) {
      requestLog.error(toError(error));
      throw error;
    } finally {
      requestLog.emit({
        status: c.res.status || 500,
        durationMs: Date.now() - startedAt,
      });
    }
  });

  app.get("/healthz", createHealthzHandler());
  app.get("/api/observability", createServiceObservabilityHandler(getEventsDbRuntimeConfig));

  app.use("/orpc/*", async (c, next) => {
    const { matched, response } = await rpcHandler.handle(createBodyParserSafeRequest(c), {
      prefix: "/orpc",
      context: {
        requestId: c.get("requestId"),
        log: c.get("requestLog"),
      },
    });

    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const { matched, response } = await openAPIHandler.handle(c.req.raw, {
      prefix: "/api",
      context: {
        requestId: c.get("requestId"),
        log: c.get("requestLog"),
      },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  for (const path of ["/openapi.json", "/docs", "/docs/*"]) {
    app.use(path, async (c, next) => {
      const { matched, response } = await openAPIHandler.handle(c.req.raw, {
        context: {
          requestId: c.get("requestId"),
          log: c.get("requestLog"),
        },
      });
      if (matched) return c.newResponse(response.body, response);
      await next();
    });
  }

  return {
    app,

    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      if (pathname !== "/orpc/ws" && pathname !== "/orpc/ws/") return;
      serviceLog.info({ event: "orpc.ws.upgrade", pathname });
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
    },

    async shutdown() {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
