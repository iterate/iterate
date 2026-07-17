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
 * Invoke one already-prepared script from its explicit foreground driver. The
 * CapabilityHost call that journaled and prepared it has returned, so the
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

type SettlementCommitOutcome<T> =
  | { status: "committed"; value: T }
  | { status: "commit-failed"; error: unknown };

/**
 * Idempotently hand the executor's exact outcome back to its durable host and
 * return the exact journal event supplied by the acknowledged append. A
 * Workers RPC rejection is ambiguous: the append may have committed before
 * its acknowledgement was lost. Retrying this settlement is safe (all
 * attempts use the execution's one completion idempotency key); retrying
 * userspace is deliberately impossible. Only after every bounded commit
 * acknowledgement fails do we point-read/observe the exact idempotency key.
 *
 * The healthy path never opens a second Stream DO request. The append result
 * is already the authoritative durable event; waiting for the host's
 * processor fold or a redundant observer turns unrelated delivery pressure
 * into user-visible script latency.
 */
export async function commitForegroundScriptSettlement<T>(input: {
  commit: () => Promise<T>;
  /**
   * Ambiguous-failure recovery only. The Stream DO point-reads this exact
   * idempotency key before accepting an observer socket, so connecting after
   * all commit attempts cannot miss a committed event.
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

  let lastCommitError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let commitCall: Promise<T>;
    try {
      commitCall = input.commit();
    } catch (error) {
      commitCall = Promise.reject(error);
    }
    const outcome: SettlementCommitOutcome<T> = await Promise.resolve(commitCall).then(
      (value) => ({ status: "committed", value }) as const,
      (error: unknown) => {
        input.onCommitFailure?.({ attempt, error });
        return { status: "commit-failed", error } as const;
      },
    );
    if (outcome.status === "committed") return outcome.value;
    lastCommitError = outcome.error;
  }

  try {
    return await input.observe();
  } catch (observationError) {
    const commitDetail =
      lastCommitError instanceof Error ? lastCommitError.message : String(lastCommitError);
    const observationDetail =
      observationError instanceof Error ? observationError.message : String(observationError);
    throw new Error(
      `Script settlement commit failed after ${maxAttempts} bounded idempotent attempts (${commitDetail}), and its exact durable outcome could not be observed: ${observationDetail}`,
      { cause: observationError },
    );
  }
}
