import type { CommitResult, TaskChangeSummary } from "../state.ts";

/**
 * The vessel's ONE public API: a Cap'n Web WebSocket session at `/api`.
 * Everything that isn't Yjs binary sync speaks this vocabulary — the browser
 * UI, headless probes, and platform agents reaching in via a config worker's
 * `itx.worker.tasks` stub all hold the same capabilities over the same kind
 * of session.
 *
 * The server classes live in ../rpc-api.ts; clients consume these interfaces
 * through capnweb stubs, so a chain like
 * `api.authenticate(token).checkout(id).commit(msg)` pipelines into a single
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
export type ProjectCredential =
  | { type: "project-app-session"; token: string }
  | { type: "project-secret"; projectId: string; secret: string };

export interface TasksApi {
  /**
   * Prove a credential by using it against the platform and get the
   * project-scoped API back. Omit it when the session's upgrade request
   * carried the `iterate-project-auth` cookie (the browser lane).
   */
  authenticate(credential?: string | ProjectCredential): Promise<TasksProject>;
}

/** One known checkout, as remembered by the project's index DO. */
export type CheckoutIndexEntry = {
  repoPath: string;
  checkoutId: string;
  createdAt: number;
  lastSeenAt: number;
  lastCommit: string | null;
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
  /** The project's repo catalog — paths a checkout can be opened against. */
  repos(): Promise<string[]>;
  /** Every checkout anyone has opened, newest activity first (the sidebar). */
  checkouts(): Promise<CheckoutIndexEntry[]>;
  /**
   * A capability on one collaborative checkout (creating it on first touch —
   * the underlying Durable Object seeds from the repo's HEAD task files).
   * Synchronous on purpose so calls pipeline through it.
   */
  checkout(checkoutId: string, repoPath?: string): TasksCheckout;
  /** PoC: the checkout AS a platform workspace — one capability carrying the
   * collaborative session lane (open/push/wait, rebase model, no Yjs) and the
   * board lane (files/status/commit/log; the overlay is the only diff). */
  workspace(checkoutId: string, repoPath?: string): TasksWorkspace;
}

// The collab wire, shared verbatim by the vessel and the browser client —
// mirrors the platform engine's contracts (collab-engine.ts).
export type CollabOpened = { content: string; epoch: string; version: number };
export type CollabAcceptResult =
  | { status: "accepted"; version: number }
  | { status: "epoch-mismatch"; epoch: string }
  | { status: "history-miss" }
  | { status: "too-large"; maxBytes: number };
export type CollabWaitResult =
  | { ops: { changes: unknown; clientId: string }[]; status: "ops" }
  | { snapshot: { ackedSeq: number; content: string; epoch: string; version: number }; status: "snapshot" }
  /** The session was durably ended (deleted/replaced/reset) — reopen to resume. */
  | { status: "ended" };

export type CollabChangeSegment =
  | { clientId: string; createdAt?: number; from: number; kind: "inserted"; to: number }
  | { at: number; clientId: string; createdAt?: number; kind: "deleted"; text: string };

/** Two plain arrays on the wire (a union array breaks the platform's
 * generated capnweb types); consumers re-interleave by position. */
export type CollabChanges = {
  baseContent: string;
  baseVersion: number;
  deleted: { at: number; clientId: string; createdAt?: number; text: string }[];
  headVersion: number;
  inserted: { clientId: string; createdAt?: number; from: number; to: number }[];
};

/** One event from the workspace's platform stream (the event-sourced spine). */
export type WorkspaceStreamEvent = {
  createdAt: string;
  offset: number;
  payload: unknown;
  type: string;
};

export interface TasksWorkspace {
  open(filePath: string): Promise<CollabOpened>;
  /** The mount content at HEAD — what uncommitted work diffs against. */
  readBase(filePath: string): Promise<string | null>;
  /** Attributed tracked changes since the last commit (redline segments). */
  changes(filePath: string): Promise<CollabChanges>;
  push(input: {
    baseVersion: number;
    clientId: string;
    epoch: string;
    ops: { changes: unknown; clientSeq: number }[];
    path: string;
  }): Promise<CollabAcceptResult>;
  /** Long-poll: ops after a version (parking ~20s), or a snapshot past the floor. */
  wait(
    filePath: string,
    epoch: string,
    afterVersion: number,
    clientId?: string,
  ): Promise<CollabWaitResult>;
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
  status(): Promise<unknown>;
  commit(message: string): Promise<unknown>;
  log(limit?: number): Promise<unknown>;
}

export type CheckoutSnapshot = {
  /** Commit the checkout's base was seeded from (or last committed to). */
  baseCommit: string;
  /** Live collaborative contents, path → markdown. */
  files: Record<string, string>;
};

export interface TasksCheckout {
  files(): Promise<CheckoutSnapshot>;
  read(path: string): Promise<string | null>;
  /**
   * Set a task file's full contents. Applied to the live Y.Doc as one
   * minimal splice, so concurrent human edits elsewhere in the file survive;
   * every connected browser sees it immediately.
   */
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  /** Uncommitted changes versus the base snapshot (A/M/D + titles). */
  changes(): Promise<TaskChangeSummary[]>;
  /** Flush the checkout's diff against base as one git commit. */
  commit(message: string): Promise<CommitResult>;
  /** AI one-liner for the current uncommitted change set. */
  generateMessage(): Promise<string>;
  /**
   * Assign an agent to one task, the apps/os way: sets `state: in-progress`
   * + the `agent:` frontmatter, commits the checkout so the assignment is
   * durable, births the agent if needed, and sends it the kickoff brief.
   */
  assignAgent(path: string): Promise<{ agentPath: string }>;
}
