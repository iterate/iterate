// platform-retry.ts — THE FAILURE MODEL, in one module: what kind of failure a call met
// (`failureKind`, `httpFailureKind`), and whether and when the call is made again
// (`retryPlatformFailures` on one of the named schedules, or a durable ladder's rung). The policy
// and the sources it rests on: docs/engineering-invariants.md#failures-and-retries.

/** The five kinds of failure (docs/engineering-invariants.md#failures-and-retries): an expected
 *  outcome, coded (`refused`); a deploy's reset of a Durable Object or of D1 (`deploy-reset`);
 *  capnp's DISCONNECTED, "re-establish connections and try again" (`disconnected`); capnp's
 *  OVERLOADED, "should NOT be repeated immediately as this may simply exacerbate the problem"
 *  (`overloaded`; both kj/exception.h); anything else, our own defects included (`failed`). The hop
 *  that first sees a failure decides its kind, and the kind rides on as code UNAVAILABLE's
 *  `data.kind`, which Workers RPC and capnweb both keep. */
export type FailureKind = "refused" | PlatformFailureKind | "failed";

/** A failure of the platform's own: the kinds code UNAVAILABLE carries. */
export type PlatformFailureKind = "deploy-reset" | "disconnected" | "overloaded";

/** How long a caller waits before asking again after each platform failure: the `retryAfterMs` of
 *  code UNAVAILABLE and an edge answer's `Retry-After`. A deploy's reset and a lost connection are
 *  over by the time a person asks again. An overload is not: 10 s lets a burst drain before its
 *  callers come back ("scheduling to retry the operation much later", capnp rpc.capnp). */
export const RETRY_AFTER_MS: Record<PlatformFailureKind, number> = {
  "deploy-reset": 1_000,
  disconnected: 1_000,
  overloaded: 10_000,
};

/** A failure's kind, read off what workerd and our own code stamp on it, then off the messages
 *  Cloudflare documents for failures that arrive without the stamp. */
export function failureKind(error: unknown): FailureKind {
  if (!(error instanceof Object)) return "failed";
  // The own properties a hop stamps: iterate/lib's `code` and `data`, and workerd's flags
  // (jsg/util.c++ `addAdditionalInfo`: DISCONNECTED → `retryable`, OVERLOADED → `overloaded`).
  // Asserted, not parsed: each is only compared, so an error without them reads as unstamped.
  const stamped = error as {
    code?: unknown;
    data?: { kind?: unknown };
    retryable?: unknown;
    overloaded?: unknown;
  };
  if (stamped.code === "UNAVAILABLE")
    return isPlatformFailureKind(stamped.data?.kind) ? stamped.data.kind : "failed";
  if (typeof stamped.code === "string") return "refused";
  const text = messagesOf(error);
  if (/reset because its code was updated/.test(text)) return "deploy-reset";
  if (stamped.overloaded === true || OVERLOADED_MESSAGE.test(text)) return "overloaded";
  if (stamped.retryable === true || DISCONNECTED_MESSAGE.test(text)) return "disconnected";
  return "failed";
}

/** The messages of a failure whose flags do not reach the caller, read as Cloudflare's own retry
 *  example reads them (https://developers.cloudflare.com/d1/best-practices/retry-queries/): D1's
 *  binding builds its error from the database's answer
 *  (https://developers.cloudflare.com/d1/observability/debug-d1/#error-list), and a storage reset
 *  is stamped by the type the storage failed with, which may be FAILED (workerd io/actor-cache.c++:
 *  "Pass through exception type"). A storage timeout is OVERLOADED (workerd io/worker.c++
 *  `makeTimeoutPromise`). A call on a Durable Object instance Cloudflare shut down, to host the
 *  object elsewhere or to update its runtime, fails with "this Durable Object instance is no longer
 *  active. Reconnect or retry the request." once it touches storage, and the next call reaches the
 *  instance that replaced it
 *  (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#shutdown-behavior). */
const OVERLOADED_MESSAGE =
  /is overloaded|exceeded timeout which caused object to be reset|exceeded its (memory|CPU time) limit and was reset/;
const DISCONNECTED_MESSAGE =
  /Network connection lost|storage\b.*\bcaused object to be reset|this Durable Object instance is no longer active|Replica disconnected|transient issue on remote node|client disconnected/;

/** A failure's message and those of the causes it wraps, one per line: sqlfu wraps a D1 error, whose
 *  cause is the binding's own. */
