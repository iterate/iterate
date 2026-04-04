import { createAppRouterWithCommon } from "@iterate-com/shared/apps/common-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { registryRouter } from "~/orpc/routers/registry.ts";

/** oRPC app router — shared `common` plus daemon-v2 registry procedures */
export const appRouter = createAppRouterWithCommon({
  appConfigSchema: AppConfig,
  createRouter: (commonRouter) =>
    os.router({
      ...registryRouter,
      common: os.common.router(commonRouter),
    }),
});
