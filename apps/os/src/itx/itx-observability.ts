import { tracing } from "cloudflare:workers";
import type { RpcCallInfo, RpcSessionOptions } from "capnweb";
import { runWideLog, wideLogger, type WideLogSink } from "../observability/wide-log.ts";

const spanNamePart = /^[a-zA-Z0-9_$:-]+$/;

function safeNamePart(value: unknown, fallback: string) {
  const text = String(value);
  return spanNamePart.test(text) ? text.slice(0, 100) : fallback;
}

function targetName(target: unknown): string {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
    return "Callable";
  }
  const name = Reflect.get(target, "constructor")?.name;
  return safeNamePart(typeof name === "string" ? name.replace(/RpcTarget$/, "") : name, "Rpc");
}

export function itxRpcMethod(info: Pick<RpcCallInfo, "path" | "target">): string {
  const path = info.path.map((part) => safeNamePart(part, "property"));
  if (path.length === 0) return `${targetName(info.target)}.call`;
  return (path.length > 1 ? path : [targetName(info.target), ...path]).join(".").slice(0, 240);
}

function errorType(error: unknown): string {
  if (error instanceof Error) return safeNamePart(error.name, "Error");
  return safeNamePart(typeof error, "unknown");
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
  sinks: readonly WideLogSink[];
  waitUntil: (promise: Promise<unknown>) => void;
}): RpcSessionOptions {
  return {
    onCall: (info, invoke) => {
      const method = itxRpcMethod(info);
      return tracing.enterSpan(`itx ${method}`, (span) =>
        runWideLog(
          {
            kind: "itx_rpc",
            parentId: options.parentLogId,
            fields: {
              itx: {
                method,
                rpcSystem: "capnweb",
                sessionId: options.sessionId,
                transport: options.transport,
              },
            },
            sinks: options.sinks,
            waitUntil: options.waitUntil,
          },
          async () => {
            const operationId = wideLogger.get().log.id;
            wideLogger.set({ itx: { callId: operationId } });
            span.setAttribute("rpc.system", "capnweb");
            span.setAttribute("rpc.method", method);
            span.setAttribute("itx.transport", options.transport);
            span.setAttribute("itx.call.id", operationId);
            span.setAttribute("itx.session.id", options.sessionId);

            try {
              const result = await invoke();
              span.setAttribute("itx.outcome", "ok");
              wideLogger.setSummary(`ITX ${method} ok`);
              return result;
            } catch (error) {
              span.setAttribute("itx.outcome", "error");
              span.setAttribute("error.type", errorType(error));
              wideLogger.setSummary(`ITX ${method} error`);
              throw error;
            }
          },
        ),
      );
    },
  };
}
