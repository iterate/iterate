import { createAppRouterWithInternal } from "@iterate-com/shared/apps/internal-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { sampleRouter } from "~/orpc/routers/sample.ts";
import { subscribeRouter } from "~/orpc/routers/subscribe.ts";

/** oRPC app router — shared `__internal` plus sample + subscribe procedures */
export const appRouter = createAppRouterWithInternal({
  appConfigSchema: AppConfig,
  createRouter: (internalRouter) =>
    os.router({
      ...sampleRouter,
      ...subscribeRouter,
      __internal: os.__internal.router(internalRouter),
    }),
});
