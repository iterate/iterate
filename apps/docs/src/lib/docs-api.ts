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
}

export interface DocsWorkspace extends WorkspaceDocumentLane {
  /** Read and classify an existing supported document before live editing. */
  inspect(path: string): Promise<WorkspaceDocumentSnapshot>;
}
