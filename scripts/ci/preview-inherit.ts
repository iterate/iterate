// scripts/ci/preview-inherit.ts — A PUSH THAT CHANGES NOTHING A SUITE DEPENDS ON INHERITS ITS
// VERDICT. A suite's check on a pull request's head (E2E tests, Browser specs) passes without a
// deployment or a test when an earlier head of the same pull request passed it and nothing the suite
// depends on changed since (scripts/ci/preview-units.ts `touchesSuite`). A docs-only push is then
// the same as not pushing: the required checks do not ask for a branch up to date with main, so a
// green on an older merge with main was already enough to merge.
//
// The rules (`planInherit`, preview-inherit.test.ts):
//   1. E2E tests never inherits while the pull request has the `slow-e2e` label: the run it would
//      inherit from may have skipped the rows the label asks for (docs/testing.md#slow-rows).
//   2. Walk the pull request's commits back from the head, at most MAX_WALK of them, to the nearest
//      whose check of this suite has a verdict. No check, one still running, cancelled, skipped or
//      neutral is no verdict: keep walking. Red is: run. None at all (the first push, a force-push
//      that replaced every commit): run.
//   3. Green, run or itself inherited: inherit it when the diff from that commit to the head touches
//      nothing the suite depends on, else run. A diff GitHub cannot list in full is a run.
//
// preview-paths.ts `changes` asks this once it has found that the pull request changes a preview
// path, for the suites its step names (PREVIEW_SUITES): Deploy preview for both, each suite job for
// its own. When every one inherits, the job needs no preview, and says `preview=false`.
import process from "node:process";
import { touchesSuite, type PreviewSuite } from "./preview-units.ts";

/** Each suite's check on a pull request's head, as Depot names it. */
export const SUITE_CHECKS: Record<PreviewSuite, string> = {
  e2e: "Preview OS / E2E tests",
  specs: "Preview OS / Browser specs",
};

/** How far back rule 2 walks: past this many commits with no verdict, a run is cheaper than the
 *  walk. */
export const MAX_WALK = 20;

/** The latest check run of a suite on one commit, as GitHub lists it. */
export type SuiteCheck = { status: string; conclusion: string | null; url: string };

export type InheritDecision =
  | { inherit: true; from: { sha: string; url: string }; reason: string }
  | { inherit: false; reason: string };

/** The rules above. `commits` is the pull request's commits before its head, newest first;
 *  `checkOn` reads a commit's latest check of the suite; `changedSince` lists the files changed from
 *  a commit to the head, or undefined when GitHub cannot list them all. */
export async function planInherit(input: {
  suite: PreviewSuite;
  labels: string[];
  commits: string[];
  checkOn: (sha: string) => Promise<SuiteCheck | undefined>;
  changedSince: (sha: string) => Promise<string[] | undefined>;
}): Promise<InheritDecision> {
  const check = SUITE_CHECKS[input.suite];
  const short = (sha: string) => `\`${sha.slice(0, 7)}\``;
  if (input.suite === "e2e" && input.labels.includes("slow-e2e"))
    return { inherit: false, reason: "the PR has the slow-e2e label" };
  for (const sha of input.commits.slice(0, MAX_WALK)) {
    const found = await input.checkOn(sha);
    if (!found || found.status !== "completed") continue;
    if (["cancelled", "skipped", "neutral"].includes(found.conclusion || "")) continue;
    if (found.conclusion !== "success")
      return { inherit: false, reason: `${check} on ${short(sha)} was ${found.conclusion}` };
    const files = await input.changedSince(sha);
    if (!files)
      return {
        inherit: false,
        reason: `GitHub cannot list every file changed since ${short(sha)}`,
      };
    if (touchesSuite(input.suite, files))
      return {
        inherit: false,
        reason: `the head changes what ${check} depends on since ${short(sha)}`,
      };
    return {
      inherit: true,
      from: { sha, url: found.url },
      reason: `nothing ${check} depends on changed since ${short(sha)} (${files.length} files changed)`,
    };
  }
  return {
    inherit: false,
    reason: `none of the PR's last ${MAX_WALK} commits before its head has a verdict of ${check}`,
  };
}

/** GitHub's REST answer at `path`, with the job's token. */
async function github(path: string): Promise<unknown> {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** Each of `suites` decided for the pull request `number` at `headSha`, reading GitHub (the step's
 *  GITHUB_TOKEN needs `checks: read`). */
export async function inheritFromGitHub(input: {
  number: string;
  headSha: string;
  suites: PreviewSuite[];
}) {
  // The answers' shapes are GitHub's documented REST responses (pulls, pulls/commits, check-runs,
  // compare); this script runs before anything is installed, so it has no schema library to parse
  // them with, and reads only the fields named here.
  const pull = (await github(`/pulls/${input.number}`)) as { labels: { name: string }[] };
  const listed: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = (await github(`/pulls/${input.number}/commits?per_page=100&page=${page}`)) as {
      sha: string;
    }[];
    listed.push(...batch.map((commit) => commit.sha));
    if (batch.length < 100) break;
  }
  // oldest first from GitHub; the walk goes back from the head
  const commits = listed.filter((sha) => sha !== input.headSha).toReversed();
  const changed = new Map<string, Promise<string[] | undefined>>();
  const changedSince = (sha: string) => {
    if (!changed.has(sha))
      changed.set(
        sha,
        (async () => {
          const comparison = (await github(`/compare/${sha}...${input.headSha}`)) as {
            status: string;
            files?: { filename: string; previous_filename?: string }[];
          };
          // GitHub lists at most 300 files; a head that is not ahead of the commit is a force-push
          if (!["ahead", "identical"].includes(comparison.status)) return undefined;
          const files = comparison.files || [];
          if (files.length >= 300) return undefined;
          return files.flatMap((file) =>
            file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
          );
        })(),
      );
    return changed.get(sha)!;
  };
  return Promise.all(
    input.suites.map(async (suite) => ({
      suite,
      ...(await planInherit({
        suite,
        labels: pull.labels.map((label) => label.name),
        commits,
        checkOn: async (sha) => {
          const { check_runs } = (await github(
            `/commits/${sha}/check-runs?check_name=${encodeURIComponent(SUITE_CHECKS[suite])}&filter=latest`,
          )) as { check_runs: { status: string; conclusion: string | null; html_url: string }[] };
          const [latest] = check_runs;
          return (
            latest && { status: latest.status, conclusion: latest.conclusion, url: latest.html_url }
          );
        },
        changedSince,
      })),
    })),
  );
}
