import { createCommonRouter, parseTrpcCliProcedures } from "@iterate-com/shared/apps/common-router";
import { AppConfig } from "~/app.ts";
import { os } from "~/orpc/orpc.ts";
import { secretsRouter } from "~/orpc/routers/secrets.ts";
import { streamsRouter } from "~/orpc/routers/streams.ts";

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

/** oRPC app router — shared `common`, streams, and secrets */
export const appRouter = os.router({
  ...streamsRouter,
  ...secretsRouter,
  common: os.common.router(commonRouter),
});
getTrpcCliProceduresImpl = () => parseTrpcCliProcedures(appRouter);
