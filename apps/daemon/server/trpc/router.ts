import { homedir } from "node:os";
import { agentTrpcRouter } from "../routers/agents.ts";
import type { SerializedAgent, SerializedAgentRoute } from "../routers/agents.ts";
import { createTRPCRouter, mergeRouters, publicProcedure } from "./init.ts";
import { platformRouter, getCustomerRepoPath } from "./platform.ts";

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

  restartDaemon: publicProcedure.mutation(async (): Promise<{ success: boolean }> => {
    const { reportStatusToPlatform } = await import("../start.ts");

    await reportStatusToPlatform({ status: "stopping" }).catch((err) => {
      console.error("[restartDaemon] Failed to report stopping status:", err);
    });

    setTimeout(() => {
      console.log("[restartDaemon] Exiting for s6 restart...");
      process.exit(0);
    }, 100);

    return { success: true };
  }),
});

export const trpcRouter = mergeRouters(baseProcedures, agentTrpcRouter);

export type { SerializedAgent, SerializedAgentRoute };
