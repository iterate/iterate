import { createAppRouterWithCommon } from "@iterate-com/shared/apps/common-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { testRouter } from "~/orpc/routers/test.ts";
import { thingsRouter } from "~/orpc/routers/things.ts";

/** oRPC app router — sub-routers plus shared `common` and app-level procedures */
export const appRouter = createAppRouterWithCommon({
  appConfigSchema: AppConfig,
  createRouter: (commonRouter) =>
    os.router({
      ...testRouter,
      ...thingsRouter,
      common: os.common.router(commonRouter),
      ping: os.ping.handler(async () => ({
        message: "pong",
        serverTime: new Date().toISOString(),
      })),
      pirateSecret: os.pirateSecret.handler(async ({ context }) => ({
        secret: context.config.pirateSecret.exposeSecret(),
      })),
    }),
});
