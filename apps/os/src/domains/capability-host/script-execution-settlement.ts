import {
  ScriptExecutionSettlement as ScriptExecutionSettlementSchema,
  type ScriptExecutionSettlement as ScriptExecutionSettlementValue,
} from "@iterate-com/shared/script-execution";
import type { StreamEvent } from "../streams/schemas.ts";
import type { DeadlineOutcome } from "./execution-deadline.ts";

export const ScriptExecutionSettlement = ScriptExecutionSettlementSchema;
export type ScriptExecutionSettlement = ScriptExecutionSettlementValue;

/** Parse the terminal fact for one exact script obligation. */
export function scriptSettlementFromEvent(
  event: StreamEvent,
  executionId: string,
): ScriptExecutionSettlementValue | undefined {
  if (event.type !== "events.iterate.com/capability-host/script-run-settled") return undefined;
  const payload = event.payload;
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.executionId !== executionId
  ) {
    return undefined;
  }
  const settlement = ScriptExecutionSettlement.safeParse(payload.settlement);
  return settlement.success ? settlement.data : undefined;
}

// The worker must return before the obligation deadline so the host still has
// time to journal its one durable settlement. Every individual journal append
// attempt is bounded by the same interval; a timeout rejects the tracked
// attempt and the keepalive/reconciler retries the idempotent completion.
export const SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS = 15_000;
/** Time for an already-committed completion to traverse the processor before
 * the public RPC gives up. This never extends the execution deadline. */
export const SCRIPT_COMPLETION_OBSERVATION_GRACE_MS = 15_000;

const WORKER_EXECUTION_DEADLINE_ERROR =
  "Script execution exceeded its absolute deadline after it started. The host stopped waiting for the worker RPC, but arbitrary external work cannot be proven terminated. It may have partially executed; it was NOT re-run.";
const INVALID_WORKER_SETTLEMENT_ERROR =
  "Script execution returned an invalid settlement. The script may have partially executed; it was NOT re-run.";

export function settlementForUndrivenScript(
  status: "requested" | "started",
): ScriptExecutionSettlementValue {
  return status === "started"
    ? {
        status: "failed",
        error:
          "Script execution orphaned: the incarnation running it went away before completing (eviction mid-run). It may have partially executed; it was NOT re-run.",
        failureKind: "orphaned",
        phase: "recovery",
        executionMayHaveOccurred: true,
        cancellation: "external-work-may-continue",
      }
    : {
        status: "failed",
        error:
          "Script execution expired before any attempt started (the host was down past the request's expiry). It never ran.",
        failureKind: "expired",
        phase: "before-execution",
        executionMayHaveOccurred: false,
        cancellation: "not-applicable",
      };
}

export function settlementFromWorkerOutcome(
  outcome: DeadlineOutcome<unknown>,
): ScriptExecutionSettlementValue {
  if (outcome.status === "fulfilled") {
    const parsed = ScriptExecutionSettlement.safeParse(outcome.value);
    return parsed.success
      ? parsed.data
      : {
          status: "failed",
          error: INVALID_WORKER_SETTLEMENT_ERROR,
          failureKind: "runtime",
          phase: "execution",
          executionMayHaveOccurred: true,
          cancellation: "external-work-may-continue",
        };
  }
  if (outcome.status === "deadline") {
    return {
      status: "failed",
      error: WORKER_EXECUTION_DEADLINE_ERROR,
      failureKind: "deadline",
      phase: "execution",
      executionMayHaveOccurred: true,
      cancellation: "external-work-may-continue",
    };
  }
  return {
    status: "failed",
    error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    failureKind: "runtime",
    phase: "execution",
    executionMayHaveOccurred: true,
    cancellation: "external-work-may-continue",
  };
}

export function settlementAppendDeadline(
  inputs: readonly { expiresAt: number }[],
  now: number,
): number {
  if (inputs.length === 0) throw new Error("a settlement append requires at least one input");
  return Math.min(
    ...inputs.map(({ expiresAt }) =>
      expiresAt > now
        ? Math.min(expiresAt, now + SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS)
        : now + SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS,
    ),
  );
}

export function scriptCompletionInput(input: {
  executionId: string;
  idempotencyKey: string;
  settlement: ScriptExecutionSettlementValue;
}) {
  return {
    type: "events.iterate.com/capability-host/script-run-settled",
    idempotencyKey: input.idempotencyKey,
    // The settlement parser already proves any successful result is JSON, so
    // constructing the completion cannot introduce a new failure boundary.
    payload: { executionId: input.executionId, settlement: input.settlement },
  } as const;
}
