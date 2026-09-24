// scripts/ci/main-e2e-alert.ts — THE PAGE FOR MAIN'S E2E RUN (.depot/workflows/main-os-e2e.yml): every
// push to main deploys a throwaway preview, runs the e2e suite, the browser specs and the residency
// gate against it, and deletes it. This posts to #error-pulse only when main CHANGES state: once when
// it goes red (naming the failed jobs and the failing rows), once when it is green again. A red that
// stays red, and every green, post nothing. Main's state is its last FINISHED run of the same
// workflow — the check runs Depot posts on each earlier main commit — so a workflow's first run,
// with no finished run before it, is no change of state and posts nothing.
//
//   pnpm tsx scripts/ci/main-e2e-alert.ts failing-rows --dir test-results/ci-telemetry/raw
//   NEEDS='${{ toJSON(needs) }}' GITHUB_TOKEN=… GITHUB_REPOSITORY=… pnpm tsx scripts/ci/main-e2e-alert.ts \
//     alert --workflow "Main OS e2e" [--label "main e2e"] [--dry-run]
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getSlackClient, slackChannelIds } from "./slack.ts";

export type MainE2eState = "green" | "red";

/** The run's verdict from its jobs' results: red on any failure, green when every job succeeded, and
 *  none at all when a job was cancelled (a newer push superseded the run) or nothing failed but not
 *  everything ran. Pure. */
export function mainE2eVerdict(results: Record<string, string>): MainE2eState | undefined {
  const values = Object.values(results);
  if (values.includes("cancelled")) return undefined;
  if (values.includes("failure")) return "red";
  if (values.length > 0 && values.every((result) => result === "success")) return "green";
  return undefined;
}

/** The failed rows of a run's telemetry artifacts: a test whose outcome was unexpected (Playwright),
 *  or whose final state failed or timed out (vitest), the flake summary's own rule. Pure. */
export function mainE2eFailingRows(artifacts: TestTelemetryArtifact[]): string[] {
  const rows = artifacts.flatMap((artifact) =>
    artifact.tests
      .filter((test) =>
        test.outcome
          ? test.outcome === "unexpected"
          : ["failed", "timedout"].includes(test.state.toLowerCase()),
      )
      .map((test) => `${path.basename(test.moduleId)}: ${test.leafName || test.fullName}`),
  );
  return [...new Set(rows)];
}

/** One check run on a commit, as GitHub lists it: Depot names each `<workflow> / <job name>`. */
export type CommitCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
};

/** The verdict of one earlier main commit's run of `workflow`, from its check runs: the latest
 *  attempt of each job, the alert job itself and skipped jobs aside, through mainE2eVerdict. None
 *  when the workflow did not run there, is still running, or was superseded. Pure. */
export function mainE2eVerdictOfCommit(
  checkRuns: CommitCheckRun[],
  workflow: string,
): MainE2eState | undefined {
  const latest = new Map<string, CommitCheckRun>();
  for (const run of checkRuns)
    if (run.name.startsWith(`${workflow} / `) && run.name !== `${workflow} / alert`)
      if (run.id > (latest.get(run.name)?.id ?? -1)) latest.set(run.name, run);
  const jobs = [...latest.values()];
  if (jobs.some((run) => run.status !== "completed")) return undefined;
  const results = Object.fromEntries(
    jobs
      .filter((run) => run.conclusion !== "skipped")
      .map((run) => [
        run.name,
        run.conclusion === "success" || run.conclusion === "cancelled" ? run.conclusion : "failure",
      ]),
  );
  return mainE2eVerdict(results);
}

/** The page for a change of state, or null. `previous` is main's last finished run's verdict, or
 *  undefined when there was none: a first run changes no state. Pure. */
export function mainE2ePage(input: {
  label: string;
  previous: MainE2eState | undefined;
  verdict: MainE2eState | undefined;
  commitSha: string;
  commitSubject: string;
  failedJobs: string[];
  failingRows: string[];
  runUrl?: string;
}): string | null {
  if (!input.verdict || !input.previous || input.verdict === input.previous) return null;
  const commit = `\`${input.commitSha.slice(0, 9)}\` (${input.commitSubject})`;
  const link = input.runUrl ? `<${input.runUrl}|the run>` : "";
  if (input.verdict === "green")
    return [`🟢 ${input.label} green again at ${commit}`, link].filter(Boolean).join("\n");
  const shown = input.failingRows.slice(0, 8);
  return [
    // the mention is Jonas (./slack.ts)
    `🔴 ${input.label} red at ${commit} <@U067G4QRFK2>`,
    `• failed: ${input.failedJobs.join(", ") || "a job"}`,
    shown.length > 0 &&
      `• failing rows: ${shown.join("; ")}${input.failingRows.length > shown.length ? `; … and ${input.failingRows.length - shown.length} more` : ""}`,
    link,
  ]
    .filter(Boolean)
    .join("\n");
}

