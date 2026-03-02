/**
 * OpenObserve service definition.
 *
 * Wraps the OpenObserve binary behind a standard ServiceDefinition.
 * OpenObserve provides a combined UI + API on port 5080 (HTTP)
 * and a gRPC endpoint on port 5081.
 *
 * The proxy exposes the HTTP UI/API (5080) through the service proxy.
 * The gRPC port (5081) is available internally for services that need
 * it (e.g. otel-collector exporting via OTLP/gRPC).
 */
import { Hono } from "hono";
import { z } from "zod/v4";
import { defineService } from "./define-service.ts";
import { createServiceProxy } from "./hybrid-proxy.ts";
import { spawnInner } from "./spawn-inner.ts";

const OPENOBSERVE_HTTP_PORT = 5080;

export const openobserveService = defineService({
  slug: "openobserve",
  version: "0.1.0",
  configSchema: z.object({
    /** Path to the openobserve binary */
    binaryPath: z.string().default("/usr/local/bin/openobserve"),
    /** Root user email for OpenObserve */
    rootEmail: z.string().default("root@example.com"),
    /** Root user password for OpenObserve */
    rootPassword: z.string().default("Complexpass#123"),
    /** Data directory */
    dataDir: z.string().default("/var/lib/openobserve"),
  }),

  async start(config) {
    // 1. Spawn OpenObserve
    const inner = await spawnInner({
      command: config.binaryPath,
      env: {
        ZO_ROOT_USER_EMAIL: config.rootEmail,
        ZO_ROOT_USER_PASSWORD: config.rootPassword,
        ZO_LOCAL_MODE: "true",
        ZO_DATA_DIR: config.dataDir,
      },
      port: OPENOBSERVE_HTTP_PORT,
      healthPath: "/",
      healthMaxStatus: 400, // OpenObserve returns 3xx redirects when ready
      timeoutMs: 120_000,
    });

    // 2. Managed routes
    const app = new Hono();
    app.get("/service/health", (c) =>
      c.json({
        status: "ok",
        slug: "openobserve",
        ports: { http: OPENOBSERVE_HTTP_PORT, grpc: 5081 },
      }),
    );
    app.get("/openapi.json", (c) =>
      c.json({
        openapi: "3.0.0",
        info: { title: "OpenObserve", version: "0.1.0" },
        paths: {},
      }),
    );

    // 3. Proxy
    const proxy = await createServiceProxy({ innerPort: inner.port, app });

    // 4. Signal handling (guarded to prevent double-cleanup)
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      proxy.close();
      inner.kill();
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
