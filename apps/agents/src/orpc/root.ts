import { createAppRouterWithInternal } from "@iterate-com/shared/apps/internal-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { createAgentRouter } from "~/orpc/routers/create-agent.ts";
import { sampleRouter } from "~/orpc/routers/sample.ts";

/** oRPC app router — shared `__internal` plus sample + create-agent procedures */
export const appRouter = createAppRouterWithInternal({
  appConfigSchema: AppConfig,
  createRouter: (internalRouter) =>
    os.router({
      ...sampleRouter,
      ...createAgentRouter,
      __internal: os.__internal.router(internalRouter),
    }),
});
