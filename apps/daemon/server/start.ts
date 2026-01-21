import { serve, type ServerType } from "@hono/node-server";
import { injectWebSocket } from "./utils/hono.ts";
import app from "./app.ts";
import { bootstrapSandbox } from "./trpc/bootstrap.ts";
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
      const bootstrap = bootstrapSandbox({ mode: options?.autoBootstrap ? "auto" : "manual" });

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
