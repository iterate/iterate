import { serve, type ServerType } from "@hono/node-server";
import { injectWebSocket } from "./utils/hono.ts";
import app from "./app.ts";
import { startBootstrapRefreshScheduler, fetchBootstrapData } from "./bootstrap-refresh.ts";
import { reportStatusToPlatform } from "./report-status.ts";

export const startServer = async (
  params: { port: number; hostname: string },
  options?: { autoBootstrap?: boolean },
) => {
  return new Promise<ServerType>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, ...params }, () => {
      console.log(`\n[daemon] Server running at http://${params.hostname}:${params.port}`);

      // Bootstrap: local sync, env fetch, restart PM2, start refresh scheduler
      // Exit on errors so process manager can restart us
      const bootstrap = options?.autoBootstrap
        ? import("./trpc/bootstrap.ts").then(({ bootstrapSandbox }) =>
            bootstrapSandbox({ mode: "auto" }),
          )
        : bootstrapWithControlPlane();

      Promise.resolve(bootstrap).catch(async (err) => {
        console.error("[bootstrap] Fatal error during startup:", err);
        await reportStatusToPlatform({ status: "error" }).catch(() => {});
        process.exit(1);
      });

      resolve(server);
    });

    server.on("error", reject);

    injectWebSocket(server);
  });
};

/**
 * Bootstrap the daemon with the control plane.
 * Reports status, fetches env vars, and starts the refresh scheduler.
 * Throws on error so the process can be restarted.
 */
async function bootstrapWithControlPlane(): Promise<void> {
  // Skip if not connected to control plane (standalone mode)
  if (!process.env.ITERATE_OS_BASE_URL || !process.env.ITERATE_OS_API_KEY) {
    console.log("[bootstrap] No control plane configured, running standalone");
    return;
  }

  await reportStatusToPlatform();
  await fetchBootstrapData();
  startBootstrapRefreshScheduler();
}
