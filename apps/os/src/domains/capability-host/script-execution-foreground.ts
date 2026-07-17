import { settleByDeadline } from "./execution-deadline.ts";
import type {
  ScriptExecutionAuthority,
  ScriptExecutorRunInput,
} from "./script-executor-entrypoint.ts";
import {
  SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS,
  settlementFromWorkerOutcome,
  type ScriptExecutionSettlement,
} from "./script-execution-settlement.ts";

export type ForegroundScriptExecutor = {
  run(input: ScriptExecutorRunInput): Promise<unknown>;
};

const MAX_SETTLEMENT_COMMIT_ATTEMPTS = 4;

/**
 * Invoke one already-prepared script from the existing top-level ITX request.
 * The CapabilityHost call that journaled and prepared it has returned, so the
 * Dynamic Worker's callbacks enter the host from a bounded request lineage.
 */
export async function executeForegroundScript(input: {
  authority: ScriptExecutionAuthority;
  executor: ForegroundScriptExecutor;
  preparation: {
    code: string;
    emittedJs?: string;
    expiresAt: number;
  };
  now?: () => number;
}): Promise<ScriptExecutionSettlement> {
  const now = input.now ?? Date.now;
  const executionDeadline = input.preparation.expiresAt - SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS;
  if (now() >= executionDeadline) {
    return {
      status: "failed",
      error:
        "Script execution reached its absolute deadline after its start was recorded but before the worker was invoked. It never ran.",
      failureKind: "deadline",
      phase: "before-execution",
      executionMayHaveOccurred: false,
      cancellation: "not-applicable",
    };
  }
  const runPromise = input.executor.run({
    authority: input.authority,
    code: input.preparation.code,
    emittedJs: input.preparation.emittedJs,
    expiresAt: executionDeadline,
  });
  const outcome = await settleByDeadline(runPromise, executionDeadline, now);
  if (outcome.status === "deadline") {
    (runPromise as Promise<unknown> & Partial<Disposable>)[Symbol.dispose]?.();
  }
  return settlementFromWorkerOutcome(outcome);
}

type SettlementCommitOutcome =
  | { status: "committed" }
  | { status: "commit-failed"; error: unknown };

type SettlementObservationOutcome<T> =
  | { status: "observed"; value: T }
  | { status: "observation-failed"; error: unknown };

/**
 * Idempotently hand the executor's exact outcome back to its durable host and
 * return only the exact journal event observed on the Stream DO. A Workers
 * RPC rejection is ambiguous: the append may have committed before its
 * acknowledgement was lost. Retrying this settlement is safe (all attempts
 * use the execution's one completion idempotency key); retrying userspace is
 * deliberately impossible.
 *
 * The observer participates in every race. If it sees the durable event while
 * an RPC attempt is still in flight, that event is already authoritative and
 * the caller can finish. Both sides install rejection handlers up front, so a
 * winning branch never leaves an abandoned promise to reject unobserved.
 */
export async function commitForegroundScriptSettlement<T>(input: {
  commit: () => Promise<void>;
  /**
   * Lazily connect the exact-event observer. The commit RPC is dispatched
   * first so a long-lived Stream DO WebSocket cannot occupy the outbound lane
   * needed to create the event it is waiting for. Connecting after dispatch
   * cannot miss the event: the Stream DO point-reads this idempotency key
   * before accepting every observer socket.
   */
  observe: () => Promise<T>;
  /** Test seam only. */
  maxAttempts?: number;
  /** Test/telemetry seam only. */
  onCommitFailure?: (input: { attempt: number; error: unknown }) => void;
}): Promise<T> {
  const maxAttempts = input.maxAttempts ?? MAX_SETTLEMENT_COMMIT_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive safe integer");
  }

  let observation: Promise<SettlementObservationOutcome<T>> | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Invoke synchronously before constructing the observer promise. Workers
    // RPC dispatch begins at the call site even though its result is async.
    let commitCall: Promise<void>;
    try {
      commitCall = input.commit();
    } catch (error) {
      commitCall = Promise.reject(error);
    }
    const commit: Promise<SettlementCommitOutcome> = Promise.resolve(commitCall).then(
      () => ({ status: "committed" }),
      (error: unknown) => {
        input.onCommitFailure?.({ attempt, error });
        return { status: "commit-failed", error };
      },
    );
    observation ??= Promise.resolve()
      .then(input.observe)
      .then(
        (value) => ({ status: "observed", value }),
        (error: unknown) => ({ status: "observation-failed", error }),
      );
    const outcome = await Promise.race([observation, commit]);
    if (outcome.status === "observed") return outcome.value;
    if (outcome.status === "observation-failed") throw outcome.error;
    if (outcome.status === "committed") {
      const observed = await observation;
      if (observed.status === "observed") return observed.value;
      throw observed.error;
    }
    if (attempt === maxAttempts) {
      const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      throw new Error(
        `Script settlement commit failed after ${maxAttempts} bounded idempotent attempts: ${detail}`,
        { cause: outcome.error },
      );
    }
  }

  throw new Error("unreachable script settlement commit state");
}
