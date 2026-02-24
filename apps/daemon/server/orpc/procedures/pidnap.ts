import { createClient as createPidnapClient } from "pidnap/client";
import { ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import { publicProcedure } from "../init.ts";

const ProcessDefinition = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  inheritProcessEnv: z.boolean().optional(),
});

const Backoff = z.union([
  z.object({
    type: z.literal("fixed"),
    delayMs: z.number(),
  }),
  z.object({
    type: z.literal("exponential"),
    initialDelayMs: z.number(),
    maxDelayMs: z.number(),
    multiplier: z.number().optional(),
  }),
]);

const RestartOptions = z.object({
  restartPolicy: z.enum(["always", "on-failure", "never", "unless-stopped", "on-success"]),
  backoff: Backoff.optional(),
  crashLoop: z
    .object({
      maxRestarts: z.number(),
      windowMs: z.number(),
      backoffMs: z.number(),
    })
    .optional(),
  minUptimeMs: z.number().optional(),
  maxTotalRestarts: z.number().optional(),
});

const EnvOptions = z.object({
  envFile: z.string().optional(),
  inheritProcessEnv: z.boolean().optional(),
  inheritGlobalEnv: z.boolean().optional(),
  reloadDelay: z.union([z.number(), z.boolean(), z.literal("immediately")]).optional(),
});

const processConfigSchema = z
  .object({
    definition: ProcessDefinition,
    options: RestartOptions.optional(),
    envOptions: EnvOptions.optional(),
    tags: z.array(z.string()).optional(),
    persistence: z.enum(["durable", "ephemeral"]).optional(),
    desiredState: z.enum(["running", "stopped"]).optional(),
  })
  .strict();

function getPidnapClient() {
  return createPidnapClient(process.env.PIDNAP_RPC_URL ?? "http://127.0.0.1:9876/rpc");
}

function throwPidnapError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new ORPCError("INTERNAL_SERVER_ERROR", {
    message: `pidnap RPC failed: ${message}`,
  });
}

export const pidnapRouter = {
  status: publicProcedure.handler(async () => {
    try {
      return await getPidnapClient().manager.status();
    } catch (error) {
      throwPidnapError(error);
    }
  }),

  listProcesses: publicProcedure.handler(async () => {
    try {
      return await getPidnapClient().processes.list();
    } catch (error) {
      throwPidnapError(error);
    }
  }),

  getProcess: publicProcedure
    .input(
      z.object({
        target: z.string(),
        includeEffectiveEnv: z.boolean().optional(),
      }),
    )
    .handler(async ({ input }) => {
      try {
        return await getPidnapClient().processes.get(input);
      } catch (error) {
        throwPidnapError(error);
      }
    }),

  updateConfig: publicProcedure
    .input(
      z.object({
        processSlug: z.string(),
        config: processConfigSchema,
      }),
    )
    .handler(async ({ input }) => {
      try {
        return await getPidnapClient().processes.updateConfig({
          processSlug: input.processSlug,
          ...input.config,
        });
      } catch (error) {
        throwPidnapError(error);
      }
    }),

  delete: publicProcedure
    .input(
      z.object({
        processSlug: z.string(),
      }),
    )
    .handler(async ({ input }) => {
      try {
        return await getPidnapClient().processes.delete(input);
      } catch (error) {
        throwPidnapError(error);
      }
    }),
};
