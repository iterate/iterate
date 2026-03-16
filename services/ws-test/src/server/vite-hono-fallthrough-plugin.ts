import type { Server as HttpServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Plugin, ViteDevServer } from "vite";

function pathnameFromURL(url: string | undefined) {
  return new URL(url ?? "/", "http://localhost").pathname;
}

function shouldHandleBackendRequest(url: string | undefined) {
  const pathname = pathnameFromURL(url);
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function viteHonoFallthroughPlugin(): Plugin {
  return {
    name: "vite-hono-fallthrough",
    configureServer(server: ViteDevServer) {
      server.httpServer?.once("listening", async () => {
        if (!server.httpServer) {
          return;
        }

        const appModule = await server.ssrLoadModule("./src/server/app.ts");
        appModule.injectWebSocket?.(server.httpServer as HttpServer);
      });

      server.middlewares.use(async (req, res, next) => {
        if (!shouldHandleBackendRequest(req.url)) {
          return next();
        }

        try {
          const appModule = await server.ssrLoadModule("./src/server/app.ts");
          const app = appModule.default;

          const listener = getRequestListener(
            (request) =>
              app.fetch(
                request,
                {
                  incoming: req,
                  outgoing: res,
                },
                {
                  waitUntil: async () => undefined,
                  passThroughOnException: () => undefined,
                },
              ),
            {
              overrideGlobalObjects: false,
              errorHandler: (error) => next(error),
            },
          );

          await listener(req, res);
        } catch (error) {
          next(error as Error);
        }
      });
    },
  };
}
