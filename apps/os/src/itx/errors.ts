// ItxError: the structured error the itx kernel throws, and the duck-typed
// helpers every consumer (browser, Node e2e, caps) uses to read it back.
// This module is transport-agnostic and dependency-free on purpose — the
// react client re-exports from here, kernel code imports it directly.

/**
 * The five itx error codes. Exactly five, deliberately:
 *
 * - `NOT_FOUND`    — the target does not exist *for you*. Existence masking:
 *                    at resolution boundaries (`itx.projects.get`, connect
 *                    paths) "missing" and "forbidden" both answer NOT_FOUND
 *                    with the same message, so a caller can never probe which
 *                    project ids/slugs exist by comparing error shapes.
 * - `FORBIDDEN`    — you may not do this, and saying so reveals nothing:
 *                    existence is already established or not secret (global
 *                    streams need admin, append-policy rejections,
 *                    create/remove projects on a named-access handle).
 * - `CONFLICT`     — the request is valid but collides with existing state
 *                    (duplicate slug, id already taken with another slug).
 * - `BAD_REQUEST`  — caller misuse that no retry or permission fixes (global
 *                    handle where a project handle is needed, malformed id).
 * - `INTERNAL`     — everything else. Any non-ItxError crossing the /api/itx
 *                    boundary is tagged INTERNAL by `tagOutboundItxError`.
 *
 * There is no UNAUTHORIZED: itx auth happens at connect time (Law 3), so an
 * authentication failure is a transport-level 401 on the HTTP/WebSocket
 * handshake — by the time a capnweb session exists and errors can flow over
 * it, the principal is already established.
 */
export const ITX_ERROR_CODES = [
  "NOT_FOUND",
  "FORBIDDEN",
  "CONFLICT",
  "BAD_REQUEST",
  "INTERNAL",
] as const;

export type ItxErrorCode = (typeof ITX_ERROR_CODES)[number];

const ITX_ERROR_CODE_SET: ReadonlySet<string> = new Set(ITX_ERROR_CODES);

/**
 * The error the itx kernel throws. Designed around how capnweb (0.8.0) moves
 * errors across the wire:
 *
 * - The serializer emits `["error", name, message, stack?, props?]` where
 *   `props` is the error's OWN ENUMERABLE properties (everything except
 *   name/message/stack). The receiver reconstructs a plain `Error` (builtin
 *   names like TypeError map to their classes; anything else — including
 *   "ItxError" — becomes `Error`) and copies the props back on, skipping
 *   `name` again. So `name` is DROPPED in transit (Workers RPC preserves it,
 *   capnweb does not), class identity is lost, and the only thing that
 *   reliably survives every boundary is the own enumerable props: `code` and
 *   `details`. Detection is therefore duck-typed on `code` alone via
 *   {@link getItxErrorCode} — NEVER `instanceof ItxError` and never `name`
 *   on the client.
 * - The stack is only transmitted when the session's `onSendError` hook
 *   returns a rewritten error; see {@link tagOutboundItxError}.
 *
 * Posture: no redaction. We trust our callers with messages, stacks, and
 * `details` (maximum debugging info, v1 decision). The one thing we DO hide
 * is existence at resolution boundaries — see the NOT_FOUND masking note on
 * {@link ITX_ERROR_CODES}.
 */
export class ItxError extends Error {
  override readonly name = "ItxError";
  declare readonly code: ItxErrorCode;
  declare readonly details?: Record<string, unknown>;

  constructor(input: { code: ItxErrorCode; message: string; details?: Record<string, unknown> }) {
    super(input.message);
    this.code = input.code;
    // Only attach when provided: own enumerable props are exactly what
    // capnweb serializes, so an undefined `details` would be wire noise.
    if (input.details !== undefined) {
      this.details = input.details;
    }
  }
}

/**
 * Duck-typed detection (works on both ends of any RPC boundary): an ItxError
 * is any object carrying one of the five codes. `name` is deliberately NOT
 * consulted — capnweb drops it in transit (see {@link ItxError}), so a name
 * check would reject every error that crossed a capnweb session. The closed
 * five-code set is what keeps this from false-positiving on other `code`-
 * bearing errors (Node's ECONNREFUSED etc). Returns the code, or undefined
 * for everything else — including socket/connection failures, which is what
 * makes "retry only when code-less or INTERNAL" predicates work.
 */
export function getItxErrorCode(error: unknown): ItxErrorCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown };
  if (typeof candidate.code !== "string" || !ITX_ERROR_CODE_SET.has(candidate.code)) {
    return undefined;
  }
  return candidate.code as ItxErrorCode;
}

/** True when retrying cannot help: authorization/existence failures. */
export function isItxAccessError(error: unknown): boolean {
  const code = getItxErrorCode(error);
  return code === "NOT_FOUND" || code === "FORBIDDEN";
}

/**
 * The `onSendError` hook for every server-side itx capnweb session: tag,
 * don't redact. Anything outbound that is not already an ItxError is
 * rewritten to `ItxError { code: "INTERNAL" }` with the original message and
 * stack preserved — so the client can always read a code, and nothing is
 * hidden ("we trust our callers").
 *
 * Returning an error from this hook (the original ItxError included) is also
 * what opts its stack into transmission: capnweb only serializes
 * `rewritten.stack`, never the stack of an unrewritten error.
 */
export function tagOutboundItxError(error: Error): Error {
  if (getItxErrorCode(error) !== undefined) return error;
  const tagged = new ItxError({ code: "INTERNAL", message: error.message });
  tagged.stack = error.stack;
  return tagged;
}
