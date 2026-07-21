export type TuiCaseAttempt = {
  passed: boolean;
  failure?: string;
};

export type TuiCaseResult = {
  attemptsUsed: number;
  passed: boolean;
  firstFailure?: string;
  finalFailure?: string;
};

/**
 * Retry one TUI workflow at the wrapper boundary.
 *
 * The callback must create a fresh process and project for every attempt.
 * Microsoft TUI Test 0.0.4 terminates its per-file worker on timeout and then
 * reuses that dead worker for its built-in retry, so retries inside the test
 * framework are deliberately disabled.
 */
export async function runTuiCaseWithRetry(input: {
  maxAttempts: number;
  retryDelayMs: number;
  runAttempt: (attempt: number) => Promise<TuiCaseAttempt>;
  onRetry?: (input: { attempt: number; failure?: string }) => void;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<TuiCaseResult> {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer; got ${input.maxAttempts}.`);
  }

  const wait =
    input.wait ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let firstFailure: string | undefined;
  let finalFailure: string | undefined;

  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    const result = await input.runAttempt(attempt);
    if (result.passed) {
      return {
        attemptsUsed: attempt,
        passed: true,
        ...(firstFailure ? { firstFailure } : {}),
      };
    }

    firstFailure ??= result.failure;
    finalFailure = result.failure;
    if (attempt < input.maxAttempts) {
      input.onRetry?.({ attempt, failure: result.failure });
      await wait(input.retryDelayMs);
    }
  }

  return {
    attemptsUsed: input.maxAttempts,
    passed: false,
    ...(firstFailure ? { firstFailure } : {}),
    ...(finalFailure ? { finalFailure } : {}),
  };
}
