// platform-retry.ts — THE FAILURE MODEL, in one module: what kind of failure a call met
// (`failureKind`, `httpFailureKind`), and whether and when the call is made again
// (`retryPlatformFailures` on one of the named schedules, or a durable ladder's rung). The policy
// and the sources it rests on: docs/engineering-invariants.md#failures-and-retries.

/**
 * The five kinds of failure. The hop that first sees a failure decides its kind, and the kind rides
 * on as own properties (code UNAVAILABLE and its `data.kind`), which Workers RPC and capnweb both
 * keep.
 *
 * - `refused`: an expected outcome, coded (iterate/lib's `ErrorCode`). Never repeated.
 * - `deploy-reset`: a deploy reset the Durable Object (or D1) for its new code. Expected on every
 *   deploy under traffic; a fresh instance answers at once.
 * - `disconnected`: capnp's DISCONNECTED, which workerd stamps `retryable: true` (the connection
 *   under the call was lost, the object reset by its storage). "Re-establish connections and try
 *   again" (capnp kj/exception.h).
 * - `overloaded`: capnp's OVERLOADED, which workerd stamps `overloaded: true` (a storage operation
 *   past its 30 s timeout, an isolate past its memory limit), D1's overload, an HTTP 429 or 408,
 *   our own deadline. "It should NOT be repeated immediately as this may simply exacerbate the
 *   problem" (capnp kj/exception.h). Also workerd's opaque "internal error; reference = …", the
 *   runtime's own failure it hides from JavaScript (jsg/util.c++ `renderInternalError`): in a
 *   Cloudflare outage every call fails with it for minutes (188 s on 2026-09-24), so it is the
 *   platform's, never repeated at once, and answered 503.
 * - `failed`: anything else, our own defects included. capnp's FAILED would fail again unchanged.
 */
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
  const messages: string[] = [];
  // sqlfu wraps a D1 error, whose cause is the binding's own.
  for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 3; depth++) {
    messages.push(cause.message);
    cause = cause.cause;
  }
  const text = messages.join("\n");
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
 *  `makeTimeoutPromise`). */
const OVERLOADED_MESSAGE =
  /is overloaded|exceeded timeout which caused object to be reset|exceeded its (memory|CPU time) limit and was reset|(^|: )internal error; reference = /m;
const DISCONNECTED_MESSAGE =
  /Network connection lost|storage\b.*\bcaused object to be reset|Replica disconnected|transient issue on remote node|client disconnected/;

export const isPlatformFailureKind = (kind: unknown): kind is PlatformFailureKind =>
  kind === "deploy-reset" || kind === "disconnected" || kind === "overloaded";

/** An HTTP answer that is not a success: its status is what `httpFailureKind` reads. */
export class HttpAnswerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
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
 * burst's repeats spread out and the schedule's total stays its bound.
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

/** THE DURABLE LADDER's wait before attempt `attempt` (1-based) of a delivery that failed: 1 s·2ⁿ,
 *  capped at 30 minutes, ±20% jitter. Durable: the rung is written down and an alarm fires it, so an
 *  overloaded failure is repeated here and never in the call. */
export const durableLadderDelayMs = (attempt: number) =>
  Math.round(Math.min(1_000 * 2 ** (attempt - 1), 30 * 60_000) * (0.8 + Math.random() * 0.4));

/**
 * `attempt`, made again after each of the schedule's waits while it fails with a platform failure
 * and running it twice is running it once (`idempotent`). An overloaded failure is repeated only by
 * a schedule that `repeatsOverload`; every other kind (a refusal, our own defect) is thrown at once.
 * Recovery is bounded: the last failure is thrown.
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
    idempotent: boolean;
    kind: (error: unknown) => FailureKind;
    describe: (error: unknown) => Record<string, unknown>;
  },
): Promise<T> {
  for (let attempts = 1; ; attempts++) {
    try {
      return await attempt();
    } catch (error) {
      const kind = options.kind(error);
      if (!options.idempotent || !isPlatformFailureKind(kind)) throw error;
      const delayMs = options.schedule.delaysMs[attempts - 1];
      const fields = { message: String(error), ...options.describe(error) };
      if (delayMs === undefined || (kind === "overloaded" && !options.schedule.repeatsOverload)) {
        logPlatformFailure(options.area, "gave-up", kind, { ...fields, attempts });
        throw error;
      }
      const retryInMs = Math.round(delayMs / 2 + (Math.random() * delayMs) / 2);
      logPlatformFailure(options.area, "retry", kind, { ...fields, attempt: attempts, retryInMs });
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
    }
  }
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
