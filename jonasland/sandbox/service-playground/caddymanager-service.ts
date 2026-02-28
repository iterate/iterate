/**
 * CaddyManager service definition.
 *
 * Wraps the caddymanager Node.js server behind a standard ServiceDefinition.
 * CaddyManager is a small HTTP service that manages Caddy's config via
 * its admin API — adding/removing routes, upstreams, etc.
 *
 * Unlike the other third-party wrappers, caddymanager is already a
 * Node.js HTTP server. The wrapper spawns it as a child process and
 * proxies through, adding the standard managed routes.
 */
import { Hono } from "hono";
import { z } from "zod/v4";
import { defineService } from "./define-service.ts";
import { createServiceProxy } from "./hybrid-proxy.ts";
import { spawnInner } from "./spawn-inner.ts";

const DEFAULT_PORT = 8501;

export const caddymanagerService = defineService({
  slug: "caddymanager",
  version: "0.1.0",
  configSchema: z.object({
    /** Path to the caddymanager server.mjs */
    serverPath: z.string().default("/opt/jonasland-sandbox/caddymanager/server.mjs"),
    /** Port caddymanager listens on */
    port: z.number().default(DEFAULT_PORT),
    /** Caddy admin API URL */
    caddyApiUrl: z.string().default("http://127.0.0.1"),
    /** Caddy admin API port */
    caddyApiPort: z.number().default(2019),
  }),

  async start(config) {
    // 1. Spawn caddymanager
    const inner = await spawnInner({
      command: "node",
      args: [config.serverPath],
      env: {
        CADDYMANAGER_HOST: "127.0.0.1",
        CADDYMANAGER_PORT: String(config.port),
        CADDYMANAGER_TARGET_API_URL: config.caddyApiUrl,
        CADDYMANAGER_TARGET_API_PORT: String(config.caddyApiPort),
      },
      port: config.port,
      healthPath: "/healthz",
      timeoutMs: 30_000,
    });

    // 2. Managed routes
    const app = new Hono();
    app.get("/service/health", (c) =>
      c.json({
        status: "ok",
        slug: "caddymanager",
        innerPort: inner.port,
      }),
    );
    app.get("/openapi.json", (c) =>
      c.json({
        openapi: "3.0.0",
        info: { title: "CaddyManager", version: "0.1.0" },
        paths: {},
      }),
    );

    // 3. Proxy
    const proxy = await createServiceProxy({ innerPort: inner.port, app });

    // 4. Signal handling
    const shutdown = () => {
      proxy.close();
      inner.kill();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    return {
      target: `127.0.0.1:${proxy.port}`,
      close() {
        proxy.close();
        inner.kill();
      },
    };
  },
});
