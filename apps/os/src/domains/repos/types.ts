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

/**
 * The GitHub repository a repo is linked to: the named GitHub connection (an
 * App installation) whose token authenticates mirror pushes, its installation
 * id, and the owner/repo coordinates on GitHub.
 */
export type GithubRepoLink = {
  connection: string;
  installationId: string;
  owner: string;
  repo: string;
};

/** What `repo.linkGithub` returns: the recorded link, whether the GitHub
 * repository was created by this call, and the initial mirror push's outcome
 * (a failed initial push does not fail the link — it is journaled on the repo
 * stream and repaired by `pushToGithub()` or the next commit). */
export type LinkGithubResult = GithubRepoLink & {
  created: boolean;
  initialPush: { ok: boolean; commitOid?: string; error?: string };
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
