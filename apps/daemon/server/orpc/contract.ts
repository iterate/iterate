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
          status: z
            .enum(["ready", "error"])
            .or(z.templateLiteral([z.literal("working:"), z.string()])),
          message: z.string().optional(),
        }),
      )
      .output(z.object({ success: z.boolean() })),
  }),
});

export type WorkerContract = typeof workerContract;
