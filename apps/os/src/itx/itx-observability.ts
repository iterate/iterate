import { tracing } from "cloudflare:workers";
import type { RpcSessionOptions } from "capnweb";
import { ItxAuthenticationError } from "../auth.ts";
import { isStreamUnavailableError } from "../domains/streams/stream-unavailable.ts";
import { runWideLog, wideLogger } from "../observability/wide-log.ts";

type RpcCallInfo = {
  path: (string | number)[];
  target: unknown;
};

const itxOutcome = Symbol("itxOutcome");
type ItxErrorOutcome = "client_error" | "error" | "unavailable";
const spanNamePart = /^[a-zA-Z0-9_$:-]+$/;

function safeNamePart(value: unknown, fallback: string) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value);
  return spanNamePart.test(text) ? text.slice(0, 100) : fallback;
}

function targetName(target: unknown): string {
  if ((typeof target !== "object" && typeof target !== "function") || !target) {
    return "Callable";
  }
  try {
    const prototype = Object.getPrototypeOf(target) as object | null;
    const constructor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
      : undefined;
    const name = typeof constructor === "function" ? constructor.name : undefined;
    return safeNamePart(name?.replace(/RpcTarget$/, ""), "Rpc");
  } catch {
    return "Rpc";
  }
}

function methodName(target: unknown, path: RpcCallInfo["path"]): string {
  const candidate = path.at(-1);
  if (typeof candidate !== "string") return "call";
  try {
    let prototype = Object.getPrototypeOf(target) as object | null;
    for (let depth = 0; prototype && depth < 10; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, candidate);
      if (descriptor) {
        return typeof descriptor.value === "function" ? safeNamePart(candidate, "call") : "call";
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  } catch {
    return "call";
  }
  return "call";
}

function correlatedItxError(error: unknown, callId: string, outcome: ItxErrorOutcome): Error {
  let message = "ITX target threw a non-Error value";
  try {
    if (error instanceof Error && typeof error.message === "string") message = error.message;
  } catch {
    // A hostile proxy must not prevent correlation at the RPC boundary.
  }
  const correlated = Object.assign(new Error(message), { itxCallId: callId });
  Object.defineProperty(correlated, itxOutcome, { value: outcome });
  return correlated;
}

function itxErrorOutcome(error: unknown): ItxErrorOutcome {
  try {
    if (error instanceof ItxAuthenticationError) return "client_error";
    // Stream incarnation loss is an explicit, retryable availability outcome
    // (deploy rollover, eviction, overload, or operator kill), not an
    // application/server defect. Keep it observable without polluting the
    // error signal that release gates audit.
    if (isStreamUnavailableError(error)) return "unavailable";
    if (typeof error === "object" && error) {
      const inheritedOutcome: unknown = Reflect.get(error, itxOutcome);
      if (inheritedOutcome === "client_error" || inheritedOutcome === "unavailable") {
        return inheritedOutcome;
      }
    }
  } catch {
    // Hostile thrown values are server errors, but must not break normalization.
  }
  return "error";
}

export function itxRpcMethod(info: Pick<RpcCallInfo, "path" | "target">): string {
  return `${targetName(info.target)}.${methodName(info.target, info.path)}`;
}

/**
 * One long-lived transport session, but one bounded log and custom span per
 * logical RPC. The operation ID doubles as the call ID; the server-side
 * session ID groups calls without changing Cap'n Web's wire protocol.
 */
export function createItxRpcSessionOptions(options: {
  transport: "http" | "websocket";
  sessionId: string;
  parentLogId: string;
}): RpcSessionOptions & {
  onCall<T>(info: RpcCallInfo, invoke: () => Promise<T>): Promise<T>;
} {
  return {
    onCall: (info, invoke) => {
      const method = itxRpcMethod(info);
      return tracing.enterSpan(`itx ${method}`, (span) =>
        runWideLog(
          {
            kind: "itx_rpc",
            parentId: options.parentLogId,
            classifyError: (error) => itxErrorOutcome(error),
          },
          async () => {
            const callId = wideLogger.id();
            wideLogger.set({
              itx: {
                callId,
                method,
                rpcSystem: "capnweb",
                sessionId: options.sessionId,
                transport: options.transport,
              },
            });
            span.setAttribute("rpc.system", "capnweb");
            span.setAttribute("rpc.method", method);
            span.setAttribute("itx.transport", options.transport);
            span.setAttribute("itx.call.id", callId);
            span.setAttribute("itx.session.id", options.sessionId);

            try {
              const result = await invoke();
              span.setAttribute("itx.outcome", "ok");
              return result;
            } catch (error) {
              const outcome = itxErrorOutcome(error);
              span.setAttribute("itx.outcome", outcome);
              // Cap'n Web v0.8.0 copies enumerable Error properties across
              // the wire: https://github.com/cloudflare/capnweb/blob/v0.8.0/src/serialize.ts
              // A fresh error makes the opaque ID authoritative even when a
              // target throws a frozen, pre-tagged, hostile, or non-Error
              // value. Only a safely read message survives; no arguments,
              // results, causes, arbitrary properties, or server stack do.
              throw correlatedItxError(error, callId, outcome);
            }
          },
        ),
      );
    },
  };
}
