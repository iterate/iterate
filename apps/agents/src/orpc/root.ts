import { createAppRouterWithInternal } from "@iterate-com/shared/apps/internal-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { basePathDefaultsRouter } from "~/orpc/routers/base-path-defaults.ts";
import { createAgentRouter } from "~/orpc/routers/create-agent.ts";
import { installProcessorRouter } from "~/orpc/routers/install-processor.ts";
import { sampleRouter } from "~/orpc/routers/sample.ts";

/** oRPC app router — shared `__internal` plus sample + agent-config procedures. */
export const appRouter = createAppRouterWithInternal({
  appConfigSchema: AppConfig,
  createRouter: (internalRouter) =>
    os.router({
      ...sampleRouter,
      ...installProcessorRouter,
      ...basePathDefaultsRouter,
      ...createAgentRouter,
      __internal: os.__internal.router(internalRouter),
    }),
});