function messagesOf(error: unknown): string {
  const messages: string[] = [];
  for (let cause = error, depth = 0; cause instanceof Error && depth < 3; depth++) {
    messages.push(cause.message);
    cause = cause.cause;
  }
  return messages.join("\n");
}

/** Whether `error`, or a cause it wraps, is workerd's opaque "internal error; reference = …"
 *  (jsg/util.c++ `renderInternalError`): a failure hidden from JavaScript, whether the runtime's own
 *  or a defect of the code it ran (a facet whose class is not exported fails the same way), so
 *  `failureKind` reads it as `failed`. Only a caller whose callee runs no code of ours or a
 *  project's can read it as the runtime's own (control-plane/edge.ts, over D1). */
export const isOpaqueInternalError = (error: unknown): boolean =>
  /(^|: )internal error; reference = /m.test(messagesOf(error));

export const isPlatformFailureKind = (kind: unknown): kind is PlatformFailureKind =>
  kind === "deploy-reset" || kind === "disconnected" || kind === "overloaded";

/** An HTTP answer that is not a success: its status is what `httpFailureKind` reads, and its
 *  `Retry-After` how long the far side asked to be left alone, which `retryPlatformFailures`
 *  honors. */
export class HttpAnswerError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  constructor(message: string, answer: Pick<Response, "status" | "headers">) {
    super(message);
    this.status = answer.status;
    this.retryAfterMs = retryAfterMs(answer.headers.get("retry-after"));
  }
}

/** A `Retry-After` in ms: delay-seconds, or an HTTP-date (RFC 9110 §10.2.3). */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const untilMs = Date.parse(header) - Date.now();
  return Number.isFinite(untilMs) ? Math.max(untilMs, 0) : undefined;
}

/** A failed HTTP call's kind: a 429 or 408 is the far side asking for a slower pace (overloaded), a
 *  5xx or a connection that failed before any answer (`fetch` rejects with a TypeError) is the far
 *  side's failure (disconnected), any other status an answer about the request (refused). Anything
 *  else is read as `failureKind` reads it: a timeout or an abort of the caller's own is `failed`. */
export function httpFailureKind(answer: unknown): FailureKind {
  const status =
    answer instanceof Response || answer instanceof HttpAnswerError ? answer.status : undefined;
  if (status === 429 || status === 408) return "overloaded";
  if (status !== undefined) return status >= 500 ? "disconnected" : "refused";
  if (answer instanceof TypeError) return "disconnected";
  return failureKind(answer);
}

/**
 * Whether an answer is CLOUDFLARE'S OWN NOT-FOUND FOR A workers.dev HOSTNAME THE SERVER DOES NOT
 * ROUTE YET: a failure of kind `disconnected`, since the request never reached a Worker, which makes
 * it safe to send again whatever its method. A brand-new Worker's hostname reaches Cloudflare's
 * servers one by one, and a connection that lands on one that has not learned it yet gets one of
 * three answers only Cloudflare gives. The first is a 404 with `x-preview-user-error: true`, the
 * "There is nothing here yet" page, when the hostname also reads as `<alias>-<worker>`, a preview URL
 * of an existing Worker with preview URLs on (every per-commit deployment's does:
 * `<prefix>-<sha7>-os` of `os`). The others are a 404 whose body is `error code: 1042` and a 500 whose
 * body is `error code: 1104`. The page decides by its header, so `body` is read only for a small
 * plain answer; a Worker's own 404 or 500 is never one of these.
 */
export function isNotRoutedYet(answer: {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}): boolean {
  if (answer.status === 404 && answer.headers["x-preview-user-error"] === "true") return true;
  const code = answer.body?.trim();
  return (
    (answer.status === 404 && code === "error code: 1042") ||
    (answer.status === 500 && code === "error code: 1104")
  );
}

/** What a script's log line says about a failed HTTP call: its status (`network` when no answer
 *  came) and its message. */
