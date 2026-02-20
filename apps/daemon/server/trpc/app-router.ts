import { homedir } from "node:os";
import { z } from "zod/v4";
import { agentTrpcRouter } from "../routers/agents.ts";
import { startServer } from "../start.ts";
import { tasksRouter } from "./procedures/tasks.ts";
import { toolsRouter } from "./procedures/tools.ts";
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

export const daemonRouter = mergeRouters(baseProcedures, agentTrpcRouter);

export const appRouter = createTRPCRouter({
  daemon: daemonRouter,
  tool: toolsRouter,
  task: tasksRouter,
  server: createTRPCRouter({
    start: publicProcedure
      .input(
        z.object({
          port: z.number().default(3001),
          hostname: z.string().default("localhost"),
        }),
      )
      .mutation(async ({ input }) => {
        const server = await startServer(input);
        return { success: true, address: server.address() };
      }),
  }),
});

export type AppRouter = typeof appRouter;
