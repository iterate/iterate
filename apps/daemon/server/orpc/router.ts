import { homedir } from "node:os";
import { agentOrpcRouter } from "../routers/agents.ts";
import { configRepoOrpcRouter } from "../routers/config-repo.ts";
import { pullIterateIterateRouter } from "../routers/pull-iterate-iterate.ts";
import type { SerializedAgent, SerializedAgentRoute } from "../routers/agents.ts";
import { metaMcpOrpcRouter } from "./meta-mcp.ts";
import { publicProcedure } from "./init.ts";
import { getCustomerRepoPathOrNull } from "./platform.ts";

const baseProcedures = {
  hello: publicProcedure.handler(() => ({ message: "Hello from oRPC!" })),

  getServerCwd: publicProcedure.handler(async () => {
    return {
      cwd: process.cwd(),
      homeDir: homedir(),
      customerRepoPath: getCustomerRepoPathOrNull(),
    };
  }),

  restartDaemon: publicProcedure.handler(async (): Promise<{ success: boolean }> => {
    const { reportStatusToPlatform } = await import("../start.ts");

    await reportStatusToPlatform({ status: "stopping" }).catch((err) => {
      console.error("[restartDaemon] Failed to report stopping status:", err);
    });

    setTimeout(() => {
      console.log("[restartDaemon] Exiting for pidnap restart...");
      process.exit(0);
    }, 100);

    return { success: true };
  }),
};

export const daemonRouter = {
  ...baseProcedures,
  ...agentOrpcRouter,
  ...pullIterateIterateRouter,
  configRepo: configRepoOrpcRouter,
  metaMcp: metaMcpOrpcRouter,
};

export type { SerializedAgent, SerializedAgentRoute };
