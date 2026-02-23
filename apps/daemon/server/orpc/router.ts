import { homedir } from "node:os";
import { agentOrpcRouter } from "../routers/agents.ts";
import type { SerializedAgent, SerializedAgentRoute } from "../routers/agents.ts";
import { publicProcedure } from "./init.ts";
import { getCustomerRepoPath } from "./platform.ts";

const baseProcedures = {
  hello: publicProcedure.handler(() => ({ message: "Hello from oRPC!" })),

  getServerCwd: publicProcedure.handler(async () => {
    return {
      cwd: process.cwd(),
      homeDir: homedir(),
      customerRepoPath: await getCustomerRepoPath(),
    };
  }),

  restartDaemon: publicProcedure.handler(async (): Promise<{ success: boolean }> => {
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
};

export const daemonRouter = { ...baseProcedures, ...agentOrpcRouter };

export type { SerializedAgent, SerializedAgentRoute };
