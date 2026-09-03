import type { TasksWorkspace, WorkspaceListEntry } from "./tasks-api.ts";
import type { DocsUser } from "./docs-api.ts";
import type { BoardAddress } from "./board-shared.ts";
import { withDocsProject, withDocsProjectOnce } from "./docs-client.ts";

/**
 * The board's view of the app's ONE live Cap'n Web session (docs-client.ts
 * owns the dial): the very same `/api` project surface the document pages
 * and agents hold. Same names the board code always used; one WebSocket
 * under everything.
 */
export const withProject = withDocsProject;
export const withProjectOnce = withDocsProjectOnce;

/**
 * The board's workspace capability for one address, on a live project stub:
 * the lazily-creating door for the app's own board naming, the plain-`get`
 * lens door for an existing workspace path. (The stub is a capnweb Proxy;
 * the local cast just names the doors.)
 */
export function workspaceFor(project: unknown, address: BoardAddress): TasksWorkspace {
  const doors = project as {
    board(boardId: string, repoPath?: string): unknown;
    workspaceAt(workspacePath: string, repoPath?: string): unknown;
  };
  return (
    address.boardId !== null
      ? doors.board(address.boardId, address.repoPath)
      : doors.workspaceAt(address.workspacePath, address.repoPath)
  ) as TasksWorkspace;
}

/**
 * The notes workspace capability for one repo, on a live project stub. The
 * vessel's `DocsProject.notes` returns a `TasksWorkspace` capability; capnweb
 * maps a stub's promise-returning members distributively, which cannot
 * express a nested capability's own methods, so the vessel-declared shape is
 * asserted here — the same convention as workspaceFor above.
 */
export function notesFor(project: unknown, repoPath: string): TasksWorkspace {
  return (project as { notes(repoPath: string): unknown }).notes(repoPath) as TasksWorkspace;
}

/** The project's repos, for the board home's per-repo sections. */
export function listRepos(): Promise<string[]> {
  return withProject((project) => project.repos());
}

/** Every workspace stream in the project (the picker), newest first. */
export function listWorkspaces(): Promise<WorkspaceListEntry[]> {
  return withProject((project) => project.workspaces());
}

/** The platform-verified identity behind this browser's session. */
export function whoami(): Promise<DocsUser> {
  return withProject((project) => project.whoami());
}
