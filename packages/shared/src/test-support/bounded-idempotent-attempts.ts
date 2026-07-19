export class BoundedIdempotentAttemptsDeadlineError extends Error {
  override readonly name = "BoundedIdempotentAttemptsDeadlineError";

  constructor(label: string, attemptTimeoutsMs: readonly number[]) {
    super(
      `${label} did not settle in ${attemptTimeoutsMs.length} bounded attempts ` +
        `(${attemptTimeoutsMs.join("ms, ")}ms).`,
    );
  }
}

type BoundedAttempt<T> = {
  /** Retire every resource owned by this attempt, including an in-flight transport. */
  dispose(): void;
  result: PromiseLike<T>;
};

/**
 * Retry an operation only when it remains completely unsettled for a bounded
 * interval. This is deliberately restricted to idempotent work: an attempt
 * may have committed remotely before its acknowledgement was lost. Explicit
 * rejections are never replayed, and each attempt is disposed before the next
 * one begins.
 */
export async function runBoundedIdempotentAttempts<T>(input: {
  attemptTimeoutsMs: readonly number[];
  label: string;
  onAttemptTimeout?: (event: {
    attempt: number;
    attempts: number;
    elapsedMs: number;
    timeoutMs: number;
  }) => void;
  startAttempt: (attempt: number) => BoundedAttempt<T>;
}): Promise<T> {
  const attemptTimeoutsMs = [...input.attemptTimeoutsMs];
  if (
    input.label.trim().length === 0 ||
    attemptTimeoutsMs.length === 0 ||
    attemptTimeoutsMs.some((timeoutMs) => !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new Error("Bounded idempotent attempts require a label and positive timeouts.");
  }

  const startedAt = Date.now();
  for (const [index, timeoutMs] of attemptTimeoutsMs.entries()) {
    const attempt = index + 1;
    const resource = input.startAttempt(attempt);
    const deadline = Symbol("bounded-idempotent-attempt-deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const result = await Promise.race([
        Promise.resolve(resource.result),
        new Promise<typeof deadline>((resolve) => {
          timer = setTimeout(() => resolve(deadline), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (result !== deadline) return result;
      timedOut = true;
    } finally {
      clearTimeout(timer);
      resource.dispose();
    }

    if (timedOut) {
      input.onAttemptTimeout?.({
        attempt,
        attempts: attemptTimeoutsMs.length,
        elapsedMs: Date.now() - startedAt,
        timeoutMs,
      });
    }
  }

  throw new BoundedIdempotentAttemptsDeadlineError(input.label, attemptTimeoutsMs);
}
