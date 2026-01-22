import { orpcRouter as daemonRouter } from "@iterate-com/daemon/server/trpc/router.ts";
import { startServer } from "@iterate-com/daemon/server/start.ts";
import { z } from "zod/v4";
import { os } from "@orpc/server";
import { toolsRouter } from "./procedures/tools.ts";

const pub = os.$context<object>();

export const router = {
  /** Daemon oRPC router - all daemon procedures */
  daemon: daemonRouter,

  /** Top-level tool commands */
  tool: toolsRouter,

  server: {
    start: pub
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

export type AppRouter = typeof router;
