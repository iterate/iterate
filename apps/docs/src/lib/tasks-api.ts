import type { WorkspaceDocumentLane } from "@iterate-com/workspace-documents/types";

export type {
  CollabAcceptResult,
  CollabChanges,
  CollabOpened,
  CollabWaitResult,
} from "@iterate-com/workspace-documents/types";

/**
 * One workspace stream in the project, as the picker lists them. `board` is
 * present when the path is a tasks-app board workspace (minted under
 * /workspaces/tasks/), parsed back into its (boardId, repoPath) address;
 * null for every other workspace (an agent's, ...) — a lens opens those by
 * path, as a guest.
 */
export type WorkspaceListEntry = {
  path: string;
  createdAt: string;
  board: { boardId: string; repoPath: string } | null;
};

/** One commit of a mount's repo, as `log` returns it (the platform's shape). */
export type WorkspaceGitLogEntry = {
  author: { email: string; name: string };
  message: string;
  oid: string;
  /** Epoch milliseconds. */
  timestamp: number;
};

/** One event from the workspace's platform stream (the event-sourced spine). */
export type WorkspaceStreamEvent = {
  createdAt: string;
  offset: number;
  payload: unknown;
  type: string;
};

/**
 * Path contract: the collab lane inherited from WorkspaceDocumentLane
 * (open/changes/push/wait/present) speaks fully qualified `/repos/**` paths —
 * a session's identity is its platform path, shared with agents. Every other
 * path here is repo-relative (leading slash optional); the vessel qualifies
 * it against the capability's repo mount and returns repo-relative keys.
 */
export interface TasksWorkspace extends WorkspaceDocumentLane {
  /** The mount content at HEAD — what uncommitted work diffs against. */
  readBase(filePath: string): Promise<string | null>;
  /** Fresh caret presence per open file — the card dots (clientIds). */
  presenceSummary(): Promise<Record<string, string[]>>;
  /** Everyone with the BOARD open (heartbeats): clientId -> display name. */
  boardViewers(): Promise<Record<string, string>>;
  /** Heartbeat (or clear, with null name) this client viewing the board. */
  boardPresent(clientId: string, name: string | null): Promise<void>;
  /** Head versions of every live session — the board's change cursor. */
  versions(): Promise<Record<string, number>>;
  /** The newest page of the workspace's stream events (the audit spine). */
  events(limit?: number): Promise<WorkspaceStreamEvent[]>;
  /** Live push lane: replay after `afterOffset`, then new commits, delivered
   * to the retained callback until the handle unsubscribes. */
  subscribeEvents(
    processEventBatch: (batch: { events: WorkspaceStreamEvent[] }) => unknown,
    afterOffset?: number,
  ): Promise<{ ping?(): Promise<boolean> | boolean; unsubscribe(): void }>;
  /** Every task file in the merged view (board seed). */
  files(): Promise<Record<string, string>>;
  /** Merged-view paths matching a repo-relative glob, returned repo-relative. */
  glob(pattern: string): Promise<string[]>;
  /** Filesystem trio with the platform gateway's semantics: live sessions
   * route reads/writes; delete durably ends a session. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<boolean>;
  /** Back to the mount's version: restore a delete, drop an add, undo edits. */
  revert(path: string): Promise<void>;
  // Git passthroughs stay platform-shaped; the pinned client predates them.
  // status() is workspace-wide (one entry per mounted repo) — consumers pick
  // their mount; commit/log are already scoped to the capability's repo.
  status(): Promise<unknown>;
  /** Owner act: publishes this mount's ENTIRE dirty set to the repo's main.
   * `amendIfHead` asks the platform to REPLACE the head commit when it is
   * still exactly that oid (an ordinary commit lands otherwise); the result
   * reports which happened. */
  commit(
    message: string,
    options?: { amendIfHead?: string },
  ): Promise<{ amended: boolean; commitOid: string }>;
  /** The mount's repo history, newest first. */
  log(limit?: number): Promise<WorkspaceGitLogEntry[]>;
  /**
   * Assign an agent to one task, the apps/os way: sets `state: in-progress`
   * + the `agent:` frontmatter, commits the mount so the assignment is
   * durable, births the agent if needed, and sends it the kickoff brief.
   * Owner act (it commits).
   */
  assignAgent(path: string): Promise<{ agentPath: string }>;
}
