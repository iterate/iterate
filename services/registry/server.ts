import { createAdaptorServer } from "@hono/node-server";
import app, {
  injectWebSocket,
  store,
  env,
  serviceName,
  getOtelRuntimeConfig,
  ensureSeededRoutes,
  ensureInitialCaddySynchronization,
} from "./src/server/app.ts";
import { serviceLog } from "@iterate-com/shared/jonasland";

const isDev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 17310;

if (isDev) {
  const vite = await import("vite").then((m) =>
    m.createServer({ server: { middlewareMode: true } }),
  );
  app.use("*", async (c) => {
    return new Promise((resolve) => {
      vite.middlewares(c.env.incoming, c.env.outgoing, () => resolve(c.newResponse(null, 404)));
    });
  });
} else {
  const { serveStatic } = await import("@hono/node-server/serve-static");
  app.use("/assets/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ root: "./dist/client", path: "_shell.html" }));
}

const server = createAdaptorServer({ fetch: app.fetch });
injectWebSocket(server);

server.listen(port, "0.0.0.0", () => {
  serviceLog.info({
    event: "service.started",
    service: serviceName,
    host: "0.0.0.0",
    port,
    docs_path: "/api/docs",
    spec_path: "/api/openapi.json",
    orpc_path: "/orpc",
    orpc_ws_path: "/orpc/ws",
    ui_path: "/",
    otel: getOtelRuntimeConfig(),
  });

  void (async () => {
    await ensureSeededRoutes({ store });
    await ensureInitialCaddySynchronization({ store, env });
  })();
});
