import { implement, ORPCError } from "@orpc/server";
import type { AnyRouter } from "trpc-cli";
import { parseRouter } from "trpc-cli";
import { z, type ZodTypeAny } from "zod";
import { getPublicConfig } from "./config.ts";
import { commonContract } from "./common-router-contract.ts";
import type { AppContext } from "./types.ts";

export function createCommonRouter<TConfigSchema extends ZodTypeAny>(options: {
  appConfigSchema: TConfigSchema;
  getTrpcCliProcedures?: () => unknown[];
}) {
  const os = implement(commonContract).$context<AppContext<any, z.output<TConfigSchema>>>();

  return os.router({
    health: os.health.handler(({ context }) => ({
      ok: true as const,
      app: context.manifest.slug,
      version: context.manifest.version,
    })),
    publicConfig: os.publicConfig.handler(({ context }) =>
      getPublicConfig(context.config, options.appConfigSchema),
    ),
    debug: os.debug.handler(() => createCommonDebugOutput()),
    trpcCliProcedures: os.trpcCliProcedures.handler(() => {
      if (!options.getTrpcCliProcedures) {
        throw new ORPCError("NOT_IMPLEMENTED", {
          message: "common.trpcCliProcedures is not implemented for this app yet",
        });
      }

      return {
        procedures: options.getTrpcCliProcedures(),
      };
    }),
    refreshRegistry: os.refreshRegistry.handler(() => {
      throw new ORPCError("NOT_IMPLEMENTED", {
        message: "common.refreshRegistry is not implemented for this app yet",
      });
    }),
  });
}

export function createCommonDebugOutput() {
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
  return parseRouter({ router }).filter((entry) => entry[0] !== "common.trpcCliProcedures");
}
