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

/**
 * The workspace's LIVE configuration: the effective mount table that routes
 * reads and commits — every project repo at its own /repos/** stream path
 * (commit-to-main), with the workspace's stored overlay deviations merged in.
 */
export type WorkspaceEffectiveConfig = {
  mounts: Record<
    string,
    {
      policy: "commit-to-main" | "read-only";
      repoPath: string;
    }
  >;
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
  /**
   * Tidy history: when the repo's head is EXACTLY this commit oid, the new
   * commit REPLACES it (same parents, head's tree plus these changes, this
   * message) instead of stacking on top; when the head has moved on, an
   * ordinary commit lands on top — as it always does on a GitHub-linked repo,
   * whose history stays append-only. The result's `amended` says which
   * happened.
   */
  amendIfHead?: string;
  author?: { email: string; name: string };
  message: string;
  /** The mount to commit (its mount path). Optional when exactly one mount is dirty. */
  scope?: string;
};

/** Result of `WorkspaceGit.commit` — the commit landed on the scoped mount's repo main. */
export type WorkspaceCommitResult = {
  /** True when `amendIfHead` matched the head and the commit replaced it. */
  amended: boolean;
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
