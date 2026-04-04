import { createCommonRouter, parseTrpcCliProcedures } from "@iterate-com/shared/apps/common-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { registryRouter } from "~/orpc/routers/registry.ts";

let getTrpcCliProceduresImpl: (() => ReturnType<typeof parseTrpcCliProcedures>) | undefined;

const commonRouter = createCommonRouter({
  appConfigSchema: AppConfig,
  getTrpcCliProcedures: () => {
    if (!getTrpcCliProceduresImpl) {
      throw new Error("tRPC CLI procedures are not ready yet");
    }

    return getTrpcCliProceduresImpl();
  },
});

/** oRPC app router — shared `common` plus daemon-v2 registry procedures */
export const appRouter = os.router({
  ...registryRouter,
  common: os.common.router(commonRouter),
});
getTrpcCliProceduresImpl = () => parseTrpcCliProcedures(appRouter);
