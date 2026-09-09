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
   * pipeline through it. Outside this app's own namespaces the workspace is
   * a guest view: reads, comments, and edits work; the owner acts (commit,
   * assignAgent) are refused.
   */
  workspace(workspacePath: string): DocsWorkspace;
  /** The project's repo catalog — paths a board can be opened against. */
  repos(): Promise<string[]>;
  /** Every workspace of the project (the platform catalog), newest first. */
  workspaces(): Promise<WorkspaceListEntry[]>;
  /**
   * CREATE a scratch workspace under /workspaces/scratch/ — the one
   * deliberate exception to the plain-`get` posture (createJam is the same
   * call with a different seed). App-neutral: the same workspace opens
   * through every view. Seeded with one starter document, returned as `path`.
   */
  createWorkspace(): Promise<{ workspacePath: string; path: string }>;
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
  /**
   * Assign an agent to one task, the apps/os way: sets `state: in-progress`
   * + the `agent:` frontmatter, commits the mount so the assignment is
   * durable, births the agent if needed, and sends it the kickoff brief.
   * Owner act (it commits). `path` is repo-relative under `repoPath`.
   */
  assignAgent(input: {
    workspacePath: string;
    repoPath: string;
    path: string;
  }): Promise<{ agentPath: string }>;
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
