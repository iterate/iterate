import { createAppRouterWithInternal } from "@iterate-com/shared/apps/internal-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { streamsRouter } from "~/orpc/routers/streams.ts";

/** oRPC app router — shared `__internal` and streams */
export const appRouter = createAppRouterWithInternal({
  appConfigSchema: AppConfig,
  createRouter: (internalRouter) =>
    os.router({
      ...streamsRouter,
      __internal: os.__internal.router(internalRouter),
    }),
});
