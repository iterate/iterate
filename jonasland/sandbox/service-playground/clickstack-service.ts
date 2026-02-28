/**
 * ClickStack service definition.
 *
 * Wraps the ClickStack chroot-based launcher (HyperDX UI + ClickHouse)
 * behind a standard ServiceDefinition. The TS proxy provides managed
 * routes and forwards everything else to the HyperDX UI on port 8080.
 *
 * ClickStack exposes multiple internal ports:
 *   - 8080: HyperDX UI (primary — this is what we proxy)
 *   - 8123: ClickHouse HTTP interface
 *   - 9000: ClickHouse native protocol
 *   - 4317/4318: Built-in OTLP receiver
 *
 * Only the HyperDX UI (8080) is exposed through the service proxy.
 * Internal ports (CH, OTLP) are consumed by other services directly
 * (e.g. otel-collector writes to CH on 9000).
 */
import { Hono } from "hono";
import { z } from "zod/v4";
import { defineService } from "./define-service.ts";
import { createServiceProxy } from "./hybrid-proxy.ts";
import { spawnInner } from "./spawn-inner.ts";

const HYPERDX_UI_PORT = 8080;

export const clickstackService = defineService({
  slug: "clickstack",
  version: "0.1.0",
  configSchema: z.object({
    /** Path to the clickstack launcher script */
    launcherPath: z.string().default("/opt/jonasland-sandbox/clickstack-launcher.sh"),
  }),

  async start(config) {
    // 1. Spawn the clickstack launcher — it chroots and starts HyperDX + ClickHouse
    const inner = await spawnInner({
      command: config.launcherPath,
      port: HYPERDX_UI_PORT,
      healthPath: "/",
      timeoutMs: 120_000, // clickstack is slow to start
    });

    // 2. Managed routes
    const app = new Hono();
    app.get("/service/health", (c) =>
      c.json({
        status: "ok",
        slug: "clickstack",
        ports: {
          ui: HYPERDX_UI_PORT,
          clickhouseHttp: 8123,
          clickhouseNative: 9000,
          otlpGrpc: 4317,
          otlpHttp: 4318,
        },
      }),
    );
    app.get("/openapi.json", (c) =>
      c.json({
        openapi: "3.0.0",
        info: { title: "ClickStack (HyperDX + ClickHouse)", version: "0.1.0" },
        paths: {},
      }),
    );

    // 3. Proxy: managed routes handled by Hono, everything else to HyperDX UI
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
