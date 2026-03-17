import { Hono } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { experimental_RPCHandler as RPCHandler } from "@orpc/server/crossws";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { AdapterOptions, Hooks } from "crossws";
import { wsTest2ServiceManifest } from "@iterate-com/ws-test-2-contract";
import { createConfettiSocketHooks } from "./confetti.ts";
import { createOrpcContext, serviceName, type WsTest2Env } from "./context.ts";
import { router } from "./router.ts";

export async function createApp<TBindings extends object, TWebSocketServer = unknown>({
  env,
  // `app.ts` is shared by both Node and workerd, so it must not import the
  // Node-only PTY implementation directly. The runtime boundary chooses which
  // PTY hooks to pass in:
  //
  // - Node passes the real `createNodePtyHooks()`
  // - workerd passes a tiny "not implemented" websocket
  //
  // We tried making this file branch on a boolean and dynamically import
  // `./pty-node.ts`, but that leaked the Node-only module into the worker
  // bundle because the bundler cannot prove that a shared function parameter is
  // always false for the worker build.
  ptyHooks,
  createWebSocketServer,
}: {
  env: WsTest2Env;
  ptyHooks: Partial<Hooks>;
  createWebSocketServer: (options: AdapterOptions) => TWebSocketServer;
}) {
  const app = new Hono<{ Bindings: TBindings }>();
  const orpcHandler = new RPCHandler(router, {
    interceptors: [
      onError((error) => {
        console.error(error);
      }),
    ],
  });
  const openApiHandler = new OpenAPIHandler(router, {
    plugins: [
      new OpenAPIReferencePlugin({
        docsProvider: "scalar",
        docsPath: "/docs",
        specPath: "/openapi.json",
        schemaConverters: [new ZodToJsonSchemaConverter()],
        specGenerateOptions: {
          info: { title: "ws-test-2 API", version: wsTest2ServiceManifest.version },
          servers: [{ url: "/api" }],
        },
      }),
    ],
    interceptors: [
      onError((error) => {
        console.error(error);
      }),
    ],
  });
  const ws = createWebSocketServer({
    async resolve(request) {
      // CrossWS owns websocket routing. Hono only handles HTTP routes in this
      // service; every websocket upgrade comes through this resolver.
      const pathname = new URL(request.url, "http://localhost").pathname;

      if (pathname === "/api/orpc/ws") {
        return {
          upgrade(request) {
            // The oRPC websocket client expects the `orpc` subprotocol and both
            // Node and workerd tests assert this behavior. Keep the handshake
            // logic here with the websocket route instead of spreading it across
            // the runtime entrypoints.
            const requestedProtocols = request.headers
              .get("sec-websocket-protocol")
              ?.split(",")
              .map((value) => value.trim())
              .filter(Boolean);

            if (!requestedProtocols?.includes("orpc")) {
              return new Response("Expected Sec-WebSocket-Protocol: orpc", { status: 400 });
            }

            return {
              headers: {
                "Sec-WebSocket-Protocol": "orpc",
              },
            };
          },
          async message(peer, message) {
            try {
              await orpcHandler.message(peer, message, {
                context: createOrpcContext(env),
              });
            } catch (error) {
              console.error(error);
              peer.close(1011, "oRPC websocket error");
            }
          },
          close(peer) {
            orpcHandler.close(peer);
          },
          error(peer, error) {
            console.error(error);
            orpcHandler.close(peer);
          },
        } satisfies Partial<Hooks>;
      }

      if (pathname === "/api/confetti/ws") {
        return createConfettiSocketHooks();
      }

      if (pathname === "/api/pty/ws") {
        return ptyHooks;
      }

      return {};
    },
  });

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      service: serviceName,
    }),
  );

  app.all("/api/*", async (c) => {
    const { matched, response } = await openApiHandler.handle(c.req.raw, {
      prefix: "/api",
      context: createOrpcContext(env),
    });

    if (!matched || !response) {
      return c.json({ error: "not_found" }, 404);
    }

    return c.newResponse(response.body, response);
  });

  return {
    app,
    ws,
  };
}
