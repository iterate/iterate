// scripts/ci/merges-with-main.ts — A PULL REQUEST THAT CONFLICTS WITH MAIN GETS A RED CHECK, NOT
// SILENCE. GitHub builds no test merge commit (`refs/pull/<n>/merge`) for a pull request that
// conflicts with its base, and Depot starts no workflow without one: the run it records has no
// commit and no workflows, and the pull request shows no Lint and Typecheck, Test or Preview OS at
// all (#3004, #3006 and #3007 on 2026-09-24: six such runs, each a head that conflicted with main).
//
// .github/workflows/merges-with-main.yml runs this on `pull_request_target`, which GitHub starts
// for a conflicted pull request too and Depot does not support, so it is one of the GitHub Actions
// workflows (docs/depot-ci.md#pull-requests-that-conflict-with-main). The job is the check: it fails,
// with the reason as an error annotation, when the pull request conflicts.
//
// The rules (`mergesWithMain`, merges-with-main.test.ts):
//   1. GitHub's answer is about a newer head: that push's own run decides; this one passes.
//   2. `mergeable: false`: the pull request conflicts, the check fails.
//   3. `mergeable: true`: it merges, the check passes.
//   4. `mergeable: null`: GitHub is still computing it (reading the pull request starts that), so
//      the run asks again; at the last try it passes with a warning that it could not tell.
//
// It needs no dependencies: node runs it with its own type stripping, from a checkout of the base
// branch that never contains the pull request's code.
import { appendFileSync } from "node:fs";
import process from "node:process";

type PullRequest = {
  head: { sha: string };
  base: { ref: string };
  mergeable: boolean | null;
  merge_commit_sha: string | null;
};

type Verdict = {
  outcome: "conflicts" | "merges" | "superseded" | "unknown";
  /** One line for the log, and for a conflict the check's annotation and summary. */
  message: string;
};

/** The rules above; `undefined` means "ask GitHub again" (rule 4 before the last try). */
export function mergesWithMain(input: {
  eventHeadSha: string;
  pullRequest: PullRequest;
  finalAttempt: boolean;
}): Verdict | undefined {
  const { pullRequest } = input;
  const short = (sha: string) => sha.slice(0, 9);
  const base = pullRequest.base.ref;
  if (pullRequest.head.sha !== input.eventHeadSha)
    return {
      outcome: "superseded",
      message: `the pull request's head is now ${short(pullRequest.head.sha)}, not ${short(input.eventHeadSha)}: that push's own run decides`,
    };
  if (pullRequest.mergeable === false)
    return {
      outcome: "conflicts",
      message: `This PR conflicts with ${base}, so GitHub builds no merge commit for it and Depot runs no CI: no Lint and Typecheck, Test or Preview OS. Rebase onto ${base} (or merge ${base} in) and push to get CI.`,
    };
  if (pullRequest.mergeable === true)
    return {
      outcome: "merges",
      message: `${short(input.eventHeadSha)} merges cleanly with ${base}${pullRequest.merge_commit_sha ? ` (merge commit ${short(pullRequest.merge_commit_sha)}, which Depot's CI tests)` : ""}`,
    };
  if (!input.finalAttempt) return undefined;
  return {
    outcome: "unknown",
    message: `GitHub had not computed whether ${short(input.eventHeadSha)} merges with ${base} by the last try; this check cannot tell (GitHub's merge box can)`,
  };
}

async function readPullRequest(repository: string, number: string): Promise<PullRequest> {
  const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(`GET pulls/${number}: ${response.status} ${await response.text()}`);
  return (await response.json()) as PullRequest;
}

async function main(): Promise<void> {
  const number = process.env.PR_NUMBER || "";
  const eventHeadSha = process.env.PR_HEAD_SHA || "";
  const repository = process.env.GITHUB_REPOSITORY || "";
  if (!/^\d+$/.test(number)) throw new Error("PR_NUMBER must be the pull request's number");
  if (!/^[0-9a-f]{40}$/.test(eventHeadSha)) throw new Error("PR_HEAD_SHA must be a commit SHA");
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required");
  // 12 tries 5 s apart: GitHub usually answers within seconds of the first read.
  const attempts = 12;
  for (let attempt = 1; ; attempt++) {
    const finalAttempt = attempt === attempts;
    let verdict: Verdict | undefined;
    try {
      const pullRequest = await readPullRequest(repository, number);
      verdict = mergesWithMain({ eventHeadSha, pullRequest, finalAttempt });
    } catch (error) {
      if (finalAttempt) throw error;
      console.log(`reading the pull request failed, asking again in 5 s: ${String(error)}`);
    }
    if (verdict) return report(verdict);
    if (!finalAttempt) {
      console.log(`try ${attempt}/${attempts}: GitHub has not computed mergeability yet`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

function report(verdict: Verdict): void {
  if (verdict.outcome === "conflicts") {
    console.log(`::error title=Merge conflict::${verdict.message}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Conflicts\n\n${verdict.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (verdict.outcome === "unknown") console.log(`::warning::${verdict.message}`);
  else console.log(verdict.message);
}

if (process.argv[1]?.endsWith("merges-with-main.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
