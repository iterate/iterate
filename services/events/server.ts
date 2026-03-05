import { createAdaptorServer } from "@hono/node-server";
import app, {
  injectWebSocket,
  serviceName,
  getOtelRuntimeConfig,
  disposeEventsRouterOperations,
} from "./src/server/app.ts";
import { serviceManifest } from "@iterate-com/events-contract";
import { registerServiceWithRegistry, serviceLog } from "@iterate-com/shared/jonasland";

const isDev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || serviceManifest.port;

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
    port,
    docs_path: "/api/docs",
    spec_path: "/api/openapi.json",
    orpc_path: "/orpc",
    orpc_ws_path: "/orpc/ws",
    ui_path: "/",
    otel: getOtelRuntimeConfig(),
  });

  void registerServiceWithRegistry({
    manifest: serviceManifest,
    port,
    metadata: { openapiPath: "/api/openapi.json", title: "Events Service" },
    tags: ["openapi", "events"],
  });
});

const shutdown = async () => {
  await Promise.allSettled([disposeEventsRouterOperations()]);
  server.close(() => process.exit(0));
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
