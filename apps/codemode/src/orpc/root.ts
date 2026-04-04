import { createAppRouterWithCommon } from "@iterate-com/shared/apps/common-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { runRouter } from "~/orpc/routers/run.ts";
import { secretsRouter } from "~/orpc/routers/secrets.ts";

export const appRouter = createAppRouterWithCommon({
  appConfigSchema: AppConfig,
  createRouter: (commonRouter) =>
    os.router({
      ...secretsRouter,
      ...runRouter,
      common: os.common.router(commonRouter),
    }),
});
