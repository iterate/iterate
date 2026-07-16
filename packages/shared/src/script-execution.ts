import { z } from "zod";

export const ScriptExecutionSettlement = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    result: z.json().optional(),
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
