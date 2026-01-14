import { trpcRouter as daemonRouter } from "@iterate-com/daemon/server/trpc/router.ts";
import { startServer } from "@iterate-com/daemon/server/start.ts";
import z from "zod";
import { toolsRouter } from "./procedures/tools.ts";
import { t } from "./trpc.ts";

export const router = t.router({
  /** Daemon tRPC router - all daemon procedures */
  daemon: daemonRouter,

  /** Top-level tool commands */
  tool: toolsRouter,

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
