// scripts/os/published-package-commit.ts — WHICH COMMIT'S pkg.pr.new BUILD this checkout's packages
// are: the platform's build is given the config templates with `@iterate-com/agents` and
// `@iterate-com/voice` at it (config-templates.ts), and the e2e rows wait for the same build
// (test/helpers/global-setup.ts).
//
// .github/workflows/pkg-pr-new.yml publishes every main commit, and a pull request's head whenever
// the pull request changes a published package's inputs (its `pull_request.paths`). So the commit
// is the source commit when it changes those inputs relative to its merge base with main, else that
// merge base. The source commit is the pull request's head in CI (`PREVIEW_HEAD_SHA`: CI builds the
// test merge, which pkg.pr.new never publishes) and HEAD elsewhere: a local branch that changes a
// package gets a loud 404 until it is pushed, never main's older build.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** The rule above, over git's facts. */
export function publishedPackageCommit(input: {
  sourceCommit: string;
  /** HEAD's merge base with main. */
  mergeBaseSha: string;
  /** What HEAD changes relative to the merge base. */
  changedPaths: string[];
  /** The workflow's `pull_request.paths` globs (`publishPathsOf`). */
  publishPaths: string[];
}): string {
  const publishes = input.changedPaths.some((changed) =>
    input.publishPaths.some((glob) => path.matchesGlob(changed, glob)),
  );
  return publishes ? input.sourceCommit : input.mergeBaseSha;
}

/** The `pull_request.paths` of pkg-pr-new.yml's text: the paths whose change publishes a PR. */
export function publishPathsOf(workflow: string): string[] {
  const block = workflow.slice(workflow.indexOf("pull_request:"), workflow.indexOf("\njobs:"));
  return [...block.matchAll(/^\s+- (\S+)$/gm)].map((match) => match[1]!);
}

/** `publishedPackageCommit` of the checkout at `repoRoot`, from git; `previewHeadSha` is CI's PR
 *  head, when there is one. A CI checkout is the one commit it tests (actions/checkout's depth of 1)
 *  with no main: it first fetches the history of both, commits and trees only, which a merge base
 *  and a diff of names need. */
export function checkoutPublishedPackageCommit(
  repoRoot: string,
  previewHeadSha: string | undefined,
): string {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const headSha = git("rev-parse", "HEAD");
  if (git("rev-parse", "--is-shallow-repository") === "true")
    git(
      "fetch",
      "--quiet",
      "--no-tags",
      "--filter=blob:none",
      "--unshallow",
      "origin",
      headSha,
      "+refs/heads/main:refs/remotes/origin/main",
    );
  const mergeBaseSha = git("merge-base", "HEAD", "origin/main");
  return publishedPackageCommit({
    sourceCommit: previewHeadSha || headSha,
    mergeBaseSha,
    changedPaths: git("diff", "--name-only", mergeBaseSha, "HEAD").split("\n").filter(Boolean),
    publishPaths: publishPathsOf(
      readFileSync(path.join(repoRoot, ".github/workflows/pkg-pr-new.yml"), "utf8"),
    ),
  });
}
