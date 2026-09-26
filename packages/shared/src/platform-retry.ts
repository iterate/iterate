/** How long a CI script waits before each repeat of a call the platform failed: about 17 s in all. */
export const PLATFORM_FAILURE_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

/**
 * `attempt`, asked again after each of `delaysMs` while what it threw is the platform's own failure
 * (a 5xx, a dropped connection, a Durable Object reset), then the last failure is thrown, so recovery
 * is bounded and a lasting outage still fails the call. `platformFailure` returns what to log for
 * such a failure, or undefined for an answer about the request (a 4xx, an abort), which is thrown at
 * once. Each repeat logs an `event` warn (`<area>.platform-failure-retry`) with the attempt and the
 * wait, or the `event` the failure names itself: a deploy's reset is expected, not the platform's
 * failure, so its repeat logs `<area>.deploy-reset-<action>`, which the prd fault alarm does not
 * count.
 *
 * The caller decides whether a repeat is safe: a call that could create a second copy passes no
 * delays.
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

/** An HTTP answer that is not a success: its status is what `httpPlatformFailure` reads. */
export class HttpAnswerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * `platformFailure` for a `fetch`: what to log, `label` first, when the connection failed (`fetch`
 * rejects with a TypeError) or the answer was an `HttpAnswerError` with a 5xx or a 429 (the platform
 * asking for a slower pace). Anything else is undefined and thrown at once: a 4xx is an answer about
 * the request, and a timeout or an abort is the caller's own.
 */
export function httpPlatformFailure(error: unknown, label: Record<string, string>) {
  if (error instanceof TypeError) return { ...label, status: "network", message: error.message };
  if (error instanceof HttpAnswerError && (error.status >= 500 || error.status === 429))
    return { ...label, status: error.status, message: error.message };
  return undefined;
}
