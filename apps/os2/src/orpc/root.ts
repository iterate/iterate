import { createAppRouterWithInternal } from "@iterate-com/shared/apps/internal-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { projectsRouter } from "~/orpc/routers/projects.ts";
import { testRouter } from "~/orpc/routers/test.ts";

/** oRPC app router — sub-routers plus shared `__internal` and app-level procedures */
export const appRouter = createAppRouterWithInternal({
  appConfigSchema: AppConfig,
  createRouter: (internalRouter) =>
    os.router({
      ...testRouter,
      ...projectsRouter,
      __internal: os.__internal.router(internalRouter),
      ping: os.ping.handler(async () => ({
        message: "pong",
        serverTime: new Date().toISOString(),
      })),
      pirateSecret: os.pirateSecret.handler(async ({ context }) => ({
        secret: context.config.pirateSecret.exposeSecret(),
      })),
    }),
});