export function httpFailureFields(error: unknown) {
  return {
    status: error instanceof HttpAnswerError ? error.status : "network",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * When a call the platform failed is made again: the wait before each repeat, and whether an
 * overloaded failure is repeated too. Each wait is jittered down to between half and all of itself
 * ("equal jitter", https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/), so a
 * burst's repeats spread out. A `Retry-After` longer than a wait replaces it, up to the schedule's
 * longest wait, so no wait runs past that.
 */
export type Schedule = { delaysMs: readonly number[]; repeatsOverload: boolean };

/** One repeat, now: capnp's answer to DISCONNECTED, "disconnect and start over" (rpc.capnp): on a
 *  fresh Durable Object stub, since "many exceptions leave the DurableObjectStub in a broken state"
 *  (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/). A second
 *  failure is capnp's OVERLOADED, and the caller's. */
export const ONCE_NOW: Schedule = { delaysMs: [0], repeatsOverload: false };
/** One repeat a second later: an upstream service's passing internal error (Artifacts' 10400,
 *  Browser Run's 6002 on inline HTML, a git remote's 5xx), fine a moment later. */
export const UPSTREAM_ONCE: Schedule = { delaysMs: [1_000], repeatsOverload: false };
/** A relay's lend, whose connection to the Durable Object a burst of lends can drop: once now, then
 *  twice more within the four seconds the object's 10 s page timeout leaves room for. */
export const RELAY_BURST: Schedule = { delaysMs: [0, 1_000, 3_000], repeatsOverload: false };
/** A CI script's call on another service's API: about 17 s in all. A 429 is repeated too: the
 *  script is the caller waiting it out. */
export const CI_HTTP: Schedule = { delaysMs: [2_000, 5_000, 10_000], repeatsOverload: true };
/** A deploy's or a preview's call on Cloudflare's API, a wrangler command's included: two to four
 *  minutes in all. The API allows 1,200 requests per five minutes per user
 *  (https://developers.cloudflare.com/fundamentals/api/reference/limits/), which parallel preview
 *  deploys share, so a rate-limited window lasts minutes: Cloudflare has answered
 *  `Retry-After: 120`. The last wait is that long, so a direct call waits out the whole window it
 *  was asked to, and a wrangler command, which cannot see the header, runs a last time after it. */
export const CLOUDFLARE_API: Schedule = {
  delaysMs: [5_000, 15_000, 30_000, 75_000, 120_000],
  repeatsOverload: true,
};

/** THE DURABLE LADDER's wait before attempt `attempt` (1-based) of a delivery that failed: 1 s·2ⁿ,
 *  capped at `capMs` (30 minutes, unless a longer ladder names its own), ±20% jitter. Durable: the
 *  rung is written down and an alarm fires it, so an overloaded failure is repeated here and never
 *  in the call. */
export const durableLadderDelayMs = (attempt: number, capMs = 30 * 60_000) =>
  Math.round(Math.min(1_000 * 2 ** (attempt - 1), capMs) * (0.8 + Math.random() * 0.4));

/**
 * `attempt`, made again after each of the schedule's waits while it fails with a platform failure
 * and running it twice is running it once (`idempotent`). An overloaded failure is repeated only by
 * a schedule that `repeatsOverload`; every other kind (a refusal, our own defect) is thrown at once.
 * `idempotent` may read the failure: a request the far side refused unrun is safe to send again.
 * Recovery is bounded: the last failure is thrown, and once the caller's `signal` aborts no repeat
 * starts and no wait runs on.
 *
 * Each repeat logs one line, and so does giving up on an idempotent call the platform still fails
 * (`logPlatformFailure`): `<area>.deploy-reset-retry` at info, `<area>.platform-failure-retry` at
 * warn, then `<area>.…-gave-up`. `describe` says what else a line carries: the call's `name`, which
 * the prd fault alarm groups by, and what it named.
 */
export async function retryPlatformFailures<T>(
  attempt: () => Promise<T>,
  options: {
    area: string;
    schedule: Schedule;
    idempotent: boolean | ((error: unknown) => boolean);
    kind: (error: unknown) => FailureKind;
    describe: (error: unknown) => Record<string, unknown>;
    signal?: AbortSignal;
  },
): Promise<T> {
  const { schedule, signal } = options;
  for (let attempts = 1; ; attempts++) {
    try {
      return await attempt();
    } catch (error) {
      const kind = options.kind(error);
      const idempotent =
        typeof options.idempotent === "function" ? options.idempotent(error) : options.idempotent;
      if (!idempotent || !isPlatformFailureKind(kind)) throw error;
      const fields = { message: String(error), ...options.describe(error) };
      const delayMs = schedule.delaysMs[attempts - 1];
      const repeats =
        delayMs !== undefined &&
        (kind !== "overloaded" || schedule.repeatsOverload) &&
        !signal?.aborted;
      if (repeats) {
        const askedMs = error instanceof HttpAnswerError ? (error.retryAfterMs ?? 0) : 0;
        const retryInMs = Math.max(
          jitteredMs(delayMs),
          Math.min(askedMs, Math.max(...schedule.delaysMs)),
        );
        logPlatformFailure(options.area, "retry", kind, {
          ...fields,
          attempt: attempts,
          retryInMs,
        });
        await pause(retryInMs, signal);
        if (!signal?.aborted) continue;
      }
      logPlatformFailure(options.area, "gave-up", kind, { ...fields, attempts });
      throw error;
    }
  }
}

/** A schedule's wait, jittered down to between half and all of itself (`Schedule`). */
export const jitteredMs = (delayMs: number) =>
  Math.round(delayMs / 2 + (Math.random() * delayMs) / 2);

/** `ms` of waiting, cut short when `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * A script's HTTP request on another service's API, sent again as `retryPlatformFailures` makes a
 * call again, on `schedule` (CI_HTTP unless named): the first answer that is not the far side's
 * failure (a success, or an answer about the request, which is the caller's). A 5xx, a 429 or 408,
 * a connection that failed and an attempt that got no answer within `timeoutMs` (our own deadline,
 * an overload) are the far side's; the last of them is thrown, an answer's as an HttpAnswerError
 * that quotes it. Anything else `send` throws is our own, thrown at once. Only an `idempotent`
 * request is sent again, except after a 429, which the far side refused unrun (RFC 6585 §4). Each
 * retry is a `<area>.platform-failure-retry` warn naming the request (`what`). The caller's
 * `signal` aborts the attempt in flight and ends the schedule.
 */
export async function fetchRetryingPlatformFailures(
  what: string,
  send: (signal: AbortSignal) => Promise<Response>,
  options: {
    area: string;
    idempotent: boolean;
    schedule?: Schedule;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const { signal, timeoutMs = 30_000 } = options;
  return retryPlatformFailures(
    async () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await send(signal ? AbortSignal.any([signal, timeout]) : timeout).catch(
        (error: unknown) => {
          if (signal?.aborted) throw error;
          // Stamped as workerd stamps its own timeouts (capnp's OVERLOADED, kj/exception.h), so
          // failureKind reads an overload.
          if (timeout.aborted)
            throw Object.assign(new Error(`${what}: no answer within ${timeoutMs / 1_000} s`), {
              overloaded: true,
            });
          // A failed connection is undici's "fetch failed", which says why only in its cause: named
          // for its request as a failed answer is, and stamped as workerd stamps a lost connection
          // (capnp's DISCONNECTED), so failureKind reads it. Any other throw, a TypeError of our
          // own included (a bad URL or header), is the caller's defect, thrown as it came.
          if (!(error instanceof TypeError && error.message === "fetch failed")) throw error;
          const why = error.cause instanceof Error ? `: ${error.cause.message}` : "";
          throw Object.assign(new Error(`${what}: fetch failed${why}`), { retryable: true });
        },
      );
      if (!isPlatformFailureKind(httpFailureKind(response))) return response;
      // Read to the end, so no unread answer holds its connection through the wait.
      const text = await response.text().catch(() => "");
      throw new HttpAnswerError(
        `${what} answered HTTP ${response.status}: ${text.slice(0, 500)}`,
        response,
      );
    },
    {
      area: options.area,
      schedule: options.schedule || CI_HTTP,
      idempotent: (error) =>
        options.idempotent || (error instanceof HttpAnswerError && error.status === 429),
      // An answer is read by its status; anything else the attempt threw by its stamp, and an
      // unstamped throw is our own.
      kind: (error) =>
        error instanceof HttpAnswerError ? httpFailureKind(error) : failureKind(error),
      describe: (error) => ({ request: what, ...httpFailureFields(error) }),
      signal,
    },
  );
}

/** One line about a platform failure, named `<area>.<outcome>` by the one rule: a deploy's reset
 *  is expected, `<area>.deploy-reset-<action>` at info; any other is the platform's failure,
 *  `<area>.platform-failure-<action>` at warn, which the prd fault alarm counts
 *  (scripts/ci/prd-fault-alarm.ts). */
export function logPlatformFailure(
  area: string,
  action: string,
  kind: PlatformFailureKind,
  fields: Record<string, unknown>,
): void {
  if (kind === "deploy-reset")
    console.info({ event: `${area}.deploy-reset-${action}`, kind, ...fields });
  else console.warn({ event: `${area}.platform-failure-${action}`, kind, ...fields });
}
