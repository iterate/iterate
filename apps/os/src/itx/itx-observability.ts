import { tracing } from "cloudflare:workers";
import type { RpcSessionOptions } from "capnweb";
import { runWideLog, wideLogger } from "../observability/wide-log.ts";

type RpcCallInfo = {
  path: (string | number)[];
  target: unknown;
};

const spanNamePart = /^[a-zA-Z0-9_$:-]+$/;

function safeNamePart(value: unknown, fallback: string) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value);
  return spanNamePart.test(text) ? text.slice(0, 100) : fallback;
}

function targetName(target: unknown): string {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
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
    for (let depth = 0; prototype !== null && depth < 10; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, candidate);
      if (descriptor !== undefined) {
        return typeof descriptor.value === "function" ? safeNamePart(candidate, "call") : "call";
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  } catch {
    return "call";
  }
  return "call";
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
              span.setAttribute("itx.outcome", "error");
              throw error;
            }
          },
        ),
      );
    },
  };
}
