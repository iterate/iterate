import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { injectWebSocket } from "./server/utils/hono.ts";
import app from "./server/app.ts";

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
  const baseUrl = process.env.ITERATE_OS_BASE_URL;
  const apiKey = process.env.ITERATE_OS_API_KEY;

  if (!baseUrl || !apiKey) {
    console.log(
      "[bootstrap] ITERATE_OS_BASE_URL or ITERATE_OS_API_KEY not set, skipping status report",
    );
    return;
  }

  console.log(`[bootstrap] Reporting status to ${baseUrl}/api/machines/status`);

  // Retry with exponential backoff
  const maxRetries = 5;
  const baseDelay = 1000; // 1 second

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/machines/status`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "ready" }),
      });

      if (response.ok) {
        const result = await response.json();
        console.log("[bootstrap] Successfully reported status to platform", result);
        return;
      }

      const errorText = await response.text();
      console.error(`[bootstrap] Failed to report status (${response.status}):`, errorText);

      // Don't retry on 401 (invalid key format) but do retry 403 (key might be stale/updating)
      if (response.status === 401) {
        console.error("[bootstrap] Authentication failed (401), not retrying");
        return;
      }
    } catch (err) {
      console.error(
        `[bootstrap] Error reporting status (attempt ${attempt + 1}/${maxRetries}):`,
        err,
      );
    }

    // Wait before retrying with exponential backoff
    const delay = baseDelay * 2 ** attempt;
    console.log(`[bootstrap] Retrying in ${delay}ms...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  console.error("[bootstrap] Failed to report status after all retries");
}
