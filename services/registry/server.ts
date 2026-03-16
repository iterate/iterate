import type { Server as HttpServer } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import app, { injectWebSocket } from "./src/server/app.ts";
import { getEnv } from "./src/server/context.ts";
import { initializeRegistryService } from "./src/server/startup.ts";

const env = getEnv();
const isDev = process.env.NODE_ENV !== "production";
const host = env.REGISTRY_SERVICE_HOST;
const requestedPort = process.env.PORT?.trim() ? Number(process.env.PORT) : 0;
const server = createAdaptorServer({ fetch: app.fetch });

if (isDev) {
  const vite = await import("vite").then((module) =>
    module.createServer({
      server: {
        middlewareMode: true,
        hmr: {
          server: server as unknown as HttpServer,
        },
      },
    }),
  );

  app.use("*", async (c) => {
    if (!c.env.incoming || !c.env.outgoing) {
      return c.newResponse(null, 404);
    }

    await new Promise<void>((resolve) => {
      vite.middlewares(c.env.incoming, c.env.outgoing, () => {
        if (!c.env.outgoing.writableEnded) {
          c.env.outgoing.writeHead(404, { "content-type": "application/json" });
          c.env.outgoing.end(JSON.stringify({ error: "not_found" }));
        }
        resolve();
      });
    });

    return RESPONSE_ALREADY_SENT;
  });
} else {
  const { serveStatic } = await import("@hono/node-server/serve-static");
  app.use("/assets/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ root: "./dist/client", path: "_shell.html" }));
}

injectWebSocket(server);

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(requestedPort, host, () => {
    server.off("error", reject);
    resolve();
  });
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("registry service did not expose a numeric listen address");
}

const port = address.port;

await initializeRegistryService({ host, port });
