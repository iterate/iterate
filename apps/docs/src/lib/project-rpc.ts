import type { DocsUser, DocsWorkspace, WorkspaceListEntry } from "./docs-api.ts";
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
 * One workspace on a live project stub — the platform surface forwarded
 * verbatim, plain get. (The stub is a capnweb Proxy; the local cast just
 * names the door.)
 */
export function workspaceFor(project: unknown, workspacePath: string): DocsWorkspace {
  return (project as { workspace(workspacePath: string): unknown }).workspace(
    workspacePath,
  ) as DocsWorkspace;
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
