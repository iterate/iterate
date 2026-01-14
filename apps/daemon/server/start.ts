import { serve, ServerType } from "@hono/node-server";
import { injectWebSocket } from "./utils/hono.ts";
import app from "./app.ts";
import { createWorkerClient } from "./orpc/client.ts";

export const startServer = async (params: { port: number; hostname: string }) => {
  return new Promise<ServerType>((resolve) => {
    const server = serve({ fetch: app.fetch, ...params }, () => {
      console.log(`Server running at http://${params.hostname}:${params.port}`);

      reportStatusToPlatform().catch(console.error);
      resolve(server);
    });

    injectWebSocket(server);
  });
};

/**
 * Report daemon status to the OS platform.
 * This triggers the bootstrap flow where the platform sends back env vars and repos.
 */
async function reportStatusToPlatform() {
  const client = createWorkerClient();

  const result = await client.machines.reportStatus({ status: "ready" });
  console.log("[bootstrap] Successfully reported status to platform", result);
}
