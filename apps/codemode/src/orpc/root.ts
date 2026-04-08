import { createAppRouterWithInternal } from "@iterate-com/shared/apps/internal-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { runRouter } from "~/orpc/routers/run.ts";
import { secretsRouter } from "~/orpc/routers/secrets.ts";

export const appRouter = createAppRouterWithInternal({
  appConfigSchema: AppConfig,
  createRouter: (internalRouter) =>
    os.router({
      ...secretsRouter,
      ...runRouter,
      __internal: os.__internal.router(internalRouter),
    }),
});
