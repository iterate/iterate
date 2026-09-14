/**
 * Run an operation up to `attempts` times, sleeping `delayMs(attempt)` between
 * tries, retrying only errors `shouldRetry` accepts. The last error is the
 * one thrown. Clock injected so the rule is table-testable.
 */
export async function withRetries<T>(
  run: () => Promise<T>,
  options: {
    attempts: number;
    delayMs: (attempt: number) => number;
    shouldRetry?: (error: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await run();
    } catch (error) {
      if (attempt >= options.attempts || (options.shouldRetry?.(error) ?? true) === false) {
        throw error;
      }
      await sleep(options.delayMs(attempt));
    }
  }
}
