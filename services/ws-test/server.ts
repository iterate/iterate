import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import backendApp, { injectWebSocket } from "./src/server/backend-app.ts";

const host = process.env.HOST?.trim() || "0.0.0.0";
const port = process.env.PORT?.trim() ? Number(process.env.PORT) : 3000;
const serveClientBundle = process.env.HONO_SERVE_CLIENT_BUNDLE?.trim().toLowerCase() === "true";

const app = new Hono();
app.route("/", backendApp);

if (serveClientBundle) {
  app.use(
    "/assets/*",
    serveStatic({
      root: "./dist/client",
    }),
  );
  app.get("*", serveStatic({ root: "./dist/client", path: "_shell.html" }));
}

const server = createAdaptorServer({ fetch: app.fetch });
injectWebSocket(server);

server.listen(port, host, () => {
  console.log(`ws-test listening on http://${host}:${port}`);
});
