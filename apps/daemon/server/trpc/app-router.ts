import { z } from "zod/v4";
import { startServer } from "../start.ts";
import { tasksRouter } from "./procedures/tasks.ts";
import { toolsRouter } from "./procedures/tools.ts";
import { createTRPCRouter, publicProcedure } from "./init.ts";
import { trpcRouter } from "./router.ts";

export const appRouter = createTRPCRouter({
  daemon: trpcRouter,
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
