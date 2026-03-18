import type { IncomingMessage, RequestListener, Server as HttpServer } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

/**
 * Mount an already-wired Node app behind Vite during development.
 *
 * The real runtime should own app construction, env parsing, db setup, and
 * websocket wiring. This plugin only teaches Vite dev how to delegate `/api`
 * HTTP and websocket traffic to that ready-made Node app while leaving the
 * frontend and HMR behavior alone.
 */
export function embeddedNodeAppVitePlugin(options: {
  createApp: () => Promise<{
    requestListener: RequestListener;
    injectWebSocket: (server: HttpServer) => void;
  }>;
}): Plugin {
  let appPromise: Promise<{
    requestListener: RequestListener;
    injectWebSocket: (server: HttpServer) => void;
  }> | null = null;
  let didInjectWebSocket = false;

  function getEmbeddedApp() {
    appPromise ??= options.createApp();
    return appPromise;
  }

  function attach(server: ViteDevServer | PreviewServer) {
    if (server.httpServer && !didInjectWebSocket) {
      void getEmbeddedApp()
        .then(({ injectWebSocket }) => {
          if (!server.httpServer || didInjectWebSocket) return;

          const httpServer = server.httpServer;
          const originalOn = httpServer.on.bind(httpServer);

          // The embedded app captures an `upgrade` listener from the server.
          // Vite owns this server in dev, so temporarily wrap `on("upgrade")`
          // while the app installs its listener and only forward `/api`
          // upgrades to it. That keeps Vite's own HMR websocket and any future
          // non-API upgrades out of the app-local websocket handler.
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

        void getEmbeddedApp()
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
    name: "embedded-node-app-vite-plugin",
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
