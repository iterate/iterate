import type { Octokit } from "@octokit/rest";
import { splitRepositoryFullName } from "./github.ts";

/** Read commit metadata from GitHub; checkout is only needed for the scripts. */
export class CommitHistory {
  head: string;
  stopReason = "";
  private github: Octokit;
  private repository: { owner: string; repo: string };
  private main: string;
  private comparison: { base: string; files: string[] | null } | null = null;
  private commits = new Map<string, { parents: string[]; files: string[]; limited: boolean }>();

  constructor(github: Octokit, repositoryFullName: string, head: string, main: string) {
    this.github = github;
    const [owner, repo] = splitRepositoryFullName(repositoryFullName);
    this.repository = { owner, repo };
    this.head = head;
    this.main = main;
  }

  async *throughMergeBase() {
    let commit = this.head;
    for (let inspected = 0; inspected < 20; inspected++) {
      const current = await this.readCommit(commit);
      if (current.parents.length > 1) {
        this.stopReason = `Encountered merge commit ${commit}; deploy head.`;
        return;
      }
      if (current.limited) {
        this.stopReason = `GitHub file limit reached at ${commit}; deploy head.`;
        return;
      }
      yield { sha: commit, files: current.files };
      if (!current.parents.length) return;
      if (commit === (await this.readComparison()).base) return;
      commit = current.parents[0];
    }
    this.stopReason = "No usable evidence within 20 commits; deploy head.";
  }

  /** A capped comparison cannot justify the os-next branch exemption. */
  async changedSinceMergeBase() {
    return (await this.readComparison()).files;
  }

  private async readComparison() {
    if (this.comparison) return this.comparison;
    console.log(`[preview-history] Comparing ${this.main}...${this.head} on GitHub.`);
    const { data } = await this.github.rest.repos.compareCommits({
      ...this.repository,
      base: this.main,
      head: this.head,
      per_page: 1,
      request: { timeout: 15_000 },
    });
    if (!data.files) throw new Error("GitHub omitted the branch comparison files.");
    this.comparison = {
      base: data.merge_base_commit.sha,
      // GitHub caps comparison files at 300 even when commits are paginated.
      files:
        data.files.length >= 300
          ? null
          : data.files.flatMap((file) =>
              file.previous_filename ? [file.previous_filename, file.filename] : [file.filename],
            ),
    };
    return this.comparison;
  }

  private async readCommit(commit: string) {
    const cached = this.commits.get(commit);
    if (cached) return cached;
    console.log(`[preview-history] Reading commit ${commit} from GitHub.`);
    const { data, headers } = await this.github.rest.repos.getCommit({
      ...this.repository,
      ref: commit,
      per_page: 100,
      request: { timeout: 15_000 },
    });
    if (!data.files) throw new Error(`GitHub omitted files for ${commit}.`);
    const result = {
      parents: data.parents.map((parent) => parent.sha),
      files: data.files.flatMap((file) =>
        file.previous_filename ? [file.previous_filename, file.filename] : [file.filename],
      ),
      // Never classify a partial diff. A full page is our conservative inspection limit.
      limited: data.files.length >= 100 || Boolean(headers.link?.includes('rel="next"')),
    };
    this.commits.set(commit, result);
    return result;
  }
}
