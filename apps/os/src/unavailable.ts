// unavailable.ts — THE PLATFORM'S OWN FAILURE AS APPS/OS ANSWERS IT: code UNAVAILABLE on every hop
// and across /api, and the one HTTP answer the edge gives it. The model and its sources:
// docs/engineering-invariants.md#failures-and-retries.
import { codedError, errorCode } from "iterate/lib";
import {
  failureKind,
  isPlatformFailureKind,
  RETRY_AFTER_MS,
  type PlatformFailureKind,
} from "@iterate-com/shared/platform-retry";

/** A failure of the platform's own, coded so a client and every later hop read its kind and when
 *  to ask again (iterate/lib `ErrorCode`). */
export const unavailableError = (kind: PlatformFailureKind, message: string) =>
  codedError("UNAVAILABLE", message, { kind, retryAfterMs: RETRY_AFTER_MS[kind] });

/** `error` as it leaves the hop that first saw it: a platform failure workerd or D1 stamped becomes
 *  UNAVAILABLE, its message kept; anything else, a coded one included, is itself. */
export function unavailable(error: unknown): unknown {
  const kind = failureKind(error);
  if (!isPlatformFailureKind(kind) || errorCode(error)) return error;
  return unavailableError(kind, error instanceof Error ? error.message : String(error));
}

/** THE EDGE'S ONE HTTP ANSWER to a failure that is not the request's own: a lent rpc stub offline
 *  is the upstream's absence, a 502; a platform failure is a 503 whose Retry-After says when to ask
 *  again. Anything else is undefined: a refusal's own status, or a 500. */
export function unavailableAnswer(
  error: unknown,
): { status: 502 | 503; headers: Record<string, string> } | undefined {
  if (errorCode(error) === "RPC_STUB_OFFLINE") return { status: 502, headers: {} };
  const kind = failureKind(error);
  if (!isPlatformFailureKind(kind)) return undefined;
  return {
    status: 503,
    headers: { "retry-after": String(RETRY_AFTER_MS[kind] / 1000), "cache-control": "no-store" },
  };
}
