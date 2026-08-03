import type { ProjectCredential } from "@iterate-com/workspace-documents/server";
import type { WorkspaceDocumentLane } from "@iterate-com/workspace-documents/types";

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
  whoami(): Promise<DocsUser>;
  /** Address an existing workspace. This never creates one. */
  workspace(workspacePath: string): DocsWorkspace;
  /** Every workspace stream in the project, newest first (the home picker).
   * Ancestor stream paths that were never created as workspaces are
   * pruned, same as the tasks picker. */
  workspaces(): Promise<{ path: string; createdAt: string }[]>;
  /** The documents (.md/.html) in one workspace's OWN directory,
   * workspace-relative — the home picker's file list. Mount files open by
   * absolute path instead; this deliberately does not walk the mounts. */
  documents(workspacePath: string): Promise<string[]>;
  /**
   * Mint and CREATE an ephemeral scratch workspace under /workspaces/docs/
   * seeded with one starter document — the docs equivalent of opening a
   * fresh tasks board. The one deliberate exception to the plain-`get`
   * posture, and the only door here that creates anything.
   */
  createWorkspace(): Promise<{ workspacePath: string; path: string }>;
}

export interface DocsWorkspace extends WorkspaceDocumentLane {
  /** Read and classify an existing supported document before live editing. */
  inspect(path: string): Promise<WorkspaceDocumentSnapshot>;
}
