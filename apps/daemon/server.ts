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

  reportStatusToPlatform().catch(console.error);
});

injectWebSocket(server);

// Handle graceful shutdown - report stopping status to platform
process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received, reporting stopping status...");

  const baseUrl = process.env.ITERATE_OS_BASE_URL;
  const apiKey = process.env.ITERATE_OS_API_KEY;

  if (baseUrl && apiKey) {
    try {
      await fetch(`${baseUrl}/api/machines/status`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "stopping" }),
      });
      console.log("[shutdown] Reported stopping status to platform");
    } catch (err) {
      console.error("[shutdown] Failed to report stopping status:", err);
    }
  }

  process.exit(0);
});

/**
 * Report daemon status to the OS platform.
 * This triggers the bootstrap flow where the platform sends back env vars and repos.
 */
async function reportStatusToPlatform() {
  const client = createWorkerClient();

  const result = await client.machines.reportStatus({ status: "ready" });
  console.log("[bootstrap] Successfully reported status to platform", result);
}
