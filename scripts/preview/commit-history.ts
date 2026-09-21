import { execFileSync } from "node:child_process";

/** The candidate's first-parent history; merge commits include their merged changes. */
export class CommitHistory {
  head: string;
  private directory: string;
  private main: string;
  private base?: string | null;

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

  /** Everything this branch changes relative to main, merged-in main changes excluded. */
  changedSinceMergeBase() {
    const base = this.mergeBase();
    if (!base) return null;
    return this.git("diff", "--name-only", "--no-renames", "-z", base, this.head)
      .split("\0")
      .filter(Boolean);
  }

  throughMergeBase() {
    const base = this.mergeBase();
    if (!base) return [];
    const descendants = new Set(
      this.git("rev-list", "--ancestry-path", `${base}..${this.head}`).trim().split("\n"),
    );
    descendants.add(base);
    const commits = this.git("rev-list", "--first-parent", this.head).trim().split("\n");
    // Main may be a merge's second parent. Inspect that merge and newer
    // first-parent commits, but never substitute main for unmerged feature code.
    const boundary = commits.findIndex((commit) => !descendants.has(commit));
    return boundary < 0 ? commits : commits.slice(0, boundary);
  }

  /** Criss-cross merges have no single safe boundary. Both readers ask; Git answers once. */
  private mergeBase() {
    if (this.base === undefined) {
      const bases = this.git("merge-base", "--all", this.head, this.main).trim().split("\n");
      this.base = bases.length === 1 ? bases[0] : null;
    }
    return this.base;
  }

  private git(...args: string[]) {
    return execFileSync("git", args, {
      cwd: this.directory,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  }
}
