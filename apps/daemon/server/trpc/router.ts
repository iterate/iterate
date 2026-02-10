import { homedir } from "node:os";
import { createTRPCRouter, mergeRouters, publicProcedure } from "./init.ts";
import { platformRouter, getCustomerRepoPath } from "./platform.ts";
import { agentTrpcRouter } from "../routers/agents.ts";
import type { SerializedAgent, SerializedAgentRoute } from "../routers/agents.ts";

const baseProcedures = createTRPCRouter({
  platform: platformRouter,
  hello: publicProcedure.query(() => ({ message: "Hello from tRPC!" })),

  getServerCwd: publicProcedure.query(async () => {
    return {
      cwd: process.cwd(),
      homeDir: homedir(),
      customerRepoPath: await getCustomerRepoPath(),
    };
  }),

  // ============ Daemon Lifecycle ============

  /**
   * Restart the daemon process. The s6 supervisor will automatically restart it.
   * This is much faster than restarting the entire Daytona sandbox.
   */
  restartDaemon: publicProcedure.mutation(async (): Promise<{ success: boolean }> => {
    // Import lazily to avoid circular dependency issues at startup
    const { reportStatusToPlatform } = await import("../start.ts");

    // Report stopping status to platform before exiting
    await reportStatusToPlatform({ status: "stopping" }).catch((err) => {
      console.error("[restartDaemon] Failed to report stopping status:", err);
    });

    // Schedule exit after responding - s6 will restart us
    setTimeout(() => {
      console.log("[restartDaemon] Exiting for s6 restart...");
      process.exit(0);
    }, 100);

    return { success: true };
  }),
});

export const trpcRouter = mergeRouters(baseProcedures, agentTrpcRouter);

export type TRPCRouter = typeof trpcRouter;

export type { SerializedAgent, SerializedAgentRoute };
