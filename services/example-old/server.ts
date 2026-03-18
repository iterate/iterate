import { createAdaptorServer } from "@hono/node-server";
import app, { injectWebSocket } from "./src/server/app.ts";
import { getExampleDbRuntimeConfig } from "./src/db.ts";

const isDev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 0;

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
  const address = server.address();
  const boundPort = address && typeof address === "object" ? address.port : port;
  console.log(`example listening on http://localhost:${boundPort}`);

  void Promise.all([
    import("@iterate-com/shared/jonasland"),
    import("@iterate-com/example-old-contract"),
    getExampleDbRuntimeConfig(),
  ]).then(([{ registerServiceWithRegistry }, { exampleServiceManifest }, runtime]) => {
    return registerServiceWithRegistry({
      manifest: exampleServiceManifest,
      port: boundPort,
      metadata: {
        openapiPath: "/api/openapi.json",
        title: "Example Service",
        sqlitePath: runtime.path,
        sqliteAlias: "example",
      },
      tags: ["openapi", "example", "sqlite"],
    });
  });
});
