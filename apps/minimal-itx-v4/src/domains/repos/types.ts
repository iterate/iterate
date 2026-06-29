export type RepoFileChange =
  | {
      path: string;
      content: string;
    }
  | {
      path: string;
      delete: true;
    };

export type CommitRepoFilesInput = {
  author?: { email: string; name: string };
  branch?: string;
  changes: RepoFileChange[];
  message: string;
};

export type CommitRepoFilesResult = {
  branch: string;
  changedPaths: string[];
  commitOid: string;
  noChanges: boolean;
};

export interface Repo {
  commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult>;
  create(): Promise<Repo>;
  whoami(): Promise<string>;
}

export interface RepoCollection {
  create(input: { path: string }): Promise<Repo>;
  get(path: string): Repo;
}
