import { serve, type ServerType } from "@hono/node-server";
import { injectWebSocket } from "./utils/hono.ts";
import app from "./app.ts";
import { createWorkerClient } from "./orpc/client.ts";

export const startServer = async (params: { port: number; hostname: string }) => {
  return new Promise<ServerType>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, ...params }, () => {
      console.log(`\nServer running at http://${params.hostname}:${params.port}`);

      reportStatusToPlatform().catch(console.error);
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
 * Report daemon status to the OS platform.
 * Sending "ready" should trigger the bootstrap flow where the platform sends back env vars and repos.
 * Sending anything else should update the UI so the user knows what's going on.
 */
export async function reportStatusToPlatform({
  status = "ready",
}: Partial<ReportStatusInput> = {}) {
  if (!process.env.ITERATE_OS_BASE_URL || !process.env.ITERATE_OS_API_KEY) return;
  const client = createWorkerClient();

  const result = await client.machines.reportStatus({ status });
  console.log(`[bootstrap] Successfully reported status ${status} to platform`, result);
}
