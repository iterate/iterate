/**
 * OpenTelemetry Collector service definition.
 *
 * Wraps otelcol-contrib behind a standard ServiceDefinition. The
 * collector has no HTTP UI — it exposes OTLP receivers and a health
 * check endpoint. The proxy sits in front of the health check port
 * and provides managed routes.
 *
 * Internal ports (configured in the collector YAML):
 *   - 15317: OTLP gRPC receiver
 *   - 15318: OTLP HTTP receiver
 *   - 15333: Health check extension
 *
 * Other services send telemetry to 15317/15318 directly (not through
 * the proxy). The proxy exposes the health check (15333) as the
 * primary HTTP surface.
 */
import { Hono } from "hono";
import { z } from "zod/v4";
import { defineService } from "./define-service.ts";
import { createServiceProxy } from "./hybrid-proxy.ts";
import { spawnInner } from "./spawn-inner.ts";

const HEALTH_CHECK_PORT = 15333;

export const otelCollectorService = defineService({
  slug: "otel-collector",
  version: "0.1.0",
  configSchema: z.object({
    /** Path to the otelcol-contrib binary */
    binaryPath: z.string().default("/usr/local/bin/otelcol-contrib"),
    /** Path to the collector YAML config */
    configPath: z.string(),
  }),

  async start(config) {
    // 1. Spawn otelcol-contrib
    const inner = await spawnInner({
      command: config.binaryPath,
      args: ["--config", config.configPath, "--set=service.telemetry.metrics.level=None"],
      port: HEALTH_CHECK_PORT,
      healthPath: "/",
      timeoutMs: 60_000,
    });

    // 2. Managed routes
    const app = new Hono();
    app.get("/service/health", (c) =>
      c.json({
        status: "ok",
        slug: "otel-collector",
        ports: {
          otlpGrpc: 15317,
          otlpHttp: 15318,
          healthCheck: HEALTH_CHECK_PORT,
        },
      }),
    );
    app.get("/openapi.json", (c) =>
      c.json({
        openapi: "3.0.0",
        info: { title: "OpenTelemetry Collector", version: "0.1.0" },
        paths: {},
      }),
    );

    // 3. Proxy to health check endpoint
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
