import { createAppRouterWithCommon } from "@iterate-com/shared/apps/common-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { secretsRouter } from "~/orpc/routers/secrets.ts";
import { streamsRouter } from "~/orpc/routers/streams.ts";

/** oRPC app router — shared `common`, streams, and secrets */
export const appRouter = createAppRouterWithCommon({
  appConfigSchema: AppConfig,
  createRouter: (commonRouter) =>
    os.router({
      ...streamsRouter,
      ...secretsRouter,
      common: os.common.router(commonRouter),
    }),
});
