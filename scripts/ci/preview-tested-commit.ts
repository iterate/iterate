// scripts/ci/preview-tested-commit.ts — WHICH COMMIT A PULL REQUEST'S PREVIEW TESTS: the pull request
// merged into main (GitHub's test merge commit, `refs/pull/<n>/merge`), so the preview proves what main
// will be after the merge, not the branch as it forked. The preview keeps its name and URL per pull
// request (apps/os/scripts/preview-config.ts); only the commit it is built from changes.
//
// The rules (`previewTestedCommit`, preview-tested-commit.test.ts):
//   1. A merge commit whose second parent is the head this run was started for is what the run tests.
//   2. A merge commit built from another head is GitHub's previous one: it rebuilds the merge
//      asynchronously after a push, so the run asks again, and falls back to the head at the last try.
//   3. No merge commit at all (the pull request conflicts with main) means the run tests the head
//      alone, and says so.
//
// .depot/workflows/preview-os-next.yml runs this right after checking out the head, before anything
// is installed, so it needs no dependencies: node runs it with its own type stripping. It checks the
// tested commit out in place and hands its SHA to the jobs after deploy, which check out that same
// SHA (GitHub serves a test merge commit by SHA after main has moved on and the ref with it).
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

type PreviewTestedCommit = {
  sha: string;
  kind: "merge" | "head";
  headSha: string;
  /** Main's commit the head was merged into (rule 1 only). */
  mainSha?: string;
  /** One line for the PR body and the job log. */
  description: string;
};

/** The rules above; `undefined` means "ask GitHub again" (rule 2 before the last try). */
export function previewTestedCommit(input: {
  headSha: string;
  mergeCommit?: { sha: string; parents: string[] };
  finalAttempt: boolean;
}): PreviewTestedCommit | undefined {
  const short = (sha: string) => `\`${sha.slice(0, 9)}\``;
  const { headSha, mergeCommit } = input;
  if (mergeCommit?.parents.length === 2 && mergeCommit.parents[1] === headSha) {
    const mainSha = mergeCommit.parents[0]!;
    return {
      sha: mergeCommit.sha,
      kind: "merge",
      headSha,
      mainSha,
      description: `the merge commit ${short(mergeCommit.sha)}: this PR's head ${short(headSha)} merged into main at ${short(mainSha)}`,
    };
  }
  if (mergeCommit && !input.finalAttempt) return undefined;
  return {
    sha: headSha,
    kind: "head",
    headSha,
    description: mergeCommit
      ? `this PR's head ${short(headSha)} alone: GitHub's merge commit was still built from an older head`
      : `this PR's head ${short(headSha)} alone: GitHub has no merge commit, so the PR conflicts with main`,
  };
}

function git(...args: string[]) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function gitOutput(...args: string[]): string {
  const result = git(...args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const pullRequestNumber = process.env.PREVIEW_PR_NUMBER;
  if (!pullRequestNumber || !/^\d+$/.test(pullRequestNumber))
    throw new Error("PREVIEW_PR_NUMBER must be the pull request's number");
  const headSha = gitOutput("rev-parse", "HEAD");
  const mergeRef = `refs/remotes/origin/pull/${pullRequestNumber}/merge`;
  const attempts = 6;
  for (let attempt = 1; ; attempt++) {
    const fetched = git(
      "fetch",
      "--quiet",
      "--depth=1",
      "origin",
      `+refs/pull/${pullRequestNumber}/merge:${mergeRef}`,
    );
    if (fetched.status !== 0 && !/couldn't find remote ref/i.test(fetched.stderr))
      throw new Error(`git fetch of the merge commit failed: ${fetched.stderr.trim()}`);
    const mergeSha = fetched.status === 0 ? gitOutput("rev-parse", mergeRef) : undefined;
    const tested = previewTestedCommit({
      headSha,
      mergeCommit: mergeSha
        ? {
            sha: mergeSha,
            // the raw commit object names its parents even in a depth-1 clone
            parents: [...gitOutput("cat-file", "-p", mergeSha).matchAll(/^parent (\w+)$/gm)].map(
              (match) => match[1]!,
            ),
          }
        : undefined,
      finalAttempt: attempt === attempts,
    });
    if (tested) {
      if (tested.kind === "merge") gitOutput("checkout", "--quiet", "--detach", tested.sha);
      console.log(`this run tests ${tested.description}`);
      const outputs = [
        `sha=${tested.sha}`,
        `kind=${tested.kind}`,
        `head-sha=${tested.headSha}`,
        `description=${tested.description}`,
      ];
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
      return;
    }
    console.log(
      `GitHub's merge commit ${mergeSha} is not built from ${headSha} yet; asking again in 10 s`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

if (process.argv[1]?.endsWith("preview-tested-commit.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
