// scripts/ci/main-e2e-alert.ts — THE PAGES FOR MAIN'S E2E RUN (.depot/workflows/main-os-e2e.yml): every
// push to main deploys the pushed commit as `main-<sha7>` and runs the e2e suite and the browser specs
// against it. This posts to #error-pulse only when main CHANGES state: once when it goes red (naming
// the failed jobs and the failing rows), once when it is green again. A red that stays red, and every
// green, post nothing. The last page in the channel is the state: nothing long-lived is kept anywhere
// else.
//
// A SUITE, a run's rows tagged `--tag` or titled `--title-prefix`, pages the same way under its own
// name, so a regression in it pages even while main is already red: the rows tagged `slow` of main's
// own e2e run ("slow e2e rows", which most PRs skip: docs/testing.md#slow-rows), judged in the e2e job
// and paged by `alert`, and the `REAL:` rows of the daily real-model suite ("real-model e2e",
// os-real-model.yml), which `judge` judges and pages in its own run. A suite whose run proves nothing
// (no telemetry, a runner that did not finish, one of its rows not run) is a BROKEN PROBE: it fails
// the job that judges it and pages nothing.
//
// Only a run on main pages (`--ref`, the run's git ref): the channel's last page is main's state, and
// a run off main, or a dry run, prints the page it would post.
//
//   pnpm tsx scripts/ci/main-e2e-alert.ts failing-rows --dir <telemetry> [--suite <name> --tag <tag>]
//   NEEDS='${{ toJSON(needs) }}' pnpm tsx scripts/ci/main-e2e-alert.ts alert --ref <ref> [--dry-run]
//   pnpm tsx scripts/ci/main-e2e-alert.ts judge --dir <telemetry> --suite <name> (--tag <tag> | --title-prefix <prefix>) --ref <ref> [--dry-run]
import { appendFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type {
  TestTelemetryArtifact,
  TestTelemetryRecord,
} from "@iterate-com/shared/test-support/ci-telemetry";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { getSlackClient, onCallMention, slackChannelIds } from "./slack.ts";
import { testTelemetryFailed } from "./test-telemetry-completeness.ts";
import { loadTestTelemetryArtifacts } from "./upload-test-telemetry.ts";

const MainE2eState = z.enum(["green", "red"]);
export type MainE2eState = z.infer<typeof MainE2eState>;

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

const rowName = (test: TestTelemetryRecord) =>
  `${path.basename(test.moduleId)}: ${test.leafName || test.fullName}`;

/** The failed rows of a run's telemetry artifacts (testTelemetryFailed). Pure. */
export function mainE2eFailingRows(artifacts: TestTelemetryArtifact[]): string[] {
  const rows = artifacts.flatMap((artifact) =>
    artifact.tests.filter(testTelemetryFailed).map(rowName),
  );
  return [...new Set(rows)];
}

/** A suite's rows: those tagged `tag`, or those whose title begins with `titlePrefix`. */
export type SuiteRows = { tag: string } | { titlePrefix: string };

/** What a suite's run proved: its verdict and failing rows, or why it proved nothing. */
type SuiteOutcome = { verdict: MainE2eState; failingRows: string[] } | { broken: string };

/** A suite's verdict from a run's telemetry: green when every one of its rows passed (on its retry
 *  too), red naming each failed row with its first failure, or broken when the run proves nothing: no
 *  telemetry, a runner that did not finish, none of its rows, or one of them not run. Rows outside
 *  the suite are not its verdict, whatever their state. Pure. */
export function suiteVerdict(artifacts: TestTelemetryArtifact[], rows: SuiteRows): SuiteOutcome {
  const which = "tag" in rows ? `tagged ${rows.tag}` : `titled ${rows.titlePrefix}`;
  if (artifacts.length === 0) return { broken: "no test telemetry" };
  const unfinished = artifacts.find(
    (artifact) => !["passed", "failed"].includes(artifact.run.status),
  );
  if (unfinished) return { broken: `a test run ended ${unfinished.run.status}` };
  const tests = artifacts
    .flatMap((artifact) => artifact.tests)
    .filter((test) =>
      "tag" in rows
        ? test.tags.includes(rows.tag)
        : (test.leafName || test.fullName).startsWith(rows.titlePrefix),
    );
  if (tests.length === 0) return { broken: `no row ${which}` };
  const unrun = tests.filter((test) => test.state !== "passed" && !testTelemetryFailed(test));
  if (unrun.length > 0)
    return {
      broken: `${unrun.length} row(s) ${which} did not run (${unrun[0]!.state}): ${rowName(unrun[0]!)}`,
    };
  const failingRows = [
    ...new Set(
      tests
        .filter(testTelemetryFailed)
        .map((test) =>
          test.firstFailure ? `${rowName(test)} (${test.firstFailure})` : rowName(test),
        ),
    ),
  ];
  return { verdict: failingRows.length > 0 ? "red" : "green", failingRows };
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

/** The page for a change of state, or null. A suite's page names no jobs. Pure. */
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
    input.failedJobs.length > 0 && `• failed: ${input.failedJobs.join(", ")}`,
    shown.length > 0 &&
      `• failing rows: ${shown.join("; ")}${input.failingRows.length > shown.length ? `; … and ${input.failingRows.length - shown.length} more` : ""}`,
    link,
  ]
    .filter(Boolean)
    .join("\n");
}

