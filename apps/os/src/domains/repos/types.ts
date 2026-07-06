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
