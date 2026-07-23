/**
 * Public repo capability data shapes — the command/result objects for
 * `Repo.commitFiles` / `Repo.edit`. These are the itx contract for repo
 * mutations; they live here (not on a zod schema) because the RpcTarget
 * validates them structurally and there is no untrusted parse boundary.
 */

/**
 * One repo file mutation.
 *
 * Kept named because public `Repo.commitFiles`, input parsing, and artifact
 * commit implementation all validate the same command shape.
 */
export type RepoFileChange =
  | {
      path: string;
      content: string;
    }
  | {
      path: string;
      /** Standard base64 of the file's raw bytes — the binary write lane
       * (images, PDFs, …), matching the `files.put` string convention. */
      contentBase64: string;
    }
  | {
      path: string;
      delete: true;
    };

/** Command object for committing a batch of repo file mutations. */
export type CommitRepoFilesInput = {
  author?: { email: string; name: string };
  branch?: string;
  changes: RepoFileChange[];
  message: string;
};

/** Result returned after a repo commit attempt, including no-op commits. */
export type CommitRepoFilesResult = {
  branch: string;
  changedPaths: string[];
  commitOid: string;
  noChanges: boolean;
};

/** Command object for a coding-agent-style exact string edit. */
export type EditRepoFileInput = {
  author?: { email: string; name: string };
  branch?: string;
  message: string;
  newString: string;
  oldString: string;
  path: string;
  replaceAll?: boolean;
};

/** Result returned after an exact string edit commit attempt. */
export type EditRepoFileResult = CommitRepoFilesResult & {
  occurrenceCount: number;
  path: string;
};

/** One commit in a repo's history, as returned by `repo.log`. */
export type RepoLogCommit = {
  oid: string;
  /** Full commit message, trailing newline trimmed. */
  message: string;
  author: { email: string; name: string };
  /** Author timestamp in epoch milliseconds. */
  timestamp: number;
  /** Parent commit oids — empty for the root commit, 2+ for merges. */
  parents: string[];
};

/** What `repo.log` returns: newest-first commits on one branch. */
export type RepoLogResult = {
  branch: string;
  commits: RepoLogCommit[];
};

/** One changed file in a commit — `git diff --numstat`-shaped counts. */
export type RepoCommitFileChange = {
  path: string;
  status: "added" | "deleted" | "modified";
  /** Lines added; 0 for binary files. */
  additions: number;
  /** Lines removed; 0 for binary files. */
  deletions: number;
  /** True when either side of the diff sniffs binary (NUL byte). */
  binary: boolean;
};

/** What `repo.commitDetails` returns: one commit's metadata plus the files it
 * changed versus its first parent (versus an empty tree for the root commit). */
export type RepoCommitDetails = RepoLogCommit & {
  /** First parent oid — the diff baseline; null for the root commit. */
  parentOid: string | null;
  files: RepoCommitFileChange[];
};

/**
 * The GitHub repository a repo is linked to: the named GitHub connection (an
 * App installation) whose token authenticates mirror pushes, its installation
 * id, and the owner/repo coordinates on GitHub.
 */
export type GithubRepoLink = {
  connection: string;
  /** GitHub's default branch at link time. */
  defaultBranch: string;
  installationId: string;
  owner: string;
  repo: string;
  /** GitHub's stable database identity for this repository. */
  repositoryId: number;
};

/** What `repo.linkGithub` returns: the recorded link, whether the GitHub
 * repository was created by this call, and the initial mirror push's outcome.
 * The compound public-import path reports that push as skipped because the
 * Artifact already came from GitHub. A failed initial push does not fail the
 * link — it is journaled and repaired by `pushToGithub()` or the next commit. */
export type LinkGithubResult = GithubRepoLink & {
  created: boolean;
  initialPush:
    | { ok: true; commitOid: string }
    | { ok: true; skipped: true }
    | { ok: false; error: string };
};

/** What `repo.syncFromGithub` returns: whether the head moved, the adopted
 * commit, and the head it replaced (null when the branch had no cached head). */
export type GithubSyncResult = {
  branch: string;
  changed: boolean;
  commitOid: string;
  forced: boolean;
  previousCommitOid: string | null;
};

/** What `repo.resetFromGithub` returns after destructively replacing the
 * Artifacts repository with the linked GitHub repository's branch head. */
export type GithubResetResult = {
  artifactReplaced: true;
  branch: string;
  commitOid: string;
  previousCommitOid: string | null;
};
