import type { Server } from "node:http";
import { inspect } from "node:util";

import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import react from "@vitejs/plugin-react";
import { Hono } from "hono";
import { serviceManifest } from "@iterate-com/services-contracts/events";
import { createServer as createViteServer, type Plugin } from "vite";

import { eventsService } from "./fetcher.ts";

const BROWSER_ERROR_EVENT = "events:browser-console-error";

const browserErrorBridgePlugin = (): Plugin => ({
  name: "events-browser-error-bridge",
  configureServer(server) {
    server.ws.on(BROWSER_ERROR_EVENT, (payload) => {
      const inspected =
        typeof payload === "string"
          ? payload
          : inspect(payload, {
              depth: 8,
              colors: false,
              breakLength: 140,
              compact: false,
            });

      console.error(`[events:browser:error] ${inspected}`);
    });
  },
  transformIndexHtml() {
    return [
      {
        tag: "script",
        attrs: { type: "module" },
        injectTo: "body",
        children: `
          if (import.meta.hot) {
            const normalizeErrorData = (value) => {
              if (value instanceof Error) {
                return {
                  name: value.name,
                  message: value.message,
                  stack: value.stack ?? null,
                };
              }
              if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
                return value;
              }
              try {
                return JSON.parse(JSON.stringify(value));
              } catch {
                return String(value);
              }
            };

            const send = (kind, data) => {
              import.meta.hot.send("${BROWSER_ERROR_EVENT}", {
                kind,
                data,
                href: location.href,
                userAgent: navigator.userAgent,
                timestamp: new Date().toISOString(),
              });
            };

            const originalConsoleError = console.error.bind(console);
            console.error = (...args) => {
              send("console.error", { args: args.map(normalizeErrorData) });
              originalConsoleError(...args);
            };

            window.addEventListener("error", (event) => {
              send("window.error", {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                error: normalizeErrorData(event.error),
              });
            });

            window.addEventListener("unhandledrejection", (event) => {
              send("window.unhandledrejection", {
                reason: normalizeErrorData(event.reason),
              });
            });
          }
        `,
      },
    ];
  },
});

const env = serviceManifest.envVars.parse(process.env);
const service = await eventsService(env);

const app = new Hono<{ Bindings: HttpBindings }>();
app.route("/", service.app);

const server = serve({ fetch: app.fetch, port: env.PORT }) as Server;
server.on("upgrade", service.handleUpgrade);

const vite = await createViteServer({
  configFile: false,
  root: "./src/ui",
  plugins: [react(), browserErrorBridgePlugin()],
  appType: "spa",
  server: { middlewareMode: true, hmr: { server } },
});

app.use(
  "*",
  (c) =>
    new Promise((resolve) => {
      c.env.outgoing.on("finish", () => resolve(RESPONSE_ALREADY_SENT));
      vite.middlewares(c.env.incoming, c.env.outgoing, () =>
        resolve(new Response("Not found", { status: 404 })),
      );
    }),
);

const shutdown = async () => {
  await service.shutdown();
  await vite.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
