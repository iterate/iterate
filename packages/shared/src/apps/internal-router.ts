import { implement, ORPCError } from "@orpc/server";
import type { AnyRouter } from "trpc-cli";
import { parseRouter } from "trpc-cli";
import { z, type ZodTypeAny } from "zod";
import { getPublicConfig } from "./config.ts";
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
  if (typeof process === "undefined") {
    return { runtime: "workerd" };
  }

  return {
    runtime: "node",
    pid: process.pid,
    ppid: process.ppid,
    uptimeSec: process.uptime(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    execPath: process.execPath,
    argv: process.argv,
    env: Object.fromEntries(
      Object.entries(process.env).map(([key, value]) => [key, value ?? null] as const),
    ),
    memoryUsage: process.memoryUsage(),
  };
}

export function parseTrpcCliProcedures(router: AnyRouter) {
  return parseRouter({ router }).filter((entry) => entry[0] !== "__internal.trpcCliProcedures");
}