/** `${{ toJSON(needs) }}`: each job's result, and e2e's failing rows. */
const Needs = z.record(
  z.string(),
  z.object({ result: z.string(), outputs: z.record(z.string(), z.string()).optional() }),
);

/** GitHub's REST API with the job's token. */
async function github<T>(route: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const response = await fetch(`https://api.github.com${route}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "main-e2e-alert",
    },
  });
  if (!response.ok) throw new Error(`GitHub GET ${route} failed with ${response.status}`);
  return (await response.json()) as T;
}

/** Main's state before `commitSha`: the verdict of the newest of the 30 commits before it whose run
 *  of `workflow` finished, or undefined when none did. */
async function previousMainE2eState(
  workflow: string,
  commitSha: string,
): Promise<MainE2eState | undefined> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const commits = await github<{ sha: string }[]>(
    `/repos/${repository}/commits?sha=${commitSha}&per_page=31`,
  );
  for (const { sha } of commits.filter((commit) => commit.sha !== commitSha)) {
    const { check_runs } = await github<{ check_runs: CommitCheckRun[] }>(
      `/repos/${repository}/commits/${sha}/check-runs?per_page=100`,
    );
    const verdict = mainE2eVerdictOfCommit(check_runs, workflow);
    if (verdict) {
      console.log(`${workflow}: main's last finished run was ${verdict}, at ${sha.slice(0, 9)}`);
      return verdict;
    }
  }
  console.log(`${workflow}: no finished run in the 30 commits before this one`);
  return undefined;
}

async function alert(workflow: string, label: string, dryRun: boolean): Promise<void> {
  const needs = Needs.parse(JSON.parse(process.env.NEEDS || "{}"));
  const results = Object.fromEntries(
    Object.entries(needs).map(([job, need]) => [job, need.result]),
  );
  const verdict = mainE2eVerdict(results);
  const failingRows = z
    .array(z.string())
    .parse(JSON.parse(needs.e2e?.outputs?.["failing-rows"] || "[]"));
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const commitSubject = execFileSync("git", ["log", "-1", "--format=%s"], {
    encoding: "utf8",
  }).trim();
  const previous = await previousMainE2eState(workflow, commitSha);
  const page = mainE2ePage({
    label,
    previous,
    verdict,
    commitSha,
    commitSubject,
    failedJobs: Object.entries(results)
      .filter(([, result]) => result === "failure")
      .map(([job]) => job),
    failingRows,
    runUrl: process.env.DEPOT_JOB_URL,
  });
  console.log(JSON.stringify({ results, verdict, previous, failingRows }));
  if (!page) return console.log(`${label}: no change of state, nothing to post`);
  console.log(page);
  if (!dryRun)
    await getSlackClient().chat.postMessage({
      channel: slackChannelIds["#error-pulse"],
      text: page,
    });
}

function failingRows(directory: string): void {
  const artifacts = existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .flatMap((file) => {
          const parsed = TestTelemetryArtifact.safeParse(
            JSON.parse(readFileSync(path.join(directory, file), "utf8")),
          );
          return parsed.success ? [parsed.data] : [];
        })
    : [];
  const rows = mainE2eFailingRows(artifacts);
  console.log(`${rows.length} failing rows in ${artifacts.length} telemetry artifacts`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `failing-rows=${JSON.stringify(rows)}\n`);
}

if (isMainModule(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const directory = option("--dir");
  const workflow = option("--workflow");
  const done =
    command === "failing-rows" && directory
      ? Promise.resolve(failingRows(directory))
      : command === "alert" && workflow
        ? alert(workflow, option("--label") || "main e2e", rest.includes("--dry-run"))
        : Promise.reject(
            new Error(
              "usage: main-e2e-alert.ts failing-rows --dir <dir> | alert --workflow <name> [--label <label>] [--dry-run]",
            ),
          );
  done.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
