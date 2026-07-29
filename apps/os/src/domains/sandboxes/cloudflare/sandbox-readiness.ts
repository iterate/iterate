import { settleByDeadline } from "../../execution-deadline.ts";

/**
 * The named catalogue-command phase was 12.5s at p99 across 421 samples
 * within the 463 browser sandbox-exec runs reviewed on 2026-07-28. Thirty
 * seconds leaves more than twice that tail for one placement while refusing
 * the observed 150s+ silent provisioning wedge.
 */
export const SANDBOX_READINESS_ATTEMPT_TIMEOUT_MS = 30_000;
export const SANDBOX_READINESS_RECYCLE_TIMEOUT_MS = 15_000;
const SANDBOX_READINESS_MAX_ATTEMPTS = 2 as const;

type ReadinessAttemptContext = {
  attempt: number;
  attemptTimeoutMs: number;
  maxAttempts: typeof SANDBOX_READINESS_MAX_ATTEMPTS;
};

type RecycleDeadlineContext = {
  attempt: number;
  recycle: Promise<void>;
  recycleTimeoutMs: number;
};

/**
 * Bound a sandbox's infrastructure readiness independently from the user's
 * command timeout. A silent placement is destroyed before one fresh placement
 * is tried; an application/provisioning rejection remains immediately
 * terminal. The final timed-out placement is destroyed too, so exhaustion
 * never returns while a stuck container continues consuming a slot.
 */
export async function ensureSandboxReadiness(input: {
  attempt: (context: ReadinessAttemptContext) => Promise<void>;
  attemptTimeoutMs?: number;
  now?: () => number;
  onAttemptDeadline?: (context: ReadinessAttemptContext) => void;
  onRecycleDeadline?: (context: RecycleDeadlineContext) => void;
  recycle: (context: { attempt: number }) => Promise<void>;
  recycleTimeoutMs?: number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const attemptTimeoutMs = input.attemptTimeoutMs ?? SANDBOX_READINESS_ATTEMPT_TIMEOUT_MS;
  const recycleTimeoutMs = input.recycleTimeoutMs ?? SANDBOX_READINESS_RECYCLE_TIMEOUT_MS;

  for (const duration of [attemptTimeoutMs, recycleTimeoutMs]) {
    if (!Number.isFinite(duration) || duration <= 0 || duration > 2_147_483_647) {
      throw new Error(`Sandbox readiness bounds must be between 1 and 2147483647ms: ${duration}`);
    }
  }

  for (let attempt = 1; attempt <= SANDBOX_READINESS_MAX_ATTEMPTS; attempt += 1) {
    const context: ReadinessAttemptContext = {
      attempt,
      attemptTimeoutMs,
      maxAttempts: SANDBOX_READINESS_MAX_ATTEMPTS,
    };
    const readiness = Promise.resolve().then(() => input.attempt(context));
    const outcome = await settleByDeadline(readiness, now() + attemptTimeoutMs, now);
    if (outcome.status === "fulfilled") return;
    if (outcome.status === "rejected") throw outcome.error;

    input.onAttemptDeadline?.(context);
    const readinessTimeout = new Error(
      `Sandbox readiness attempt ${attempt}/${SANDBOX_READINESS_MAX_ATTEMPTS} did not settle within ${attemptTimeoutMs}ms`,
    );
    const recycle = Promise.resolve().then(() => input.recycle({ attempt }));
    const recycleOutcome = await settleByDeadline(recycle, now() + recycleTimeoutMs, now);
    if (recycleOutcome.status === "rejected") {
      throw new AggregateError(
        [readinessTimeout, recycleOutcome.error],
        `Sandbox readiness attempt ${attempt}/${SANDBOX_READINESS_MAX_ATTEMPTS} timed out and its container recycle failed`,
      );
    }
    if (recycleOutcome.status === "deadline") {
      input.onRecycleDeadline?.({ attempt, recycle, recycleTimeoutMs });
      throw new AggregateError(
        [
          readinessTimeout,
          new Error(`Sandbox container recycle did not settle within ${recycleTimeoutMs}ms`),
        ],
        `Sandbox readiness attempt ${attempt}/${SANDBOX_READINESS_MAX_ATTEMPTS} timed out and its container recycle did not settle within ${recycleTimeoutMs}ms`,
      );
    }
  }

  throw new Error(
    `Sandbox did not become ready across ${SANDBOX_READINESS_MAX_ATTEMPTS} container placements; ` +
      `each readiness attempt was bounded at ${attemptTimeoutMs}ms and each timed-out container was destroyed`,
  );
}
