import type { IncomingMessage } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { Hono } from "hono";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { z } from "zod";
import { ExampleAppEnv } from "./src/env.ts";
import { exampleApp } from "./src/api/app.ts";
import { createExampleNodeRuntime } from "./src/node/create-app.ts";

const env = ExampleAppEnv.extend({
  PORT: z.coerce.number().int().positive().default(17401),
}).parse(process.env);

function exampleEmbeddedApiDevPlugin(): Plugin {
  let appPromise: Promise<{
    app: Hono;
    injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
  }> | null = null;
  let didInjectWebSocket = false;

  function getEmbeddedApp() {
    appPromise ??= createEmbeddedApp();
    return appPromise;
  }

  return {
    name: "example-embedded-api-dev",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      if (server.httpServer && !didInjectWebSocket) {
        void getEmbeddedApp()
          .then(({ injectWebSocket }) => {
            if (!server.httpServer || didInjectWebSocket) return;
            const httpServer = server.httpServer;
            const originalOn = httpServer.on.bind(httpServer);

            httpServer.on = ((
              event: Parameters<typeof httpServer.on>[0],
              listener: Parameters<typeof httpServer.on>[1],
            ) => {
              if (event !== "upgrade") {
                return originalOn(event, listener);
              }

              return originalOn(event, (req: IncomingMessage, socket, head) => {
                const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
                if (!pathname.startsWith("/api")) {
                  return;
                }

                listener(req, socket, head);
              });
            }) as typeof httpServer.on;

            try {
              injectWebSocket(httpServer);
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
          if (!req.url?.startsWith("/api")) {
            next();
            return;
          }

          void getEmbeddedApp()
            .then(({ app }) => {
              getRequestListener(
                async (request) => {
                  const response = await app.fetch(request);
                  return response;
                },
                {
                  overrideGlobalObjects: false,
                  errorHandler: (error) => {
                    next(error instanceof Error ? error : new Error(String(error)));
                  },
                },
              )(req, res);
            })
            .catch((error: unknown) => {
              next(error instanceof Error ? error : new Error(String(error)));
            });
        });
      };
    },
  };
}

async function createEmbeddedApp() {
  const runtime = await createExampleNodeRuntime();
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  await exampleApp.mount({
    app,
    getDeps: () => runtime.deps,
    upgradeWebSocket,
  });

  return {
    app,
    injectWebSocket,
  };
}

export default defineConfig(() => {
  return {
    server: {
      host: true,
      port: env.PORT,
      strictPort: false,
      watch: {
        ignored: ["**/routeTree.gen.ts"],
      },
    },
    preview: {
      host: true,
      port: env.PORT,
      strictPort: true,
    },
    build: {
      target: "es2024",
    },
    plugins: [
      exampleEmbeddedApiDevPlugin(),
      tsconfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        srcDirectory: "src/frontend",
        spa: {
          enabled: true,
          prerender: {
            // Emit the SPA shell at index.html so Cloudflare asset bindings can serve it natively.
            outputPath: "/index.html",
          },
        },
      }),
      viteReact(),
      tailwindcss(),
      devtools({
        consolePiping: { enabled: false },
        editor: {
          name: "Cursor",
          open: async (path, lineNumber, columnNumber) => {
            const { exec } = await import("node:child_process");
            const location =
              `${path.replaceAll("$", "\\$")}` +
              `${lineNumber ? `:${lineNumber}` : ""}` +
              `${columnNumber ? `:${columnNumber}` : ""}`;
            exec(`cursor -g "${location}"`);
          },
        },
      }),
    ],
  };
});
