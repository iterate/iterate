import { z } from "zod";

export const ScriptExecutionSettlement = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    result: z.json().optional(),
    resultOmitted: z
      .strictObject({
        reason: z.literal("oversized"),
        serializedChars: z.number().int().nonnegative(),
        preview: z.string(),
        typeText: z.string(),
      })
      .optional()
      .meta({
        description:
          "Present when the script succeeded but its return value was too large to journal " +
          "as a durable event (settlement events fan out to every fold and delivery lane in " +
          "the stream DO's isolate, so an oversized result is a memory bomb). The value " +
          "itself is gone; this records what it looked like.",
      }),
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: z.string(),
    failureKind: z.enum(["typecheck", "runtime", "deadline", "expired", "orphaned"]),
    phase: z.enum(["typecheck", "before-execution", "execution", "recovery"]),
    executionMayHaveOccurred: z.boolean(),
    cancellation: z.enum(["not-applicable", "external-work-may-continue"]),
  }),
]);

export type ScriptExecutionSettlement = z.infer<typeof ScriptExecutionSettlement>;
