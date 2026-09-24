/** How long a CI script waits before each repeat of a call the platform failed: about 17 s in all. */
export const PLATFORM_FAILURE_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

/**
 * `attempt`, asked again after each of `delaysMs` while what it threw is the platform's own failure
 * (a 5xx, a dropped connection, a Durable Object reset), then the last failure is thrown, so recovery
 * is bounded and a lasting outage still fails the call. `platformFailure` returns what to log for
 * such a failure, or undefined for an answer about the request (a 4xx, an abort), which is thrown at
 * once. Each repeat logs an `event` warn (`<area>.platform-failure-retry`) with the attempt and the
 * wait.
 *
 * The caller decides whether a repeat is safe: a call that could create a second copy passes no
 * delays. CI scripts' GitHub and Depot calls (scripts/ci/github.ts, depot.ts), an itx call into a
 * context (apps/os/src/iterate-context.ts) and the repo facet's git reads (git-wire.ts) ask again
 * through this.
 */
export async function retryPlatformFailures<T>(
  attempt: () => Promise<T>,
  options: {
    event: string;
    delaysMs: readonly number[];
    platformFailure: (error: unknown) => object | undefined;
  },
): Promise<T> {
  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      return await attempt();
    } catch (error) {
      const delayMs = options.delaysMs[attemptNumber - 1];
      const failure = delayMs === undefined ? undefined : options.platformFailure(error);
      if (!failure) throw error;
      console.warn({
        event: options.event,
        ...failure,
        attempt: attemptNumber,
        retryInMs: delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
