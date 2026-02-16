import { startServer } from "@iterate-com/daemon/server/start.ts";
import { trpcRouter as daemonRouter } from "@iterate-com/daemon/server/trpc/router.ts";
import { z } from "zod/v4";
import { tasksRouter } from "./procedures/tasks.ts";
import { toolsRouter } from "./procedures/tools.ts";
import { t } from "./trpc.ts";

export const router = t.router({
  daemon: daemonRouter,
  tool: toolsRouter,
  task: tasksRouter,

  server: {
    start: t.procedure
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
  },
});

export type AppRouter = typeof router;
