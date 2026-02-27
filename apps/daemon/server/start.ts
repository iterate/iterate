import { serve, type ServerType } from "@hono/node-server";
import { injectWebSocket } from "./utils/hono.ts";
import app from "./app.ts";
import { createWorkerClient } from "./orpc/client.ts";
import { startCronTaskScheduler } from "./cron-tasks/scheduler.ts";
import { loadConfig } from "./config-loader.ts";

export const startServer = async (params: { port: number; hostname: string }) => {
  // Load iterate.config.ts from CWD (or default) before starting server
  await loadConfig();

  return new Promise<ServerType>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, ...params }, () => {
      console.log(`\n[daemon] Server running at http://${params.hostname}:${params.port}`);

      // Report ready to control plane + start cron scheduler
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
 * Report daemon ready status and start background schedulers.
 * The OS reacts to "ready" by pushing env vars, repos, etc. via tool.writeFile/execCommand.
 */
async function bootstrapWithControlPlane(): Promise<void> {
  await reportStatusToPlatform({ status: "ready" });
  await startCronTaskScheduler();
}

/**
 * Report daemon status to the OS platform.
 * Sending "ready" triggers the OS to push setup data (env vars, repos) to this daemon.
 */
export async function reportStatusToPlatform({ status }: Pick<ReportStatusInput, "status">) {
  if (!process.env.ITERATE_OS_BASE_URL) {
    console.error("[bootstrap] ITERATE_OS_BASE_URL not set, cannot report status");
    return;
  }
  if (!process.env.ITERATE_OS_API_KEY) {
    console.error("[bootstrap] ITERATE_OS_API_KEY not set, cannot report status");
    return;
  }
  const machineId = process.env.ITERATE_MACHINE_ID;
  if (!machineId) {
    console.error("[bootstrap] ITERATE_MACHINE_ID not set, cannot report status");
    return;
  }
  const client = createWorkerClient();

  const result = await client.machines.reportStatus({ machineId, status });
  console.log(`[bootstrap] Successfully reported status ${status} to platform`, result);
}
