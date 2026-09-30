// unavailable.ts — THE PLATFORM'S OWN FAILURE AS APPS/OS ANSWERS IT: code UNAVAILABLE on every hop
// and across /api, and the one HTTP answer the edge gives it. The model and its sources:
// docs/engineering-invariants.md#failures-and-retries.
import { codedError, errorCode, reportIssue } from "iterate/lib";
import {
  failureKind,
  isPlatformFailureKind,
  logPlatformFailure,
  RETRY_AFTER_MS,
  type PlatformFailureKind,
} from "iterate/platform-retry";
import { LOOP_LIMIT_HEADER } from "iterate/lib";

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

/** AN EXPRESSION FETCH THAT FAILED, as HTTP: the answer a context's fetch channel gives (the
 *  context Durable Object's `fetch`), and the stateless entrypoint's for a call it ran itself.
 *  `itxExpression` is the `x-itx-expression` header the fetch named. */
export function expressionFetchErrorAnswer(error: unknown, itxExpression: string): Response {
  // A project host makes this path public: default-deny is a 404 (a visitor's "no such app" is
  // no issue), a WebSocket upgrade aimed at a facet-hosted app (context/facet-host.ts) and input
  // that is no call at all are the caller's 400,
  // a lent stub offline or a platform failure the edge's one answer (`unavailableAnswer`: a 502,
  // a 503 with its Retry-After), anything else a 500 — the message alone every way, the stack
  // REPORTED, never served.
  const code = errorCode(error);
  const unavailable = unavailableAnswer(error);
  // A refusal past the loop limit (cause.ts) is the loop's end, answered 508 and marked, never an
  // issue: the fact it was recorded as is.
  if (code === "LOOP_LIMIT")
    return new Response(`508: ${(error as Error).message}\n`, {
      status: 508,
      headers: { [LOOP_LIMIT_HEADER]: "recorded" },
    });
  const status =
    code === "NO_ITX_EXPRESSION_MATCH"
      ? 404
      : code === "FACET_NO_UPGRADE" || code === "INVALID_INPUT"
        ? 400
        : (unavailable?.status ?? 500);
  if (status === 500)
    reportIssue("iterate-context.expression-fetch", error, {
      itxExpression,
    });
  // A lent stub offline (a tunnel killed or asleep, before its rule is un-set) is the
  // upstream's absence: a 502, logged at info and never reported, its header naming the
  // expression to a client. A deploy that reset a context the fetch dialed, where the hop could
  // not send it again (a request with a body, an upgrade; built-ins.ts `callContext`), is a 503 the
  // visitor retries in a second, logged at info and never reported. The prd fault alarm
  // (scripts/ci/prd-fault-alarm.ts) drops the 502 and 503 summaries in these lines' rays. Any
  // other platform failure is a 503 the alarm counts: a lost connection, an overload.
  const kind = failureKind(error);
  if (status === 502 || kind === "deploy-reset")
    console.info({
      event: status === 502 ? "expression-fetch.rpc-stub-offline" : "expression-fetch.deploy-reset",
      itxExpression,
    });
  else if (isPlatformFailureKind(kind))
    logPlatformFailure("expression-fetch", "answered", kind, {
      name: "expression-fetch",
      itxExpression,
      message: String(error),
    });
  const message = error instanceof Error ? error.message : String(error);
  return new Response(`expression fetch error: ${message}\n`, {
    status,
    headers: {
      ...unavailable?.headers,
      ...(status === 502 && { "x-iterate-rpc-stub-offline": itxExpression }),
    },
  });
}
