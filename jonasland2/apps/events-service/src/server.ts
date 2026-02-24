import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import react from "@vitejs/plugin-react";
import { eventsServiceManifest } from "@jonasland2/events-contract";
import { createBrowserErrorBridgePlugin, serviceLog } from "@jonasland2/shared";
import { Hono } from "hono";
import { createServer as createViteServer } from "vite";
import { eventsService } from "./fetcher.ts";

const BROWSER_ERROR_EVENT = "events-service:browser-console-error";

const env = eventsServiceManifest.envVars.parse(process.env);
const service = await eventsService(env);

const app = new Hono<{ Bindings: HttpBindings }>();
app.route("/", service.app);

const server = serve({ fetch: app.fetch, port: env.EVENTS_SERVICE_PORT }) as Server;
server.on("upgrade", service.handleUpgrade);

const vite = await createViteServer({
  configFile: false,
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  cacheDir: "/tmp/vite-events-service",
  plugins: [
    react(),
    createBrowserErrorBridgePlugin({
      eventName: BROWSER_ERROR_EVENT,
      logEventName: "events-ui.browser-error",
      logger: serviceLog,
    }),
  ],
  appType: "spa",
  server: { middlewareMode: true, hmr: { server } },
});

app.use(
  "*",
  (c) =>
    new Promise((resolve) => {
      c.env.outgoing.on("finish", () => resolve(RESPONSE_ALREADY_SENT));

      vite.middlewares(c.env.incoming, c.env.outgoing, () => {
        if (!c.env.outgoing.writableEnded) {
          c.env.outgoing.writeHead(404, { "content-type": "application/json" });
          c.env.outgoing.end(JSON.stringify({ error: "not_found" }));
        }

        resolve(RESPONSE_ALREADY_SENT);
      });
    }),
);

const shutdown = async () => {
  await service.shutdown();
  await vite.close();
  server.close(() => process.exit(0));
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
