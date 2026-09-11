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
  | "INVALID_CONTEXT"
  | "PROVENANCE_INVALID"
  | "PROVENANCE_REQUIRED"
  | "REPO_EPHEMERAL"
  | "REPO_UNVERIFIED"
  | "REPO_REVISION"
  | "REPO_HEAD_CONFLICT"
  | "REPO_NOT_FOUND"
  | "REPO_REVISION_NOT_FOUND"
  | "REPO_PATH"
  | "REPO_FILES"
  | "REPO_FILE_PATH"
  | "REPO_FILE"
  | "NO_ITX_EXPRESSION_MATCH" // no rewrite rule matches the call (default-deny)
  | "IDEMPOTENCY_CONFLICT"
  | "OFFSET_CONFLICT" // an input's expected `offset` is not the offset it would land at
  | "EVENT_TOO_LARGE" // one event's serialized body is over the append ceiling (stream.ts EVENT_BODY_MAX_CHARS)
  | "EVENT_TOO_COMPLEX" // a value's native deserialized shape exceeds the isolate admission budget
  | "EVENT_VALUE_UNSUPPORTED" // a native value kind cannot be safely budgeted at the append door
  | "APPEND_REPLY_TOO_LARGE" // receipts would exceed the native Workers RPC reply admission budget
  | "FACET_STARTUP_MEMO_TOO_LARGE" // a hosted facet's restart memo would exceed one 2 MB storage cell
  | "STREAM_RESOURCE_HALTED" // a legacy stored row exceeds safe decoded-shape admission
  | "REDUCE_CHECKPOINT_TOO_LARGE" // a reduce's state would not fit one storage cell (reduce-checkpoint.ts)
  | "EVENT_UNREADABLE" // a stored row's body is not JSON — `data.offset` names it (stream.ts read)
  | "STREAM_PAUSED"
  | "SUBSCRIPTION_RESERVED" // a raw control event names the always-on core reduce
  | "RPC_STUB_OFFLINE" // the rpc stub a row names is neither borrowed nor pager-backed right now
  | "NOT_A_METHOD" // the dotted path's terminal segment is not callable on the target
  | "NO_FACET" // no facet of that name has been loaded into this context
  | "WAIT_TIMEOUT" // waitForEvent expired with no matching event committed
  | "SECRET_INPUT"
  | "SECRET_CONFLICT"
  | "SECRET_ORIGIN"
  | "SECRET_REFERENCE"
  | "SECRET_CHANGED"
  | "EGRESS_KEY"
  | "EGRESS_BODY"
  | "EGRESS_URL"
  | "POLICY_INPUT"
  | "POLICY_CHANGED"
  | "APPROVAL_INPUT"
  | "APPROVAL_SIGNER"
  | "APPROVAL_REQUEST"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_USED"
  | "APPROVAL_DECIDED"
  | "APPROVAL_RACE"
  | "APPROVAL_MISMATCH"
  | "APPROVAL_DENIED"
  | "PROJECT_FETCH_NOT_CONFIGURED"
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

/** Expected outcomes of the added repository, provenance and egress doors. Unknown failures stay
 * on the existing 500 path; these refusals expose a stable code, never a secret-bearing stack. */
export function policyErrorResponse(error: unknown): Response | undefined {
  const code = errorCode(error);
  if (!code) return;
  const statuses: Partial<Record<ErrorCode, number>> = {
    INVALID_CONTEXT: 400,
    SECRET_INPUT: 400,
    SECRET_REFERENCE: 400,
    POLICY_INPUT: 400,
    APPROVAL_INPUT: 400,
    EGRESS_URL: 400,
    SECRET_ORIGIN: 403,
    APPROVAL_DENIED: 403,
    APPROVAL_SIGNER: 403,
    PROVENANCE_REQUIRED: 403,
    SECRET_CHANGED: 409,
    POLICY_CHANGED: 409,
    SECRET_CONFLICT: 409,
    APPROVAL_MISMATCH: 409,
    APPROVAL_USED: 409,
    APPROVAL_EXPIRED: 409,
    APPROVAL_DECIDED: 409,
    APPROVAL_RACE: 409,
    APPROVAL_REQUEST: 404,
    PROJECT_FETCH_NOT_CONFIGURED: 404,
    EGRESS_BODY: 413,
    EGRESS_KEY: 503,
    PROVENANCE_INVALID: 400,
  };
  const status = statuses[code];
  return status ? Response.json({ code }, { status }) : undefined;
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

/** The platform's normal interruption contract: a reset can be retried by an idempotent caller,
 * but never when the object is overloaded. Message text and partial flag sets are not a contract. */
export function isRetryableDurableObjectReset(error: unknown): boolean {
  return durableObjectRuntimeFlags(error) !== undefined;
}

type DurableObjectRuntimeFlags = {
  retryable: true;
  durableObjectReset: true;
  overloaded: false | undefined;
};

function durableObjectRuntimeFlags(error: unknown): DurableObjectRuntimeFlags | undefined {
  if (typeof error !== "object" || error === null) return;
  try {
    // `error` is only known to be object-shaped above. Read the three platform-owned fields once:
    // a getter may be hostile or time-varying, and nothing it returns reaches a log until this
    // canonical schema accepts it.
    const flags = error as {
      retryable?: unknown;
      durableObjectReset?: unknown;
      overloaded?: unknown;
    };
    const retryable = flags.retryable;
    const durableObjectReset = flags.durableObjectReset;
    const overloaded = flags.overloaded;
    if (retryable !== true || durableObjectReset !== true) return;
    if (overloaded !== undefined && overloaded !== false) return;
    return { retryable, durableObjectReset, overloaded };
  } catch {
    return;
  }
}

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
    const runtimeFlags = durableObjectRuntimeFlags(caught);
    if (runtimeFlags) {
      console.info({
        ...bounded,
        event: "expected_platform_interruption",
        outcome: "interrupted",
        failureSite: failureSite.slice(0, MAX.string),
        ...(code === undefined ? {} : { code }),
        ...runtimeFlags,
        error,
      });
      return;
    }
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
