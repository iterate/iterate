/**
 * Example service definition wrapping an HTTP echo server.
 *
 * Demonstrates the service proxy: managed paths (/service/health,
 * /openapi.json) are handled by our TS layer, everything else is
 * proxied through to the inner HTTP echo server.
 */
import { createServer } from "node:http";
import { Hono } from "hono";
import { z } from "zod/v4";
import { defineService } from "./define-service.ts";
import { createServiceProxy } from "./hybrid-proxy.ts";

/** Start a simple HTTP echo server on an ephemeral port */
function startEchoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            echo: true,
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body || undefined,
          }),
        );
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("echo server bind failed");
      resolve({
        port: addr.port,
        close: () => server.close(),
      });
    });
  });
}

export const echoService = defineService({
  slug: "echo",
  version: "0.1.0",
  configSchema: z.object({}),

  async start() {
    // 1. Start the inner HTTP echo server on an ephemeral port
    const inner = await startEchoServer();

    // 2. Create our managed Hono app (health, openapi)
    const app = new Hono();
    app.get("/service/health", (c) =>
      c.json({ status: "ok", slug: "echo", innerPort: inner.port }),
    );
    app.get("/openapi.json", (c) =>
      c.json({
        openapi: "3.0.0",
        info: { title: "Echo HTTP Service", version: "0.1.0" },
        paths: {},
      }),
    );

    // 3. Create service proxy: managed routes go to Hono, everything else proxied to inner
    const proxy = await createServiceProxy({ innerPort: inner.port, app });

    // 4. Signal handling (guarded to prevent double-cleanup)
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      proxy.close();
      inner.close();
    };
    const shutdown = () => {
      cleanup();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    return {
      target: `127.0.0.1:${proxy.port}`,
      close: cleanup,
    };
  },
});
