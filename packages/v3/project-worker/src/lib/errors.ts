// lib/errors.ts — THE machine-readable error channel, stolen from cloudflare-os
// (workshop-shared/src/api.ts: plain Error + a `code` own-property via Object.assign, read with
// `"code" in error`). Why this shape and no other: capnweb coerces custom error NAMES to a
// builtin whitelist and drops subclass identity, but preserves ALL own enumerable properties
// across the wire (verified at runtime against @iterate-com/capnweb 0.10.0) — and with
// enhanced_error_serialization (our compat date) own props survive native Workers-RPC hops too.
// So: never classify by `name`, `instanceof`, or message regex across a hop; check the code.
// Human messages stay verbatim and greppable — the code rides beside them, never instead.
// workerd's own stamped flags (`.retryable`, `.overloaded`, `.durableObjectReset`) ride the same
// own-property channel; honor them rather than inventing a retry taxonomy.

/** The stable machine-readable codes — SCREAMING_SNAKE, defined once, both ends import this. */
type ErrorCode =
  | "NO_ITX_EXPRESSION_MATCH" // no rewrite rule matches the call (default-deny)
  | "IDEMPOTENCY_CONFLICT"
  | "OFFSET_CONFLICT" // an input's expected `offset` is not the offset it would land at
  | "EVENT_TOO_LARGE" // one event's serialized body is over the append ceiling (stream.ts EVENT_BODY_MAX_CHARS)
  | "REDUCE_CHECKPOINT_TOO_LARGE" // a reduce's state would not fit one storage cell (reduce-checkpoint.ts)
  | "STREAM_PAUSED"
  | "RPC_STUB_OFFLINE" // the rpc stub a row names is neither borrowed nor pager-backed right now
  | "NOT_A_METHOD" // the dotted path's terminal segment is not callable on the target
  | "NO_FACET" // no facet of that name has been loaded into this context
  | "WAIT_TIMEOUT" // waitForEvent expired with no matching event committed
  | "TIMEOUT"; // lib/timeout.ts: the call did not answer within its deadline
// (There is no separate boundary-validation library: the append door's own runtime guards
// throw plain Errors; a client is JUST capnweb, so malformed args surface as ordinary errors.)

/** A plain Error carrying `code` (+ optional `data`) as own enumerable properties. */
export function codedError(code: ErrorCode, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), data === undefined ? { code } : { code, data });
}

/** The code of an error that crossed any number of hops — undefined for uncoded errors. */
export function errorCode(error: unknown): ErrorCode | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? ((error as { code: unknown }).code as ErrorCode)
    : undefined;
}

// reportIssue — the ONE exit for unexpected failures (cloudflare-os error-reporting.ts, minus
// its private Reporter Worker): one bounded console.error line; query event="issue" in Workers
// Logs. The Reporter seam stayed out on purpose — when one exists, check an optional env
// binding HERE and waitUntil the dispatch; capture sites never change. Deliberately NO
// cloudflare:workers import: this file rides the platform-neutral SDK bundle. Reporting must
// never disturb the caller — armored end to end; worst case it prints nothing.

// Bounds verbatim from cloudflare-os: hostile strings get clipped, never explode a log line.
const MAX = { message: 1024, stack: 16_384, string: 256, attributeKeys: 32 } as const;
type Scalar = string | number | boolean | null; // attribute values stay queryable scalars

/** Print ONE bounded console.error line for an unexpected failure; never throws. */
export function reportIssue(
  failureSite: string,
  caught: unknown,
  attributes?: Record<string, Scalar | undefined>,
): void {
  try {
    const bounded: Record<string, Scalar> = {};
    for (const [key, value] of Object.entries(attributes ?? {}).slice(0, MAX.attributeKeys)) {
      if (value === undefined) continue;
      bounded[key.slice(0, MAX.string)] =
        typeof value === "string" ? value.slice(0, MAX.string) : value;
    }
    const code = errorCode(caught);
    // The thrown value, bounded — name/message/stack read off an Error; an arbitrary object is
    // never walked.
    const error =
      caught instanceof Error
        ? {
            type: (caught.name || "Error").slice(0, MAX.string),
            message: caught.message.slice(0, MAX.message),
            ...(caught.stack && { stack: caught.stack.slice(0, MAX.stack) }),
          }
        : typeof caught === "object" && caught !== null
          ? { type: "ObjectThrown" }
          : { type: `${typeof caught}Thrown`, message: String(caught).slice(0, MAX.message) };
    console.error({
      ...bounded, // fixed keys spread last so an attribute can never shadow them
      event: "issue",
      failureSite: failureSite.slice(0, MAX.string),
      ...(code === undefined ? {} : { code }),
      error,
    });
  } catch {
    // Reporting must never disturb the caller — swallow and move on.
  }
}
