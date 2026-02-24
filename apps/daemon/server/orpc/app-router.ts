import { z } from "zod/v4";
import { startServer } from "../start.ts";
import { pidnapRouter } from "./procedures/pidnap.ts";
import { tasksRouter } from "./procedures/tasks.ts";
import { toolsRouter } from "./procedures/tools.ts";
import { publicProcedure } from "./init.ts";
import { daemonRouter } from "./router.ts";

export const appRouter = {
  daemon: daemonRouter,
  tool: toolsRouter,
  task: tasksRouter,
  pidnap: pidnapRouter,
  server: {
    start: publicProcedure
      .input(
        z.object({
          port: z.number().default(3001),
          hostname: z.string().default("localhost"),
        }),
      )
      .handler(async ({ input }) => {
        const server = await startServer(input);
        return { success: true, address: server.address() };
      }),
  },
};

export type AppRouter = typeof appRouter;
