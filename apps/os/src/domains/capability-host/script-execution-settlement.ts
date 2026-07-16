import { z } from "zod";

const ScriptExecutionFailure = z.strictObject({
  status: z.literal("failed"),
  error: z.string(),
  failureKind: z.enum(["typecheck", "runtime", "deadline", "expired", "orphaned"]),
  phase: z.enum(["typecheck", "before-execution", "execution", "recovery"]),
  executionMayHaveOccurred: z.boolean(),
  cancellation: z.enum(["not-applicable", "external-work-may-continue"]),
});

export const ScriptExecutionSettlement = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    result: z.unknown().optional(),
  }),
  ScriptExecutionFailure,
]);

export type ScriptExecutionSettlement = z.infer<typeof ScriptExecutionSettlement>;
