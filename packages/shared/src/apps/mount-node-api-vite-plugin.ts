import type { IncomingMessage, RequestListener, Server as HttpServer } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

/**
 * Mount a Node API onto Vite's dev/preview server.
 *
 * Vite owns the HTTP server. This plugin attaches `/api` request handling and
 * websocket upgrade wiring to that existing server, leaving the frontend and
 * HMR behavior alone. The real runtime should own app construction, env
 * parsing, db setup, and websocket wiring.
 */
export function mountNodeApi(options: {
  handler: () => Promise<{
    requestListener: RequestListener;
    injectWebSocket: (server: HttpServer) => void;
  }>;
}): Plugin {
  let handlerPromise: Promise<{
    requestListener: RequestListener;
    injectWebSocket: (server: HttpServer) => void;
  }> | null = null;
  let didInjectWebSocket = false;

  function getHandler() {
    handlerPromise ??= options.handler();
    return handlerPromise;
  }

  function attach(server: ViteDevServer | PreviewServer) {
    if (server.httpServer && !didInjectWebSocket) {
      void getHandler()
        .then(({ injectWebSocket }) => {
          if (!server.httpServer || didInjectWebSocket) return;

          const httpServer = server.httpServer;
          const originalOn = httpServer.on.bind(httpServer);

          // The handler captures an `upgrade` listener from the server. Vite
          // owns this server in dev, so temporarily wrap `on("upgrade")` while
          // the handler installs its listener and only forward `/api` upgrades
          // to it. That keeps Vite's own HMR websocket and any future non-API
          // upgrades out of the app-local websocket handler.
          httpServer.on = ((
            event: Parameters<typeof httpServer.on>[0],
            listener: Parameters<typeof httpServer.on>[1],
          ) => {
            if (event !== "upgrade") {
              return originalOn(event, listener);
            }

            return originalOn(event, (req: IncomingMessage, socket, head) => {
              if (!isApiRequest(req.url)) {
                return;
              }

              listener(req, socket, head);
            });
          }) as typeof httpServer.on;

          try {
            injectWebSocket(httpServer as HttpServer);
          } finally {
            httpServer.on = originalOn;
          }

          didInjectWebSocket = true;
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
          server.config.logger.error(message);
        });
    }

    return () => {
      server.middlewares.use((req, res, next) => {
        if (!isApiRequest(req.url)) {
          next();
          return;
        }

        void getHandler()
          .then(({ requestListener }) => {
            requestListener(req, res);
          })
          .catch((error: unknown) => {
            next(toError(error));
          });
      });
    };
  }

  return {
    name: "mount-node-api",
    configureServer(server) {
      return attach(server);
    },
    configurePreviewServer(server) {
      return attach(server);
    },
  };
}

function isApiRequest(url?: string) {
  const pathname = new URL(url ?? "/", "http://localhost").pathname;
  return pathname === "/api" || pathname.startsWith("/api/");
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
