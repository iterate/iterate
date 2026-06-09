import { implement, ORPCError } from "@orpc/server";
import type { AnyRouter } from "trpc-cli";
import { parseRouter } from "trpc-cli";
import { z, type ZodTypeAny } from "zod";
import { getPublicConfig } from "../config.ts";
import { internalContract } from "./internal-router-contract.ts";
import type { AppContext } from "./types.ts";

export function createInternalRouter<TConfigSchema extends ZodTypeAny>(options: {
  appConfigSchema: TConfigSchema;
  getTrpcCliProcedures?: () => unknown[];
}) {
  const os = implement(internalContract).$context<AppContext<any, z.output<TConfigSchema>>>();

  return os.router({
    health: os.health.handler(({ context }) => ({
      ok: true as const,
      app: context.manifest.slug,
      version: context.manifest.version,
    })),
    publicConfig: os.publicConfig.handler(({ context }) =>
      getPublicConfig(context.config, options.appConfigSchema),
    ),
    debug: os.debug.handler(() => createInternalDebugOutput()),
    trpcCliProcedures: os.trpcCliProcedures.handler(() => {
      if (!options.getTrpcCliProcedures) {
        throw new ORPCError("NOT_IMPLEMENTED", {
          message: "__internal.trpcCliProcedures is not implemented for this app yet",
        });
      }

      return {
        procedures: options.getTrpcCliProcedures(),
      };
    }),
    refreshRegistry: os.refreshRegistry.handler(() => {
      throw new ORPCError("NOT_IMPLEMENTED", {
        message: "__internal.refreshRegistry is not implemented for this app yet",
      });
    }),
  });
}

export function createAppRouterWithInternal<
  TConfigSchema extends ZodTypeAny,
  TRouter extends AnyRouter,
>(options: {
  appConfigSchema: TConfigSchema;
  createRouter: (internalRouter: ReturnType<typeof createInternalRouter<TConfigSchema>>) => TRouter;
}) {
  let appRouter: TRouter | undefined;

  const internalRouter = createInternalRouter({
    appConfigSchema: options.appConfigSchema,
    getTrpcCliProcedures: () => {
      if (!appRouter) {
        throw new Error("tRPC CLI procedures are not ready yet");
      }

      return parseTrpcCliProcedures(appRouter);
    },
  });

  appRouter = options.createRouter(
    internalRouter as ReturnType<typeof createInternalRouter<TConfigSchema>>,
  );
  return appRouter;
}

export function createInternalDebugOutput() {
  // SECURITY: `/__internal/debug` is UNAUTHENTICATED. This used to return
  // `process.env`, but under `nodejs_compat` (which all our workers enable)
  // `process` is defined and `process.env` contains the raw `APP_CONFIG`
  // secret blob — so the secrets leaked publicly. Never put env/secrets here.
  return { runtime: "workerd" as const };
}

export function parseTrpcCliProcedures(router: AnyRouter) {
  return parseRouter({ router }).filter((entry) => entry[0] !== "__internal.trpcCliProcedures");
}
