import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { Hono } from "hono";
import { attachDefaultServiceRoutes } from "@iterate-com/services-contracts/lib";
import { serviceManifest, type EventsServiceEnv } from "@iterate-com/services-contracts/events";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { WebSocketServer } from "ws";

import { disposeEventOperations, getEventOperations } from "./effect-stream-manager/singleton.ts";

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
        docsTitle: "Durable Stream API Reference",
        schemaConverters: [new ZodToJsonSchemaConverter()],
        docsConfig: {
          layout: "modern",
          theme: "bluePlanet",
          searchHotKey: "k",
          operationTitleSource: "summary",
          showSidebar: true,
          hideSearch: false,
          tagsSorter: "alpha",
          operationsSorter: "method",
          orderSchemaPropertiesBy: "alpha",
          orderRequiredPropertiesFirst: true,
          documentDownloadType: "both",
        },
        docsHead: `
          <meta name="description" content="Events Service API" />
          <style>body { margin: 0; }</style>
        `,
        specGenerateOptions: {
          info: {
            title: "Iterate Events Service API",
            version: serviceManifest.version,
            description:
              "Events service API. Authentication is enforced by the Iterate OS worker ingress proxy before requests reach this service.",
          },
          tags: [
            { name: "Streams", description: "Stream append/read/list operations" },
            {
              name: "Subscriptions",
              description: "Push subscription registration and acknowledgements",
            },
          ],
          servers: [{ url: "/api" }],
          components: {
            securitySchemes: {
              ingressProxyAuth: {
                type: "http",
                scheme: "bearer",
                description:
                  "Ingress authentication is handled by the Iterate OS worker proxy layer.",
              },
            },
          },
        },
      }),
    ],
  });

  const rpcHandler = new RPCHandler(router);
  const wsHandler = new WebSocketRPCHandler(router);

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    void wsHandler.upgrade(ws);
  });

  const app = new Hono();
  attachDefaultServiceRoutes(app);

  app.use("/orpc/*", async (c, next) => {
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix: "/orpc",
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
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
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
    },

    async shutdown() {
      wss.close();
      await disposeEventOperations(env);
    },
  };
};
