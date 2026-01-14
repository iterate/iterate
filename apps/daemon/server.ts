import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { injectWebSocket } from "./server/utils/hono.ts";
import app from "./server/app.ts";
import { createWorkerClient } from "./server/orpc/client.ts";

app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ root: "./dist", path: "index.html" }));

const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3001", 10);

const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Server running at http://${hostname}:${port}`);

  // Report status to OS platform if configured
  reportStatusToPlatform();
});

injectWebSocket(server);

/**
 * Report daemon status to the OS platform.
 * This triggers the bootstrap flow where the platform sends back env vars and repos.
 */
async function reportStatusToPlatform() {
  const client = createWorkerClient();

  const result = await client.machines.reportStatus({ status: "ready" });
  console.log("[bootstrap] Successfully reported status to platform", result);
}
