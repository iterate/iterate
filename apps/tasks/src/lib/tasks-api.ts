import type { WorkspaceDocumentLane } from "@iterate-com/workspace-documents/types";
import type { ProjectCredential } from "@iterate-com/workspace-documents/server";

export type { ProjectCredential } from "@iterate-com/workspace-documents/server";

export type {
  CollabAcceptResult,
  CollabChanges,
  CollabOpened,
  CollabWaitResult,
} from "@iterate-com/workspace-documents/types";

/**
 * The vessel's ONE public API: a Cap'n Web WebSocket session at `/api`.
 * Everything speaks this vocabulary — the browser UI, headless probes, and
 * platform agents reaching in via a config worker's `itx.worker.tasks` stub
 * all hold the same capabilities over the same kind of session.
 *
 * The server classes live in ../rpc-api.ts; clients consume these interfaces
 * through capnweb stubs, so a chain like
 * `api.authenticate(token).workspace(id).commit(msg)` pipelines into a single
 * round trip.
 */
/**
 * What a caller may authenticate with. A bare string is shorthand for a
 * project-app-session token (user-attributed — the browser lane and any
 * caller forwarding a user's cookie). `project-secret` is the machine lane:
 * a config worker can obtain its own project's API key
 * (`itx.secrets.get("/secrets/project-api-key").reveal()`) without any
 * browser in the loop, at the cost of project- rather than user-attribution.
 */
export interface TasksApi {
  /**
   * Prove a credential by using it against the platform and get the
   * project-scoped API back. Omit it when the session's upgrade request
   * carried the `iterate-project-auth` cookie (the browser lane).
   */
  authenticate(credential?: string | ProjectCredential): Promise<TasksProject>;
}

/**
 * One workspace stream in the project, as the picker lists them. `board` is
 * present when the path is a tasks-app board workspace (minted under
 * /workspaces/tasks/), parsed back into its (checkoutId, repoPath) address;
 * null for every other workspace (an agent's, ...) — a lens opens those by
 * path, as a guest.
 */
export type WorkspaceListEntry = {
  path: string;
  createdAt: string;
  board: { checkoutId: string; repoPath: string } | null;
};

/**
 * Who this session is, as far as the platform can prove it. userId comes
 * from the verified project-app-session claims; email/name appear once the
 * auth worker mints them into the token (absent claims stay null). The
 * machine lane (project-secret) has no user at all.
 */
export type TasksUser = {
  userId: string | null;
  email: string | null;
  name: string | null;
  /** Avatar URL, once the auth worker mints an `image` claim. */
  image: string | null;
};

export interface TasksProject {
  projectId(): Promise<string>;
  /** The verified identity behind this session's credential. */
  whoami(): Promise<TasksUser>;
  /** The project's repo catalog — paths a board can be opened against. */
  repos(): Promise<string[]>;
  /** Every workspace stream in the project, newest first (the picker). */
  workspaces(): Promise<WorkspaceListEntry[]>;
  /**
   * A board on the tasks app's own workspace naming: the workspace path
   * derives from (checkoutId, repoPath) and is lazily created on first use.
   * Synchronous on purpose so calls pipeline through it.
   */
  workspace(checkoutId: string, repoPath?: string): TasksWorkspace;
  /**
   * A board lens on an EXISTING workspace addressed by its platform path —
   * plain `get`: no lazy creation, no side effects; a missing workspace
   * surfaces the platform's error. Outside /workspaces/tasks/ the lens is a
   * guest: reads, comments, and edits work, owner acts (commit, assignAgent)
   * are refused.
   */
  workspaceAt(workspacePath: string, repoPath?: string): TasksWorkspace;
}

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
  /** Owner act: publishes this mount's ENTIRE dirty set to the repo's main. */
  commit(message: string): Promise<unknown>;
  log(limit?: number): Promise<unknown>;
  /**
   * Assign an agent to one task, the apps/os way: sets `state: in-progress`
   * + the `agent:` frontmatter, commits the mount so the assignment is
   * durable, births the agent if needed, and sends it the kickoff brief.
   * Owner act (it commits).
   */
  assignAgent(path: string): Promise<{ agentPath: string }>;
}
