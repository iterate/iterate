import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";

import { Hono } from "hono";
import { attachDefaultServiceRoutes } from "@iterate-com/services-contracts/lib";
import { serviceManifest, type EventsServiceEnv } from "@iterate-com/services-contracts/events";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { implement, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { WebSocketServer } from "ws";

import { disposeEventOperations, getEventOperations } from "./effect-stream-manager/singleton.ts";

const SHOULD_LOG_ORPC = process.env.NODE_ENV !== "test";

const toErrorWithStack = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? "(stack unavailable)"}`;
  }

  return inspect(error, {
    depth: 8,
    colors: false,
    breakLength: 140,
    compact: false,
  });
};

const logOrpcRequest = (message: string): void => {
  if (!SHOULD_LOG_ORPC) return;
  console.log(`[events:orpc] ${message}`);
};

const logOrpcError = (message: string, error: unknown): void => {
  if (!SHOULD_LOG_ORPC) return;
  console.error(`[events:orpc:error] ${message}`);
  console.error(toErrorWithStack(error));
};

export const eventsService = async (env: EventsServiceEnv) => {
  const ops = await getEventOperations(env);

  const eventBus = implement(serviceManifest.orpcContract);

  const router = eventBus.router({
    append: eventBus.append.handler(async ({ input }) => {
      await ops.appendEvents(input);
    }),
    subscribe: eventBus.subscribe.handler(async ({ input }) => {
      await ops.appendSubscriptionRegistration(input);
    }),
    ackOffset: eventBus.ackOffset.handler(async ({ input }) => {
      await ops.acknowledgeOffset(input);
    }),
    stream: eventBus.stream.handler(async function* ({ input, signal }) {
      yield* ops.streamEvents(input, signal);
    }),
    listStreams: eventBus.listStreams.handler(async () => ops.listStreams()),
  });

  const openAPIHandler = new OpenAPIHandler(router, {
    plugins: [
      new OpenAPIReferencePlugin({
        docsPath: "/docs",
        specPath: "/openapi.json",
        docsTitle: "Events API",
        schemaConverters: [new ZodToJsonSchemaConverter()],
        specGenerateOptions: {
          info: {
            title: "Iterate Events Service API",
            version: serviceManifest.version,
            description: "Durable event streams API.",
          },
          servers: [{ url: "/api" }],
        },
      }),
    ],
  });

  const rpcHandler = new RPCHandler(router, {
    interceptors: [
      onError((error, params) => {
        const maybeStatus =
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          typeof (error as { status?: unknown }).status === "number"
            ? (error as { status: number }).status
            : undefined;
        const requestPath = new URL(params.request.url, "http://localhost").pathname;
        const procedurePath =
          "path" in params && typeof params.path === "string" ? params.path : "unknown";

        logOrpcError(
          `handler error status=${maybeStatus ?? "unknown"} request=${params.request.method} ${requestPath} procedure=${procedurePath}`,
          error,
        );
      }),
    ],
  });
  const wsHandler = new WebSocketRPCHandler(router);

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    void wsHandler.upgrade(ws);
  });

  const app = new Hono();
  attachDefaultServiceRoutes(app);

  app.use("/orpc/*", async (c, next) => {
    const requestId = randomUUID().slice(0, 8);
    const requestPath = new URL(c.req.raw.url, "http://localhost");
    const startedAt = Date.now();

    logOrpcRequest(
      `[${requestId}] request ${c.req.raw.method} ${requestPath.pathname}${requestPath.search}`,
    );

    try {
      const { matched, response } = await rpcHandler.handle(c.req.raw, {
        prefix: "/orpc",
      });
      const elapsedMs = Date.now() - startedAt;

      if (matched) {
        logOrpcRequest(
          `[${requestId}] response status=${response.status} durationMs=${elapsedMs} ${requestPath.pathname}${requestPath.search}`,
        );
        return c.newResponse(response.body, response);
      }

      logOrpcRequest(
        `[${requestId}] pass-through durationMs=${elapsedMs} ${requestPath.pathname}${requestPath.search}`,
      );
      await next();
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      logOrpcError(
        `[${requestId}] uncaught durationMs=${elapsedMs} ${requestPath.pathname}${requestPath.search}`,
        error,
      );
      throw error;
    }
  });

  app.use("/api/*", async (c, next) => {
    const { matched, response } = await openAPIHandler.handle(c.req.raw, {
      prefix: "/api",
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  for (const path of ["/openapi.json", "/docs", "/docs/*"]) {
    app.use(path, async (c, next) => {
      const { matched, response } = await openAPIHandler.handle(c.req.raw);
      if (matched) return c.newResponse(response.body, response);
      await next();
    });
  }

  return {
    app,

    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      if (pathname !== "/orpc/ws" && pathname !== "/orpc/ws/") return;
      logOrpcRequest(`ws-upgrade request ${pathname}`);
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
    },

    async shutdown() {
      wss.close();
      await disposeEventOperations(env);
    },
  };
};
