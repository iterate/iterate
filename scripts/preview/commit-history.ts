import { execFileSync } from "node:child_process";

/** The candidate's first-parent history; merge commits include their merged changes. */
export class CommitHistory {
  head: string;
  private directory: string;
  private main: string;

  constructor(directory: string, head: string, main: string) {
    this.directory = directory;
    this.main = main;
    this.head = this.git("rev-parse", "--verify", `${head}^{commit}`).trim();
  }

  changedFiles(commit: string) {
    const [, parent] = this.git("rev-list", "--parents", "-n", "1", commit).trim().split(" ");
    // Disabling rename detection returns both deleted and added paths. NULs
    // preserve filenames containing spaces, quotes, or newlines.
    const paths = parent
      ? this.git("diff", "--name-only", "--no-renames", "-z", parent, commit)
      : this.git("diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit);
    return paths.split("\0").filter(Boolean);
  }

  throughMergeBase() {
    const bases = this.git("merge-base", "--all", this.head, this.main).trim().split("\n");
    if (bases.length !== 1) return []; // Criss-cross merges have no single safe boundary.
    const commits = this.git("rev-list", "--first-parent", this.head).trim().split("\n");
    const boundary = commits.indexOf(bases[0]);
    // A merge-base on a side branch cannot bound this first-parent walk.
    return boundary < 0 ? [] : commits.slice(0, boundary + 1);
  }

  private git(...args: string[]) {
    return execFileSync("git", args, {
      cwd: this.directory,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  }
}
