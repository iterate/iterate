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

/** One commit returned by `WorkspaceGit.log`. */
export type WorkspaceGitLogEntry = {
  author: { email: string; name: string; timestamp: number };
  message: string;
  oid: string;
  parent: string[];
};

/** One file's staging state returned by `WorkspaceGit.status`. */
export type WorkspaceGitStatusEntry = {
  filepath: string;
  /** HEAD status: 0=absent, 1=present. */
  head: number;
  /** Stage status: 0=absent, 1=identical, 2=modified, 3=added. */
  stage: number;
  /** Human-readable status (e.g. "modified", "added"). */
  status: string;
  /** Workdir status: 0=absent, 1=identical, 2=modified. */
  workdir: number;
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
