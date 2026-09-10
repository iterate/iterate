import type {
  WorkspaceCommitInput,
  WorkspaceCommitResult,
  WorkspaceGitLogEntry,
  WorkspaceGitLogInput,
  WorkspaceStatus,
} from "iterate/client";

/**
 * The platform workspace collaboration wire, as `itx.workspaces.get(path).collab`
 * speaks it. Vessels forward it verbatim; hosts hand over a live stub.
 */
export type CollabOpened = { content: string; epoch: string; version: number };

export type CollabAcceptResult =
  | { status: "accepted"; version: number }
  | { status: "epoch-mismatch"; epoch: string }
  | { status: "history-miss" }
  | { status: "too-large"; maxBytes: number };

export type CollabPresence = {
  clients: { anchor: number; at: number; clientId: string; head: number }[];
  generation: number;
};

export type CollabWaitResult =
  | { ops: { changes: unknown; clientId: string }[]; presence?: CollabPresence; status: "ops" }
  | {
      snapshot: { ackedSeq: number; content: string; epoch: string; version: number };
      status: "snapshot";
    }
  | { status: "ended" };

/** Fresh caret presence per live session, index-matched (the platform's flat, generator-legal shape). */
export type CollabPresenceFlat = { clientIds: string[]; paths: string[] };

/** The collaborative session surface of one workspace (`workspace.collab`). */
export interface WorkspaceCollabSurface {
  open(path: string): Promise<CollabOpened>;
  push(input: {
    baseVersion: number;
    clientId: string;
    epoch: string;
    ops: { changes: unknown; clientSeq: number }[];
    path: string;
  }): Promise<CollabAcceptResult>;
  wait(
    path: string,
    epoch: string,
    afterVersion: number,
    clientId?: string,
    afterPresence?: number,
  ): Promise<CollabWaitResult>;
  present(
    path: string,
    clientId: string,
    selection: { anchor: number; head: number } | null,
  ): Promise<void>;
  /** Head versions of every live session — a cheap change cursor. */
  versions(): Promise<Record<string, number>>;
  presenceSummary(): Promise<CollabPresenceFlat>;
  /** Everyone with the board open (heartbeats): clientId → display name. */
  boardViewers(): Promise<Record<string, string>>;
  /** Announce (or clear, with a null name) one client viewing the board. */
  boardPresent(clientId: string, name: string | null): Promise<void>;
}

/** The per-mount git surface of one workspace (`workspace.git`). */
export interface WorkspaceGitSurface {
  /** Changes grouped by owning mount, plus the never-committable unmounted scratch. */
  status(): Promise<WorkspaceStatus>;
  /** ONE mount's changes become one commit on that repo's main; `scope` picks the mount. */
  commit(input: WorkspaceCommitInput): Promise<WorkspaceCommitResult>;
  log(input?: WorkspaceGitLogInput): Promise<WorkspaceGitLogEntry[]>;
}

/**
 * The platform workspace surface every shared workspace component speaks —
 * the shape of `itx.workspaces.get(path)`, spelled with plain promises. A
 * host inside OS hands over the live stub; a vessel outside forwards it
 * method for method. Paths are fully qualified workspace paths throughout
 * (`/repos/config/docs/plan.md`, `/workspace/notes.md`).
 */
export interface WorkspaceSurface {
  /** One file's contents from the merged view (overlay, then its mount at HEAD); null when missing. */
  readFile(path: string): Promise<string | null>;
  /** Batched reads: one round trip, missing paths map to null. */
  readFiles(paths: string[]): Promise<Record<string, string | null>>;
  /** A path's mount content at HEAD — the base uncommitted work diffs against. */
  readBase(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  /** Whiteouts a mount copy; false when the path did not exist. */
  deleteFile(path: string): Promise<boolean>;
  /** Back to the mount's version: restore a delete, drop an add, undo edits. */
  revert(path: string): Promise<void>;
  /** Every file path in the merged view (local layer + every mount at HEAD), sorted. */
  listAllFiles(): Promise<string[]>;
  glob(pattern: string): Promise<string[]>;
  git: WorkspaceGitSurface;
  collab: WorkspaceCollabSurface;
}

/**
 * Reconnect-aware access to one workspace. `runOnce` is deliberately quiet:
 * teardown flushes must never replace the shared connection under live polls.
 */
export interface WorkspaceTransport {
  run<T>(operation: (workspace: WorkspaceSurface) => PromiseLike<T>): Promise<T>;
  runOnce<T>(operation: (workspace: WorkspaceSurface) => PromiseLike<T>): Promise<T>;
}

export type CommentIdentity = { author: string; authorDisplay?: string };
