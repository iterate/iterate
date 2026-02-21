import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import react from "@vitejs/plugin-react";
import { Hono } from "hono";
import { serviceManifest } from "@iterate-com/services-contracts/events";
import { createServer as createViteServer } from "vite";

import { eventsService } from "./fetcher.ts";

const env = serviceManifest.envVars.parse(process.env);
const service = await eventsService(env);

const app = new Hono<{ Bindings: HttpBindings }>();
app.route("/", service.app);

const server = serve({ fetch: app.fetch, port: env.PORT }) as Server;
server.on("upgrade", service.handleUpgrade);

const vite = await createViteServer({
  configFile: false,
  root: "./src/ui",
  plugins: [react()],
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
