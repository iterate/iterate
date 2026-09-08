import type { ProjectCredential } from "@iterate-com/workspace-documents/server";
import type { WorkspaceDocumentLane } from "@iterate-com/workspace-documents/types";
import type { TasksWorkspace, WorkspaceListEntry } from "./tasks-api.ts";

export type { ProjectCredential } from "@iterate-com/workspace-documents/server";

export type DocsUser = {
  email: string | null;
  image: string | null;
  name: string | null;
  userId: string | null;
};

export type DocumentFormat = "html" | "markdown";

export type WorkspaceDocumentSnapshot = {
  content: string;
  format: DocumentFormat;
  path: string;
  workspacePath: string;
};

export interface DocsApi {
  authenticate(credential?: string | ProjectCredential): Promise<DocsProject>;
}

export interface DocsProject {
  projectId(): Promise<string>;
  whoami(): Promise<DocsUser>;
  /** Address an existing workspace through the DOCUMENT lens. This never
   * creates one. */
  workspace(workspacePath: string): DocsWorkspace;
  /** The project's repo catalog — paths a board can be opened against. */
  repos(): Promise<string[]>;
  /**
   * A board on the app's own workspace naming: the workspace path derives
   * from (boardId, repoPath) and is lazily created on first use.
   * Synchronous on purpose so calls pipeline through it.
   */
  board(boardId: string, repoPath?: string): TasksWorkspace;
  /**
   * The BOARD lens on an existing workspace addressed by its platform path —
   * plain `get`, like workspace(). Outside /workspaces/tasks/ the lens is a
   * guest: reads, comments, and edits work; owner acts (commit, assignAgent)
   * are refused.
   */
  workspaceAt(workspacePath: string, repoPath?: string): TasksWorkspace;
  /** Every workspace stream in the project, newest first (the pickers).
   * Ancestor stream paths that were never created as workspaces are pruned;
   * `board` is resolved for the app's own board workspaces. */
  workspaces(): Promise<WorkspaceListEntry[]>;
  /** The documents (.md/.html) in one workspace's OWN directory,
   * workspace-relative — the home picker's file list. Mount files open by
   * absolute path instead; this deliberately does not walk the mounts. */
  documents(workspacePath: string): Promise<string[]>;
  /**
   * Mint and CREATE an ephemeral scratch workspace under /workspaces/scratch/ (app-neutral:
   * the same workspace opens through every lens)
   * seeded with one starter document — the docs equivalent of opening a
   * fresh tasks board. The one deliberate exception to the plain-`get`
   * posture, and the only door here that creates anything.
   */
  createWorkspace(): Promise<{ workspacePath: string; path: string }>;
  /** The documents (.md/.html) under one /repos/** mount of a workspace's
   * merged view, as fully qualified paths — the file tree's listing. */
  documentsUnder(workspacePath: string, repoPath: string): Promise<string[]>;
  /**
   * Start a jam: mint and CREATE a scratch workspace seeded with one
   * document inside the config mount (committable later), and return the
   * deep link's two halves. Creates through the same workspace `create`
   * call as createWorkspace; these two are the only methods here that
   * create anything.
   */
  createJam(): Promise<{ workspacePath: string; path: string }>;
  /**
   * Put an agent into a jam: birth the jam's own agent if needed and brief
   * it with the workspace path and the open file. Jam workspaces only.
   */
  inviteAgent(workspacePath: string, path?: string): Promise<{ agentPath: string }>;
}

export interface DocsWorkspace extends WorkspaceDocumentLane {
  /** Read and classify an existing supported document before live editing. */
  inspect(path: string): Promise<WorkspaceDocumentSnapshot>;
}
