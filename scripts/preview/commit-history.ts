import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The candidate's first-parent history; merge commits include their merged changes. */
export class CommitHistory {
  head: string;
  stopReason = "";
  private directory: string;
  private main: string;
  private tail: string[] | null = null;

  constructor(directory: string, head: string, main: string) {
    this.directory = directory;
    this.main = main;
    this.head = this.git("rev-parse", "--verify", `${head}^{commit}`).trim();
  }

  changedFiles(commit: string) {
    // rev-list hides parents at shallow boundaries; the commit object does not.
    const parent = this.git("cat-file", "commit", commit)
      .split("\n\n", 1)[0]
      .split("\n")
      .find((line) => line.startsWith("parent "))
      ?.slice("parent ".length);
    if (parent) {
      // The baked checkout may already contain this tree despite its shallow
      // marker. Probe without Git's implicit lazy fetch so our fetch stays bounded.
      const object = execFileSync("git", ["cat-file", "--batch-check=%(objecttype)"], {
        cwd: this.directory,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
        input: `${parent}^{tree}\n`,
        encoding: "utf8",
      }).trim();
      if (object === `${parent}^{tree} missing`) this.fetch("--deepen=3", this.head);
    }
    // Disabling rename detection returns both deleted and added paths without
    // downloading blobs for similarity checks. NULs preserve unusual filenames.
    const paths = parent
      ? this.git("diff", "--name-only", "--no-renames", "-z", parent, commit)
      : this.git(
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--no-renames",
          "--name-only",
          "-r",
          "-z",
          commit,
        );
    return paths.split("\0").filter(Boolean);
  }

  *throughMergeBase() {
    // Product heads and live deployments at head need no merge-base lookup.
    yield this.head;
    this.tail ||= this.readThroughMergeBase();
    yield* this.tail;
  }

  private readThroughMergeBase() {
    // Checkout's baked origin/main can be stale, or absent in a depth-one fetch.
    // Pin main once, only when a decision actually needs older candidates.
    // Complete local clones already have ancestry; don't make them shallow.
    if (
      this.main === "origin/main" &&
      this.git("rev-parse", "--is-shallow-repository").trim() === "true"
    ) {
      this.fetch("--depth=4", "+refs/heads/main:refs/remotes/origin/main");
    }
    const main = this.git("rev-parse", "--verify", `${this.main}^{commit}`).trim();
    const shallowPath = resolve(
      this.directory,
      this.git("rev-parse", "--git-path", "shallow").trim(),
    );
    // The first batch is small; long branches amortize network round trips.
    // Six expansions plus head/main and a possible boundary-parent fetch bound this to 135s
    // of network waits, below Plan's five-minute job budget.
    for (let expansion = 0; expansion <= 6; expansion++) {
      const result = spawnSync("git", ["merge-base", "--all", this.head, main], {
        cwd: this.directory,
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(`Cannot inspect preview ancestry: ${result.stderr}`);
      }
      const bases = result.stdout.trim().split("\n").filter(Boolean);
      const shallow = existsSync(shallowPath)
        ? readFileSync(shallowPath, "utf8").trim().split("\n")
        : [];
      // A shallow merge-base alone is not proof: another truncated path may
      // conceal a newer or second merge-base. Every path above it must be known.
      const unproven = new Set(
        this.git("rev-list", this.head, main, ...(bases.length ? ["--not", ...bases] : []))
          .trim()
          .split("\n"),
      );
      if (!shallow.some((commit) => unproven.has(commit))) {
        if (bases.length !== 1) {
          this.stopReason = "Complete ancestry has no single merge-base; deploy head.";
          return [];
        }
        const base = bases[0];
        const descendants = new Set(
          this.git("rev-list", "--ancestry-path", `${base}..${this.head}`).trim().split("\n"),
        );
        descendants.add(base);
        const commits = this.git("rev-list", "--first-parent", this.head).trim().split("\n");
        // Main may be a merge's second parent. Never substitute it for the
        // feature's unmerged first-parent code when the walk leaves this set.
        const boundary = commits.findIndex((commit) => !descendants.has(commit));
        return (boundary < 0 ? commits : commits.slice(0, boundary)).slice(1);
      }
      if (expansion < 6) {
        this.fetch(`--deepen=${Math.min(3 ** (expansion + 1), 81)}`, this.head, main);
      }
    }
    this.stopReason =
      "Git metadata fetch budget exhausted before proving a single merge-base; deploy head.";
    console.log(`[preview-history] ${this.stopReason}`);
    return [];
  }

  private fetch(depth: string, ...refs: string[]) {
    console.log(
      `[preview-history] Fetching metadata ${depth} ${refs.join(" ")} (without file contents).`,
    );
    execFileSync(
      "git",
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--filter=blob:none",
        depth,
        "origin",
        ...refs,
      ],
      {
        cwd: this.directory,
        encoding: "utf8",
        // One attempt per fetch; transport/authentication failures are not missing history.
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  private git(...args: string[]) {
    return execFileSync("git", args, {
      cwd: this.directory,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  }
}