/** `${{ toJSON(needs) }}`: each job's result, the test jobs' failing rows, and the verdict of the
 *  suite a job judged (`failing-rows --suite`). */
const Needs = z.record(
  z.string(),
  z.object({ result: z.string(), outputs: z.record(z.string(), z.string()).optional() }),
);
const JudgedSuite = z.union([
  z.object({ suite: z.string(), verdict: MainE2eState, failingRows: z.array(z.string()) }),
  z.object({ suite: z.string(), broken: z.string() }),
]);

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

/** A judged suite's page on its change of state; a broken probe throws and pages nothing. */
async function pageSuite(judged: z.infer<typeof JudgedSuite>, dryRun: boolean): Promise<void> {
  console.log(JSON.stringify(judged));
  if ("broken" in judged) throw new Error(`${judged.suite}: broken probe: ${judged.broken}`);
  await pageOnChangeOfState({ ...judged, failedJobs: [], dryRun });
}

/** Page #error-pulse when main changed state, from the run's jobs (NEEDS, `toJSON(needs)`), and
 *  each judged suite a job named in its `suite-verdict` output. */
export async function alert(options: {
  /** The run's git ref: only refs/heads/main pages. */
  ref: string;
  /** Print the page instead of posting it. */
  dryRun?: boolean;
}): Promise<void> {
  const dryRun = runIsDry(options);
  const needs = Needs.parse(JSON.parse(process.env.NEEDS || "{}"));
  const results = Object.fromEntries(
    Object.entries(needs).map(([job, need]) => [job, need.result]),
  );
  const failingRows = Object.values(needs).flatMap((need) =>
    z.array(z.string()).parse(JSON.parse(need.outputs?.["failing-rows"] || "[]")),
  );
  console.log(JSON.stringify({ results, failingRows }));
  await pageOnChangeOfState({
    suite: MAIN_E2E_SUITE,
    verdict: mainE2eVerdict(results),
    failedJobs: mainE2eFailedJobs(results),
    failingRows,
    dryRun,
  });
  // A job the deploy's failure skipped judged nothing: main's own page names that.
  for (const need of Object.values(needs))
    if (need.outputs?.["suite-verdict"])
      await pageSuite(JudgedSuite.parse(JSON.parse(need.outputs["suite-verdict"])), dryRun);
}

/** The failing rows of a job's telemetry, and the verdict of the suite it judges (`--suite` with
 *  `--tag`, both or neither), as the job's GITHUB_OUTPUT. */
export async function failingRows(options: {
  /** The job's test telemetry directory. */
  dir: string;
  suite?: string;
  tag?: string;
}) {
  const directory = options.dir;
  const suite = suiteOf(options);
  if (Boolean(options.suite) !== Boolean(suite)) throw new Error(usage);
  const artifacts = (await loadTestTelemetryArtifacts(directory)).map(({ artifact }) => artifact);
  const failing = mainE2eFailingRows(artifacts);
  console.log(`${failing.length} failing rows in ${artifacts.length} telemetry artifacts`);
  const judged = suite && { suite: suite.suite, ...suiteVerdict(artifacts, suite.rows) };
  if (judged) console.log(JSON.stringify(judged));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `failing-rows=${JSON.stringify(failing)}\n${judged ? `suite-verdict=${JSON.stringify(judged)}\n` : ""}`,
    );
}

/** Judge a suite's rows (`--tag` or `--title-prefix`) in a run's telemetry and page
 *  #error-pulse on its change of state. */
export async function judge(options: {
  /** The run's test telemetry directory. */
  dir: string;
  suite: string;
  tag?: string;
  titlePrefix?: string;
  /** The run's git ref: only refs/heads/main pages. */
  ref: string;
  /** Print the page instead of posting it. */
  dryRun?: boolean;
}) {
  const suite = suiteOf(options);
  if (!suite) throw new Error(usage);
  const dryRun = runIsDry(options);
  const artifacts = (await loadTestTelemetryArtifacts(options.dir)).map(({ artifact }) => artifact);
  await pageSuite({ suite: suite.suite, ...suiteVerdict(artifacts, suite.rows) }, dryRun);
}

/** A suite is named exactly when its rows are. */
function suiteOf(options: { suite?: string; tag?: string; titlePrefix?: string }) {
  const rows: SuiteRows | undefined = options.tag
    ? { tag: options.tag }
    : options.titlePrefix
      ? { titlePrefix: options.titlePrefix }
      : undefined;
  return options.suite && rows ? { suite: options.suite, rows } : undefined;
}

const runIsDry = (options: { ref: string; dryRun?: boolean }) =>
  Boolean(options.dryRun) || options.ref !== "refs/heads/main";

const usage =
  "usage: main-e2e-alert.ts failing-rows --dir <dir> [--suite <name> --tag <tag>] | alert --ref <ref> [--dry-run] | judge --dir <dir> --suite <name> (--tag <tag> | --title-prefix <prefix>) --ref <ref> [--dry-run]";

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "main-e2e-alert" }).run();
