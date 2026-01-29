import { serve, type ServerType } from "@hono/node-server";
import { injectWebSocket } from "./utils/hono.ts";
import app from "./app.ts";
import { createWorkerClient } from "./orpc/client.ts";
import { startBootstrapRefreshScheduler, fetchBootstrapData } from "./bootstrap-refresh.ts";
import { loadConfig } from "./config-loader.ts";

export const startServer = async (params: { port: number; hostname: string }) => {
  // Load iterate.config.ts from CWD (or default) before starting server
  await loadConfig();

  return new Promise<ServerType>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, ...params }, () => {
      console.log(`\n[daemon] Server running at http://${params.hostname}:${params.port}`);

      // Bootstrap: report status, fetch env vars, start refresh scheduler
      // Exit on errors so process manager can restart us
      bootstrapWithControlPlane().catch(async (err) => {
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

type ReportStatusInput = Parameters<
  ReturnType<typeof createWorkerClient>["machines"]["reportStatus"]
>[0];

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

/**
 * Report daemon status to the OS platform.
 * Sending "ready" should trigger the bootstrap flow where the platform sends back env vars and repos.
 * Sending anything else should update the UI so the user knows what's going on.
 */
export async function reportStatusToPlatform({
  status = "ready",
}: Partial<ReportStatusInput> = {}) {
  if (!process.env.ITERATE_OS_BASE_URL || !process.env.ITERATE_OS_API_KEY) return;
  const machineId = process.env.ITERATE_MACHINE_ID;
  if (!machineId) {
    console.error("[bootstrap] ITERATE_MACHINE_ID not set, cannot report status");
    return;
  }
  const client = createWorkerClient();

  const result = await client.machines.reportStatus({ machineId, status });
  console.log(`[bootstrap] Successfully reported status ${status} to platform`, result);
}
