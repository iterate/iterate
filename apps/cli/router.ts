import { trpcRouter as daemonRouter } from "@iterate-com/daemon/server/trpc/router.ts";
import { toolsRouter } from "./procedures/tools.ts";
import { t } from "./trpc.ts";

export const router = t.router({
  /** Daemon tRPC router - all daemon procedures */
  daemon: daemonRouter,

  /** Top-level tool commands */
  tool: toolsRouter,
});

export type AppRouter = typeof router;
