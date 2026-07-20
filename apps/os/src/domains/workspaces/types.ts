// The workspace capability's itx-facing data shapes, shared by the
// WorkspaceV2DurableObject (which produces them) and the Workspace/WorkspaceGit
// RpcTargets in rpc-targets.ts (whose signatures publish them).

/**
 * One overlay change: a local file that shadows a mount file ("modified" —
 * shadowed, not content-diffed), one the mount does not have ("added"), or a
 * mount file hidden by a local delete ("deleted").
 */
export type WorkspaceChange = {
  change: "added" | "deleted" | "modified";
  path: string;
};

/** Per-mount changes plus the unmounted local scratch (never committable). */
export type WorkspaceStatus = {
  mounts: {
    changes: WorkspaceChange[];
    path: string;
    policy: "commit-to-main" | "read-only";
    repoPath: string;
  }[];
  unmounted: WorkspaceChange[];
};

/** Input to `WorkspaceGit.commit` — one mount's changes become one commit on its repo's main. */
export type WorkspaceCommitInput = {
  author?: { email: string; name: string };
  message: string;
  /** The mount to commit (its mount path). Optional when exactly one mount is dirty. */
  scope?: string;
};

/** Result of `WorkspaceGit.commit` — the commit landed on the scoped mount's repo main. */
export type WorkspaceCommitResult = {
  branch: string;
  /** Committed paths, spelled as absolute WORKSPACE paths (mount point included). */
  changedPaths: string[];
  commitOid: string;
  /** The mount the commit was scoped to (its workspace path). */
  mount: string;
  repoPath: string;
};

/** One commit returned by `WorkspaceGit.log` (a mounted repo's main history). */
export type WorkspaceGitLogEntry = {
  author: { email: string; name: string };
  message: string;
  oid: string;
  /** Epoch milliseconds. */
  timestamp: number;
};

/** Input to `WorkspaceGit.log` — one mount's repo history. */
export type WorkspaceGitLogInput = {
  limit?: number;
  /** The mount to read (its mount path). Optional when the table has exactly one mount. */
  scope?: string;
};

/** Input to `Workspace.edit` — a safe single-occurrence string replacement. */
export type EditWorkspaceFileInput = {
  newString: string;
  oldString: string;
  path: string;
  replaceAll?: boolean;
};

/** Result of `Workspace.edit`. The change is in the working tree only — not committed. */
export type EditWorkspaceFileResult = {
  occurrenceCount: number;
  path: string;
};
