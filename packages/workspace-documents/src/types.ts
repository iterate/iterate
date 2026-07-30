/**
 * The platform workspace collaboration wire. Both Tasks and Docs adapt their
 * project-specific lookup into this one document lane.
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

export type CollabChangeSegment =
  | { clientId: string; createdAt?: number; from: number; kind: "inserted"; to: number }
  | { at: number; clientId: string; createdAt?: number; kind: "deleted"; text: string };

export type CollabChanges = {
  baseContent: string;
  baseVersion: number;
  deleted: { at: number; clientId: string; createdAt?: number; text: string }[];
  headVersion: number;
  inserted: { clientId: string; createdAt?: number; from: number; to: number }[];
};

export interface WorkspaceDocumentLane {
  open(path: string): Promise<CollabOpened>;
  changes(path: string): Promise<CollabChanges>;
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
}

/**
 * Reconnect-aware access to one workspace. `runOnce` is deliberately quiet:
 * teardown flushes must never replace the shared connection under live polls.
 */
export interface WorkspaceDocumentTransport {
  run<T>(operation: (lane: WorkspaceDocumentLane) => PromiseLike<T>): Promise<T>;
  runOnce<T>(operation: (lane: WorkspaceDocumentLane) => PromiseLike<T>): Promise<T>;
}

export type CommentIdentity = { author: string; authorDisplay?: string };
