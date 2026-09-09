/**
 * A jam: a fresh scratch workspace on the config repo that people and agents
 * edit live, addressed by the ordinary Docs deep link (?workspace=&path=).
 * Pure naming and text helpers shared by the vessel (rpc-api.ts) and the
 * browser; the workspace mechanism holds every bit of actual state.
 */

import { DEFAULT_REPO_PATH, SCRATCH_WORKSPACE_PREFIX } from "./board-shared.ts";
import { DOCUMENT_REVIEW_INSTRUCTIONS } from "./document-review-instructions.ts";

/** The repo mount a jam's tree shows and its seed document lives in. */
const JAM_REPO_PATH = DEFAULT_REPO_PATH;

/** The app-neutral scratch namespace every jam (and "New workspace") mints under. */
export function jamWorkspacePath(id: string): string {
  return `${SCRATCH_WORKSPACE_PREFIX}${id}`;
}

/** The one document a jam starts with, inside the repo mount so it can be committed later. */
export function jamDocumentPath(id: string): string {
  return `${JAM_REPO_PATH}/jams/${id}.md`;
}

/** Whether a workspace is one this app minted — the only kind an agent is invited into. */
export function isJamWorkspacePath(workspacePath: string): boolean {
  return workspacePath.startsWith(SCRATCH_WORKSPACE_PREFIX);
}

/** The agent a jam invites: one per jam workspace, named after it. Null outside the jam namespace. */
export function jamAgentPath(workspacePath: string): string | null {
  if (!isJamWorkspacePath(workspacePath)) return null;
  const id = workspacePath.slice(SCRATCH_WORKSPACE_PREFIX.length);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) ? `/agents/jams/${id}` : null;
}

/**
 * The kickoff brief an invited agent receives: where the jam lives, how to
 * read and write through the workspace (never the repo), and that nothing
 * commits by itself.
 */
export function jamInvitation(workspacePath: string, path: string | null): string {
  const example = path ?? `${JAM_REPO_PATH}/README.md`;
  return [
    `You have been invited to a jam. People are editing files live, right now, in the workspace ${workspacePath}.`,
    "",
    "How to take part:",
    `- Read and write through THAT workspace, never the repo directly:`,
    `  const ws = itx.workspaces.get(${JSON.stringify(workspacePath)});`,
    `  await ws.readFile(${JSON.stringify(example)});`,
    `  await ws.edit({ path, oldString, newString }); // or ws.writeFile(path, content)`,
    `- Every project repo is mounted at its own /repos/<name> path inside the workspace (the config repo at ${JAM_REPO_PATH}); the workspace's own files live under ${workspacePath}/. readFile returns the live text of a file someone has open, keystrokes included; your writes appear in their editor immediately.`,
    path === null
      ? "- Nobody has a file open yet; list the workspace with ws.listAllFiles() and wait for instructions."
      : `- The file open right now is ${path}. Say hello: append one short line to it saying you have joined, then wait for instructions in that file or here.`,
    DOCUMENT_REVIEW_INSTRUCTIONS,
    "- Nothing is committed automatically and you must not commit; the people in the jam decide when it lands on main.",
  ].join("\n");
}
