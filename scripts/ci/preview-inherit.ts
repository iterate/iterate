// scripts/ci/preview-inherit.ts — A PUSH THAT CHANGES NOTHING A SUITE DEPENDS ON INHERITS ITS
// VERDICT. A pull request's run tests its head, and each suite (E2E tests, Browser specs) passes
// without a deployment or a test when an ancestor of the head passed it and nothing the suite
// depends on changed since (scripts/ci/preview-units.ts `suiteInputFiles`). The ancestors are the
// PR's own commits and, past where it branched, main's: a PR that changes nothing a suite depends
// on inherits main's green, and a docs-only push is the same as not pushing. A commit that merges
// main in is a commit like any other, usually one that changes a lot.
//
// The rules (`planInherit`, preview-inherit.test.ts):
//   1. E2E tests never inherits while the pull request has the `slow-e2e` label: the run it would
//      inherit from may have skipped the rows the label asks for (docs/testing.md#slow-rows).
//   2. Walk the head's history back, at most MAX_WALK commits, to the nearest whose check of this
//      suite (a PR run's or Main OS e2e's, `SUITE_CHECKS`) has a verdict. No check, one still
//      running, cancelled, skipped or neutral is no verdict: keep walking. Red is: run. None at all:
//      run.
//   3. Green, run or itself inherited: inherit it when the diff from that commit to the head touches
//      nothing the suite depends on, else run. A diff GitHub cannot list in full is a run.
//
//   node scripts/ci/preview-inherit.ts
//
// is the first step of Preview OS's Deploy preview, for both suites, and of each suite job, for its
// own (PREVIEW_SUITES), on a pull request's push. It runs by node's own type stripping before
// anything is installed, reads GitHub with the job's token (`checks: read`), and writes
// `preview=false` to GITHUB_OUTPUT when every suite it is for inherits, which skips every later step,
// else `preview=true`. A failure to decide is a warning and a run: a run that was not needed costs a
// few minutes.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { suiteInputFiles, type PreviewSuite } from "./preview-units.ts";

/** Each suite's checks, as Depot names them: a PR run's (preview-os.yml) and main's
 *  (main-os-e2e.yml, every row, the slow ones too). */
export const SUITE_CHECKS: Record<PreviewSuite, string[]> = {
  e2e: ["Preview OS / E2E tests", "Main OS e2e / E2E tests"],
  specs: ["Preview OS / Browser specs", "Main OS e2e / Browser specs"],
};

/** How far back rule 2 walks: past this many commits with no verdict, a run is cheaper than the
 *  walk. */
export const MAX_WALK = 20;

/** The latest check run of a suite on one commit, as GitHub lists it. */
export type SuiteCheck = { name: string; status: string; conclusion: string | null; url: string };

export type InheritDecision =
  | { inherit: true; from: { sha: string; url: string }; reason: string }
  | { inherit: false; reason: string };

/** The rules above. `commits` is the head's history before the head, newest first; `checkOn`
 *  reads a commit's latest check of the suite; `changedSince` lists the files changed from a commit
 *  to the head, or undefined when GitHub cannot list them all. */
