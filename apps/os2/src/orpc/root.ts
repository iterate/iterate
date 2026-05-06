import { createAppRouterWithInternal } from "@iterate-com/shared/apps/internal-router";
import { AppConfig } from "~/app.ts";
import { activeOrganizationMiddleware, os } from "~/orpc/orpc.ts";
import { codemodeRouter } from "~/orpc/routers/codemode.ts";
import { projectsRouter } from "~/orpc/routers/projects.ts";
import { streamsRouter } from "~/orpc/routers/streams.ts";
import { testRouter } from "~/orpc/routers/test.ts";

/** oRPC app router — sub-routers plus shared `__internal` and app-level procedures */
export const appRouter = createAppRouterWithInternal({
  appConfigSchema: AppConfig,
  createRouter: (internalRouter) =>
    os.router({
      ...testRouter,
      ...projectsRouter,
      ...codemodeRouter,
      ...streamsRouter,
      __internal: os.__internal.router(internalRouter),
      ping: os.ping.use(activeOrganizationMiddleware).handler(async () => ({
        message: "pong",
        serverTime: new Date().toISOString(),
      })),
    }),
});
