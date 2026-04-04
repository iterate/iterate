import { createAppRouterWithInternal } from "@iterate-com/shared/apps/internal-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { registryRouter } from "~/orpc/routers/registry.ts";

/** oRPC app router — shared `__internal` plus daemon-v2 registry procedures */
export const appRouter = createAppRouterWithInternal({
  appConfigSchema: AppConfig,
  createRouter: (internalRouter) =>
    os.router({
      ...registryRouter,
      __internal: os.__internal.router(internalRouter),
    }),
});
