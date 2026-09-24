// scripts/ci/main-e2e-alert.ts — THE PAGE FOR MAIN'S E2E RUN (.depot/workflows/main-os-e2e.yml): every
// push to main redeploys main's preview in place and runs the e2e suite and the browser specs against
// it. This posts to #error-pulse only when main CHANGES state: once when it goes red (naming
// the failed jobs and the failing rows), once when it is green again. A red that stays red, and every
// green, post nothing. The last page in the channel is the state: nothing long-lived is kept anywhere
// else. The daily real-model suite pages the same way under its own name (scripts/ci/os-real-model-alert.ts).
//
//   pnpm tsx scripts/ci/main-e2e-alert.ts failing-rows --dir test-results/ci-telemetry/raw
//   NEEDS='${{ toJSON(needs) }}' pnpm tsx scripts/ci/main-e2e-alert.ts alert [--dry-run]
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { getSlackClient, onCallMention, slackChannelIds } from "./slack.ts";
import { testTelemetryFailed } from "./test-telemetry-completeness.ts";

export type MainE2eState = "green" | "red";

/** A suite's page's first words: how the next run finds the last one. `main e2e` unless named. */
const MAIN_E2E_SUITE = "main e2e";
const red = (suite: string) => `🔴 ${suite} red`;
const green = (suite: string) => `🟢 ${suite} green again`;

/** The run's verdict from its jobs' results: red when a job failed or was cancelled, green when every
 *  job succeeded, and none when nothing failed but not everything ran. A cancelled job hit its
 *  timeout (Depot ends a timed-out job by cancelling it): a run cancelled by hand never reaches the
 *  alert (main-os-e2e.yml). Pure. */
export function mainE2eVerdict(results: Record<string, string>): MainE2eState | undefined {
  const values = Object.values(results);
  if (values.some((result) => result === "failure" || result === "cancelled")) return "red";
  if (values.length > 0 && values.every((result) => result === "success")) return "green";
  return undefined;
}

/** The jobs a red page names: each failed one, and each cancelled one as timed out. Pure. */
export function mainE2eFailedJobs(results: Record<string, string>): string[] {
  return Object.entries(results).flatMap(([job, result]) =>
    result === "failure" ? [job] : result === "cancelled" ? [`${job} (timed out)`] : [],
  );
}

/** The failed rows of a run's telemetry artifacts (testTelemetryFailed). Pure. */
export function mainE2eFailingRows(artifacts: TestTelemetryArtifact[]): string[] {
  const rows = artifacts.flatMap((artifact) =>
    artifact.tests
      .filter(testTelemetryFailed)
      .map((test) => `${path.basename(test.moduleId)}: ${test.leafName || test.fullName}`),
  );
  return [...new Set(rows)];
}

/** The state the channel last announced: the newest of this suite's pages, else green. Pure. */
export function previousMainE2eState(
  messages: { text?: string; bot_id?: string }[],
  suite = MAIN_E2E_SUITE,
): MainE2eState {
  const last = messages.find(
    (message) =>
      message.bot_id &&
      (message.text?.startsWith(`${red(suite)} `) || message.text?.startsWith(`${green(suite)} `)),
  );
  return last?.text?.startsWith(`${red(suite)} `) ? "red" : "green";
}

/** The page for a change of state, or null. Pure. */
export function mainE2ePage(input: {
  suite?: string;
  previous: MainE2eState;
  verdict: MainE2eState | undefined;
  commitSha: string;
  commitSubject: string;
  failedJobs: string[];
  failingRows: string[];
  runUrl?: string;
}): string | null {
  if (!input.verdict || input.verdict === input.previous) return null;
  const suite = input.suite || MAIN_E2E_SUITE;
  const commit = `\`${input.commitSha.slice(0, 9)}\` (${input.commitSubject})`;
  const link = input.runUrl ? `<${input.runUrl}|the run>` : "";
  if (input.verdict === "green")
    return [`${green(suite)} at ${commit}`, link].filter(Boolean).join("\n");
  const shown = input.failingRows.slice(0, 8);
  return [
    `${red(suite)} at ${commit} ${onCallMention}`,
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

/** Page #error-pulse when `suite` changed state since its last page there: the channel's history
 *  (a week of it) is the only state kept. The page names this checkout's HEAD. */
export async function pageOnChangeOfState(input: {
  suite: string;
  verdict: MainE2eState | undefined;
  failedJobs: string[];
  failingRows: string[];
  dryRun: boolean;
}): Promise<void> {
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const commitSubject = execFileSync("git", ["log", "-1", "--format=%s"], {
    encoding: "utf8",
  }).trim();
  const slack = getSlackClient();
  const channel = slackChannelIds["#error-pulse"];
  const history = await slack.conversations.history({
    channel,
    oldest: String(Date.now() / 1000 - 7 * 86_400),
    limit: 999,
  });
  const previous = previousMainE2eState(history.messages || [], input.suite);
  const page = mainE2ePage({
    suite: input.suite,
    previous,
    verdict: input.verdict,
    commitSha,
    commitSubject,
    failedJobs: input.failedJobs,
    failingRows: input.failingRows,
    runUrl: process.env.DEPOT_JOB_URL,
  });
  console.log(JSON.stringify({ suite: input.suite, verdict: input.verdict, previous }));
  if (!page) return console.log(`${input.suite}: no change of state, nothing to post`);
  console.log(page);
  if (!input.dryRun) await slack.chat.postMessage({ channel, text: page });
}

async function alert(dryRun: boolean): Promise<void> {
  const needs = Needs.parse(JSON.parse(process.env.NEEDS || "{}"));
  const results = Object.fromEntries(
    Object.entries(needs).map(([job, need]) => [job, need.result]),
  );
  const failingRows = z
    .array(z.string())
    .parse(JSON.parse(needs.e2e?.outputs?.["failing-rows"] || "[]"));
  console.log(JSON.stringify({ results, failingRows }));
  await pageOnChangeOfState({
    suite: MAIN_E2E_SUITE,
    verdict: mainE2eVerdict(results),
    failedJobs: mainE2eFailedJobs(results),
    failingRows,
    dryRun,
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
  const directory = rest.includes("--dir") ? rest[rest.indexOf("--dir") + 1] : undefined;
  const done =
    command === "failing-rows" && directory
      ? Promise.resolve(failingRows(directory))
      : command === "alert"
        ? alert(rest.includes("--dry-run"))
        : Promise.reject(
            new Error("usage: main-e2e-alert.ts failing-rows --dir <dir> | alert [--dry-run]"),
          );
  done.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
