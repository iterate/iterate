import { tracing } from "cloudflare:workers";
import type { RpcCallInfo, RpcSessionOptions } from "capnweb";
import { parseItxCallMetadata } from "./itx-call-metadata.ts";

type ItxTransport = "http" | "websocket";

function targetName(target: unknown): string {
  if (typeof target !== "object" || target === null) return "Callable";
  const name = target.constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : "RpcTarget";
}

function rpcMethod(info: RpcCallInfo): string {
  const path = info.path.map(String).join(".") || "call";
  return `${targetName(info.target)}.${path}`.slice(0, 256);
}

function errorType(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name.slice(0, 128);
  return typeof error;
}

type ItxRpcLog = {
  message: "itx rpc completed";
  event: "itx.rpc";
  schema_version: 1;
  outcome: "ok" | "error";
  duration_ms: number;
  rpc_method: string;
  rpc_system: "capnweb";
  transport: ItxTransport;
  call_id: string;
  connection_id: string;
  server_session_id: string;
  client: "browser" | "node" | "unknown";
  project_id?: string;
  error_type?: string;
};

function writeCompletion(event: ItxRpcLog) {
  if (event.outcome === "error") {
    console.error(event);
  } else {
    console.log(event);
  }
}

/**
 * Make each logical itx call the application span beneath the WebSocket event.
 * Calls on one socket share a connection ID but receive independent call IDs,
 * logs, timings, and platform-operation children.
 */
export function createItxRpcSessionOptions(transport: ItxTransport): RpcSessionOptions {
  const serverSessionId = crypto.randomUUID();

  return {
    onCall: (info, invoke) => {
      const metadata = parseItxCallMetadata(info.metadata);
      const callId = metadata?.callId ?? crypto.randomUUID();
      const connectionId = metadata?.connectionId ?? serverSessionId;
      const method = rpcMethod(info);
      const startedAt = performance.now();

      return tracing.enterSpan("itx.rpc", async (span) => {
        span.setAttribute("rpc.system", "capnweb");
        span.setAttribute("rpc.method", method);
        span.setAttribute("itx.transport", transport);
        span.setAttribute("itx.call.id", callId);
        span.setAttribute("itx.connection.id", connectionId);
        span.setAttribute("itx.server_session.id", serverSessionId);
        span.setAttribute("itx.client", metadata?.client ?? "unknown");
        span.setAttribute("itx.project.id", metadata?.projectId);

        try {
          const result = await invoke();
          span.setAttribute("itx.outcome", "ok");
          writeCompletion({
            message: "itx rpc completed",
            event: "itx.rpc",
            schema_version: 1,
            outcome: "ok",
            duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
            rpc_method: method,
            rpc_system: "capnweb",
            transport,
            call_id: callId,
            connection_id: connectionId,
            server_session_id: serverSessionId,
            client: metadata?.client ?? "unknown",
            ...(metadata?.projectId === undefined ? {} : { project_id: metadata.projectId }),
          });
          return result;
        } catch (error) {
          const type = errorType(error);
          span.setAttribute("itx.outcome", "error");
          span.setAttribute("error.type", type);
          writeCompletion({
            message: "itx rpc completed",
            event: "itx.rpc",
            schema_version: 1,
            outcome: "error",
            duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
            rpc_method: method,
            rpc_system: "capnweb",
            transport,
            call_id: callId,
            connection_id: connectionId,
            server_session_id: serverSessionId,
            client: metadata?.client ?? "unknown",
            ...(metadata?.projectId === undefined ? {} : { project_id: metadata.projectId }),
            error_type: type,
          });
          throw error;
        }
      });
    },
  };
}
