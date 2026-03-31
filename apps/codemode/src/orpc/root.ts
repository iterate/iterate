import { createCommonRouter } from "@iterate-com/shared/apps/common-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { runRouter } from "~/orpc/routers/run.ts";

export const appRouter = os.router({
  ...runRouter,
  common: os.common.router(
    createCommonRouter({
      appConfigSchema: AppConfig,
    }),
  ),
});
