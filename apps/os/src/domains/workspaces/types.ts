// The workspace capability's itx-facing data shapes, shared by the
// WorkspaceDurableObject (which produces them) and the Workspace/WorkspaceGit
// RpcTargets in rpc-targets.ts (whose signatures publish them).

/**
 * Metadata for one workspace filesystem entry — mirrors `@cloudflare/shell`'s
 * `FileInfo`, the shape `readDir`/`glob`/`stat` return.
 */
export type WorkspaceFileInfo = {
  createdAt: number;
  mimeType: string;
  name: string;
  path: string;
  size: number;
  /** Symlink target, present only on symlinks. */
  target?: string;
  type: "directory" | "file" | "symlink";
  updatedAt: number;
};

/**
 * One overlay change returned by `WorkspaceGit.status`: a local file that
 * shadows a parent file ("modified"), one the parent does not have ("added"),
 * or a parent file hidden by a local delete ("deleted"). "modified" means
 * shadowed, not necessarily different — the overlay never diffs content.
 */
export type WorkspaceChange = {
  change: "added" | "deleted" | "modified";
  path: string;
};

/** One commit returned by `WorkspaceGit.log` (the workspace branch's history). */
export type WorkspaceGitLogEntry = {
  author: { email: string; name: string };
  message: string;
  oid: string;
  /** Epoch milliseconds. */
  timestamp: number;
};

/** Result of `WorkspaceGit.commit` — the published snapshot. */
export type WorkspacePublishResult = {
  branch: string;
  /** Paths committed (after .gitignore filtering) plus deletions applied. */
  changedPaths: string[];
  commitOid: string;
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