export async function planInherit(input: {
  suite: PreviewSuite;
  labels: string[];
  commits: string[];
  checkOn: (sha: string) => Promise<SuiteCheck | undefined>;
  changedSince: (sha: string) => Promise<string[] | undefined>;
}): Promise<InheritDecision> {
  const short = (sha: string) => `\`${sha.slice(0, 7)}\``;
  if (input.suite === "e2e" && input.labels.includes("slow-e2e"))
    return { inherit: false, reason: "the PR has the slow-e2e label" };
  for (const [index, sha] of input.commits.slice(0, MAX_WALK).entries()) {
    const found = await input.checkOn(sha);
    if (!found || found.status !== "completed") continue;
    if (["cancelled", "skipped", "neutral"].includes(found.conclusion || "")) continue;
    const where = `${found.name} on ${short(sha)}, ${index + 1} commit(s) back`;
    if (found.conclusion !== "success")
      return { inherit: false, reason: `${where} was ${found.conclusion}` };
    const files = await input.changedSince(sha);
    if (!files)
      return {
        inherit: false,
        reason: `GitHub cannot list every file changed since ${short(sha)}`,
      };
    const inputs = suiteInputFiles(input.suite, files);
    if (inputs.length > 0)
      return {
        inherit: false,
        reason: `${files.length} file(s) changed since ${where} passed, and it depends on ${inputs.length}: ${inputs.slice(0, 3).join(", ")}${inputs.length > 3 ? ", …" : ""}`,
      };
    return {
      inherit: true,
      from: { sha, url: found.url },
      reason: `${where} passed, and none of the ${files.length} file(s) changed since is one it depends on`,
    };
  }
  return {
    inherit: false,
    reason: `none of the head's last ${MAX_WALK} ancestors has a verdict of this suite`,
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

/** A check run as GitHub's check-runs listing has it. */
type ListedCheck = { name: string; status: string; conclusion: string | null; html_url: string };

/** Each of `suites` decided for the pull request `number` at `headSha`, reading GitHub. */
async function inheritFromGitHub(input: {
  number: string;
  headSha: string;
  suites: PreviewSuite[];
}) {
  // The answers' shapes are GitHub's documented REST responses (pulls, commits, check-runs,
  // compare); this script runs before anything is installed, so it has no schema library to parse
  // them with, and reads only the fields named here.
  const pull = (await github(`/pulls/${input.number}`)) as { labels: { name: string }[] };
  // the head first, then its history: the PR's commits, and main's past where it branched
  const history = (await github(`/commits?sha=${input.headSha}&per_page=${MAX_WALK + 1}`)) as {
    sha: string;
  }[];
  const commits = history.map((commit) => commit.sha).filter((sha) => sha !== input.headSha);
  const checks = new Map<string, Promise<ListedCheck[]>>();
  const checksOn = (sha: string) => {
    if (!checks.has(sha))
      checks.set(
        sha,
        (async () => {
          const { check_runs } = (await github(
            `/commits/${sha}/check-runs?per_page=100&filter=latest`,
          )) as { check_runs: ListedCheck[] };
          return check_runs;
        })(),
      );
    return checks.get(sha)!;
  };
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
          const latest = (await checksOn(sha)).find((check) =>
            SUITE_CHECKS[suite].includes(check.name),
          );
          return latest && { ...latest, url: latest.html_url };
        },
        changedSince,
      })),
    })),
  );
}

/** The step: whether the job still needs the preview once each suite it is for has had the chance
 *  to inherit. */
async function main() {
  const number = process.env.PREVIEW_PR_NUMBER || "";
  if (!/^\d+$/.test(number)) throw new Error("PREVIEW_PR_NUMBER must be the pull request's number");
  const suites = (process.env.PREVIEW_SUITES || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((suite) => {
      if (suite !== "e2e" && suite !== "specs")
        throw new Error(`PREVIEW_SUITES names e2e and specs, not ${JSON.stringify(suite)}`);
      return suite;
    });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  let inherited = false;
  try {
    const decisions = await inheritFromGitHub({ number, headSha: head, suites });
    for (const decision of decisions)
      console.log(
        `${decision.suite === "e2e" ? "E2E tests" : "Browser specs"} ${decision.inherit ? "inherits" : "runs"}: ${decision.reason}`,
      );
    inherited = decisions.every((decision) => decision.inherit);
    if (inherited) {
      const lines = decisions.flatMap((decision) =>
        decision.inherit
          ? [
              `${decision.suite === "e2e" ? "E2E tests" : "Browser specs"} inherits [\`${decision.from.sha.slice(0, 7)}\`'s green](${decision.from.url}): ${decision.reason}.`,
            ]
          : [],
      );
      for (const line of lines) console.log(`::notice title=Inherited::${line}`);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n\n")}\n`);
    }
  } catch (error) {
    console.log(
      `::warning title=Inherit::could not decide whether to inherit, so the suites run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log(inherited ? "no preview to deploy or test" : "the preview is needed");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `preview=${!inherited}\n`);
}

if (process.argv[1]?.endsWith("preview-inherit.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
