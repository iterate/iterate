/**
 * Ride out Cloudflare API rate limiting (HTTP 429).
 *
 * Cloudflare's global API limit is 1200 requests / 5 minutes per user
 * (https://developers.cloudflare.com/fundamentals/api/reference/limits/), so
 * a rate-limited window can last MINUTES — a quick exponential backoff that
 * gives up after ~30s total never rides one out. On 2026-07-14 the shared
 * dev/preview account hit exactly this: every `preview deploy` app failed in
 * ~2s with a 429 (deploy prepare hooks → ctx.cf), and `preview cleanup`'s
 * erase-data D1 query 429'd, failing cleanup and leaking the merged PR's
 * slot lease for 24h, which starved the 9-slot preview fleet.
 *
 * Policy: up to 5 attempts. Between attempts, honor the server's Retry-After
 * header when present (capped so a pathological value can't wedge the job),
 * otherwise wait 5s → 15s → 30s → 60s — ~110s worst case per call, a real
 * chance of outliving a short burst without threatening a CI job's 30-minute
 * ceiling. ONLY status 429 retries; every other status (and any thrown fetch
 * error) surfaces to the caller immediately. This mirrors the shape of
 * withGithubRetry in scripts/preview/preview.ts, but works at the Response
 * level so it can read Retry-After.
 *
 * This is infrastructure-API resilience, not a test retry layer — the
 * e2e-policy "one retry layer" rule (docs/testing.md) governs retrying
 * TESTS and does not apply here.
 */

const DEFAULT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000] as const;
const DEFAULT_MAX_RETRY_AFTER_MS = 120_000;

export async function fetchCloudflareWith429Retry(
  /** Call description for the retry log lines, e.g. "GET /d1/database". */
  label: string,
  /** Performs one attempt. Called again (with identical inputs) per retry. */
  doFetch: () => Promise<Response>,
  opts: {
    /** Delays between attempts when there is no Retry-After (attempts = delays + 1). */
    backoffMs?: readonly number[];
    /** Cap applied to a server-sent Retry-After. */
    maxRetryAfterMs?: number;
    /**
     * Aborts the backoff wait as well as being the caller's fetch signal —
     * without it, a cancelled caller would silently keep waiting (and
     * re-fetching) for up to the full backoff schedule.
     */
    signal?: AbortSignal;
    /** Injectable for tests. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<Response> {
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const sleep = opts.sleep ?? abortableSleep;

  let response = await doFetch();
  for (const [index, fallbackMs] of backoffMs.entries()) {
    if (response.status !== 429) {
      return response;
    }
    const retryAfter = parseRetryAfterMs(response);
    const delayMs = Math.min(retryAfter ?? fallbackMs, maxRetryAfterMs);
    console.warn(
      `Cloudflare API rate limited (429) on ${label} (attempt ${index + 1}/${backoffMs.length + 1}); ` +
        `retrying in ${Math.round(delayMs / 1000)}s${retryAfter != null ? " (Retry-After)" : ""}...`,
    );
    // Drain the 429 body before waiting: an unread Response pins its
    // keep-alive connection in undici for as long as it is referenced, and
    // holding one across a 5-120s backoff (times every concurrent caller in
    // a rate-limited burst) starves the connection pool.
    await response.body?.cancel().catch(() => {});
    await sleep(delayMs, opts.signal);
    response = await doFetch();
  }
  // Still 429 after every attempt: hand the response back so the caller's
  // normal error path reports it (with the exhausted retries visible above).
  return response;
}

/** setTimeout that rejects with the signal's reason if aborted mid-wait. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry-After is either delta-seconds or an HTTP-date; both become a delay in ms. */
function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const untilMs = Date.parse(header) - Date.now();
  return Number.isFinite(untilMs) && untilMs > 0 ? untilMs : undefined;
}
