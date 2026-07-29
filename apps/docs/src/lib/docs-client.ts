import { newWebSocketRpcSession } from "capnweb";
import type { DocsApi } from "./docs-api.ts";

function dialDocsApi() {
  const url = new URL("/api", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const session = newWebSocketRpcSession<DocsApi>(url.toString());
  return { project: session.authenticate(), session };
}

let liveApi: ReturnType<typeof dialDocsApi> | null = null;

export async function withDocsProjectOnce<T>(
  operation: (project: ReturnType<typeof dialDocsApi>["project"]) => PromiseLike<T>,
): Promise<T> {
  liveApi ??= dialDocsApi();
  return operation(liveApi.project);
}

export async function withDocsProject<T>(
  operation: (project: ReturnType<typeof dialDocsApi>["project"]) => PromiseLike<T>,
): Promise<T> {
  liveApi ??= dialDocsApi();
  try {
    return await operation(liveApi.project);
  } catch (firstError) {
    dispose(liveApi.session);
    liveApi = dialDocsApi();
    try {
      return await operation(liveApi.project);
    } catch (secondError) {
      liveApi = null;
      throw secondError ?? firstError;
    }
  }
}

function dispose(session: unknown): void {
  try {
    // Cap'n Web sessions are explicit-resource-management objects. The
    // runtime check keeps this safe in browsers without Symbol.dispose.
    (session as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  } catch {
    // A broken WebSocket session may already have disposed itself.
  }
}
