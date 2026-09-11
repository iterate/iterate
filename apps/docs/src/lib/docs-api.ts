import type { Agent } from "iterate/client";
import type { ProjectCredential } from "@iterate-com/workspace-documents/server";
import type { WorkspaceSurface } from "@iterate-com/workspace-documents/types";

export type { ProjectCredential } from "@iterate-com/workspace-documents/server";

export type DocsUser = {
  email: string | null;
  image: string | null;
  name: string | null;
  userId: string | null;
};

export type DocumentFormat = "html" | "markdown";

/** One opened document, classified by extension for the editor. */
export type WorkspaceDocumentSnapshot = {
  content: string;
  format: DocumentFormat;
  path: string;
  workspacePath: string;
};

/** One workspace stream in the project, as the pickers list them. */
export type WorkspaceListEntry = {
  path: string;
  createdAt: string;
};

/** One event from the workspace's platform stream (the event-sourced spine). */
export type WorkspaceStreamEvent = {
  createdAt: string;
  offset: number;
  payload: unknown;
  type: string;
};

export interface DocsApi {
  authenticate(credential?: string | ProjectCredential): Promise<DocsProject>;
}

export interface DocsProject {
  projectId(): Promise<string>;
  whoami(): Promise<DocsUser>;
  /**
   * An existing workspace, forwarded verbatim from the platform (plain
   * `get`: this never creates one). Synchronous on purpose so calls
   * pipeline through it.
   */
  workspace(workspacePath: string): DocsWorkspace;
  /** The project's repo catalog — paths a board can be opened against. */
  repos(): Promise<string[]>;
  /** Every workspace of the project (the platform catalog), newest first. */
  workspaces(): Promise<WorkspaceListEntry[]>;
  /**
   * CREATE a workspace at its `/agents/…` path — the one deliberate
   * exception to the plain-`get` posture, and the only method here that
   * creates anything. Every project repo is mounted in it by derivation.
   */
  createWorkspace(input: { path: string }): Promise<{ workspacePath: string }>;
  /**
   * The agent that shares a workspace's path: the platform's own `Agent`
   * handle, forwarded verbatim (plain `get`, never creates — the feed pane
   * births it through `create()` when its processor has no birth
   * certificate). Everything an agent can do rides this stub: `stream`
   * reads and connections, `message`, `append`.
   */
  agent(workspacePath: string): Promise<Agent>;
}

/**
 * The platform workspace surface, forwarded verbatim (fs, git, collab), plus
 * the workspace's stream — the two stream reads the events sheet needs.
 */
export interface DocsWorkspace extends WorkspaceSurface {
  /** The newest page of the workspace's stream events, newest first. */
  events(limit?: number): Promise<WorkspaceStreamEvent[]>;
  /** Live push: replay after `afterOffset`, then new commits, delivered to
   * the retained callback until the handle unsubscribes. */
  subscribeEvents(
    processEventBatch: (batch: { events: WorkspaceStreamEvent[] }) => unknown,
    afterOffset?: number,
  ): Promise<{ ping?(): Promise<boolean> | boolean; unsubscribe(): void }>;
}
