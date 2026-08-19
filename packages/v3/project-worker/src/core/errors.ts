// core/errors.ts — THE machine-readable error channel, stolen from cloudflare-os
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
  | "NO_CAPABILITY_MATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "STREAM_PAUSED"
  | "STREAM_BREAKER_OPEN";

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
