import { newWebSocketRpcSession } from "capnweb";
import type { TasksApi, TasksUser, TasksWorkspace, WorkspaceListEntry } from "./tasks-api.ts";
import type { BoardAddress } from "./checkout-shared.ts";

/**
 * The browser's live Cap'n Web session on the vessel's `/api` root — the
 * very same API an agent holds via `itx.worker.tasks`. Dialed lazily,
 * authenticated by the cookie riding the WebSocket upgrade (no explicit
 * token in browser land), shared by every op on the page, and redialed once
 * when a call finds the session broken.
 */
function dialTasksApi() {
  const url = new URL("/api", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const session = newWebSocketRpcSession<TasksApi>(url.toString());
  return { session, project: session.authenticate() };
}

let liveApi: ReturnType<typeof dialTasksApi> | null = null;

/** One try on the LIVE session, no dispose/redial on failure — for
 * best-effort work (teardown flushes) that must never tear down the shared
 * WS under the poll and wait loops riding it. */
export async function withProjectOnce<T>(
  operation: (project: ReturnType<typeof dialTasksApi>["project"]) => PromiseLike<T>,
): Promise<T> {
  liveApi ??= dialTasksApi();
  return operation(liveApi.project);
}

export async function withProject<T>(
  operation: (project: ReturnType<typeof dialTasksApi>["project"]) => PromiseLike<T>,
): Promise<T> {
  liveApi ??= dialTasksApi();
  try {
    return await operation(liveApi.project);
  } catch (firstError) {
    try {
      (liveApi.session as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    } catch {
      // a broken session may already be gone
    }
    liveApi = dialTasksApi();
    try {
      return await operation(liveApi.project);
    } catch (secondError) {
      liveApi = null;
      throw secondError ?? firstError;
    }
  }
}

/**
 * The board's workspace capability for one address, on a live project stub:
 * the lazily-creating door for the tasks app's own naming, the plain-`get`
 * lens door for an existing workspace path. (The stub is a capnweb Proxy;
 * the local cast just names the doors.)
 */
export function workspaceFor(project: unknown, address: BoardAddress): TasksWorkspace {
  const doors = project as {
    workspace(checkoutId: string, repoPath?: string): unknown;
    workspaceAt(workspacePath: string, repoPath?: string): unknown;
  };
  return (
    address.checkoutId !== null
      ? doors.workspace(address.checkoutId, address.repoPath)
      : doors.workspaceAt(address.workspacePath, address.repoPath)
  ) as TasksWorkspace;
}

/** The project's repos, for the sidebar's top-level hierarchy. */
export function listRepos(): Promise<string[]> {
  return withProject((project) => project.repos());
}

/** Every workspace stream in the project (the picker), newest first. */
export function listWorkspaces(): Promise<WorkspaceListEntry[]> {
  return withProject((project) => project.workspaces());
}

/** The platform-verified identity behind this browser's session. */
export function whoami(): Promise<TasksUser> {
  return withProject((project) => project.whoami());
}
