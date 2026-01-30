import { oc } from "@orpc/contract";
import { z } from "zod/v4";

/**
 * oRPC contract for daemon -> worker communication.
 * The contract is defined here in the daemon package so both sides can import it.
 * The worker implements the contract, and the daemon creates a client from it.
 */
export const workerContract = oc.router({
  machines: oc.router({
    /**
     * Report daemon status to the worker.
     * Called when daemon boots to report that it's ready.
     */
    reportStatus: oc
      .input(
        z.object({
          machineId: z.string(),
          status: z
            .enum(["ready", "error", "stopping"])
            .or(z.templateLiteral([z.literal("working:"), z.string()])),
          message: z.string().optional(),
        }),
      )
      .output(z.object({ success: z.boolean() })),

    /**
     * Get environment variables and config for this machine.
     * Called by the daemon on startup and periodically to refresh tokens.
     * Returns environment variables (GitHub token, Slack token, etc.) and repos to clone.
     */
    getEnv: oc.input(z.object({ machineId: z.string() })).output(
      z.object({
        envVars: z.array(
          z.object({
            key: z.string(),
            value: z.string(),
            description: z.string().nullable(),
            source: z.discriminatedUnion("type", [
              z.object({ type: z.literal("global"), description: z.string() }),
              z.object({
                type: z.literal("connection"),
                provider: z.enum(["github", "slack", "google"]),
              }),
              z.object({ type: z.literal("user"), envVarId: z.string() }),
              z.object({
                type: z.literal("recommended"),
                provider: z.enum(["google"]),
                userEmail: z.string(),
              }),
            ]),
          }),
        ),
        repos: z.array(
          z.object({
            url: z.string(),
            branch: z.string(),
            path: z.string(),
            owner: z.string(),
            name: z.string(),
          }),
        ),
      }),
    ),
  }),
});

export type WorkerContract = typeof workerContract;
