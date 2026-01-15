import { createWorkerClient } from "@server/orpc/client.ts";
import { startServer } from "./server/start.ts";

const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3001", 10);

startServer({ port, hostname });

process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received, shutting down...");
  await reportStatusToPlatform({ status: "stopping" }).catch(console.error);
  process.exit(0);
});

type ReportStatusInput = Parameters<
  ReturnType<typeof createWorkerClient>["machines"]["reportStatus"]
>[0];

/**
 * Report daemon status to the OS platform.
 * Sending "ready" should trigger the bootstrap flow where the platform sends back env vars and repos.
 * Sending anything else should update the UI so the user knows what's going on.
 */
async function reportStatusToPlatform({ status = "ready" }: Partial<ReportStatusInput> = {}) {
  const client = createWorkerClient();

  const result = await client.machines.reportStatus({ status });
  console.log(`[bootstrap] Successfully reported status ${status} to platform`, result);
}
