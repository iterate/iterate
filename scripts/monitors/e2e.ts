// scripts/monitors/e2e.ts — THE E2E CHECKS: main's e2e run and the suites that run beside it, each red
// or green, paged on a change of state. Main OS e2e's own page job pages its two suites as soon as its
// run has settled (./health.ts `mainE2e`); the hourly health job pages real-model e2e (./health.ts
// `run`).
//
//   main e2e        each push run of Main OS e2e (.depot/workflows/main-os-e2e.yml): red when a job
//                   failed or timed out (Depot cancels a timed-out job), green when Deploy preview,
//                   E2E tests and Browser specs all passed. Its page names the failed jobs and the
//                   failing rows.
//   slow e2e rows   the rows tagged `slow` in that run's E2E tests job, which most PRs skip
//                   (docs/testing.md#slow-rows): a suite of their own, so a slow row that breaks while
//                   main is already red still pages.
//   real-model e2e  the `REAL:` rows of each settled scheduled or push run of OS real model
//                   (.depot/workflows/os-real-model.yml).
//
// Each run is judged once, oldest first, so a page names the run where its suite changed state; a
// first run judges only the newest. The verdicts come from Depot's records: the jobs' results, and
// the rows from what the jobs kept, the suite summary beside each e2e job's flake records in its
// test results (`main-os-test-artifacts-attempt-<id>`) and the real-model job's telemetry
// (`os-real-model-telemetry`). A suite whose run proves nothing (no results, a runner that did not
// finish, one of its rows not run) is a BROKEN PROBE. Real-model e2e's pages nothing and fails the
// health job. Slow e2e rows' is a state of its own, `broken`, paged ⚪ on its change of state like a
// verdict, and fails nothing: Main OS e2e's page job reports on the commit its run tested, where red
// reads as "this commit broke main e2e", and main e2e's verdict comes from the jobs whatever the slow
// rows' summary says. A run a person cancelled, or a push a newer one replaced in the queue, is left
// out.
import { z } from "zod";
import { FlakeSuiteSummary } from "@iterate-com/shared/test-support/flake-suite-summary";
import {
  depotWorkflowUrl,
  settledWorkflows,
  workflowArtifact,
  type DepotApi,
  type SettledWorkflow,
} from "../ci/depot.ts";
import { testTelemetryFailed } from "../ci/test-telemetry-completeness.ts";
import { commitText, type Page } from "./page.ts";

/** Main OS e2e's suites, which its own page job pages; the health job pages real-model e2e. Both
 *  tuples are `as const` so that z.enum and the pages' `suite` take their names as literals. */
export const MAIN_SUITES = ["main e2e", "slow e2e rows"] as const;
const SUITES = [...MAIN_SUITES, "real-model e2e"] as const;
const Verdict = z.enum(["green", "red"]);
type Verdict = z.infer<typeof Verdict>;
/** A suite's state as the channel was last told it: its verdict, or `broken` for a run that proved
 *  nothing about it (slow e2e rows only). */
const SuiteState = z.enum(["green", "red", "broken"]);
export type SuiteState = z.infer<typeof SuiteState>;

/** What the checks remember between runs, in the state of the job that pages them (./health.ts):
 *  each suite's last state, and the newest run of each workflow judged. */
export const E2eMemory = z.object({
  suites: z.partialRecord(z.enum(SUITES), SuiteState),
  judgedAt: z.partialRecord(z.enum(["Main OS e2e", "OS real model"]), z.iso.datetime()),
});
export type E2eMemory = z.infer<typeof E2eMemory>;

/** What the real-model check reads: the runs of this workflow (its `name:`), and the raw telemetry
 *  under `raw/` in the artifact each keeps. */
export const realModelTelemetry = {
  workflow: "OS real model",
  artifact: "os-real-model-telemetry",
} as const;

/** The Main OS e2e jobs whose results are main's verdict, by job key; the trace only reports. */
const MAIN_JOBS = ["main-os-e2e.yml:deploy", "main-os-e2e.yml:e2e", "main-os-e2e.yml:specs"];

/** The run's verdict from its jobs' results: red when a job failed or was cancelled, green when every
 *  job succeeded, and none when nothing failed but not everything ran. A cancelled job hit its
 *  timeout: Depot ends a timed-out job by cancelling it, and a run cancelled by hand is left out
 *  before this. Pure. */
export function mainE2eVerdict(results: Record<string, string>): Verdict | undefined {
  const values = Object.values(results);
  if (values.some((result) => result === "failed" || result === "cancelled")) return "red";
  if (values.length > 0 && values.every((result) => result === "finished")) return "green";
  return undefined;
}

/** The jobs a red page names: each failed one, and each cancelled one as timed out. Pure. */
export function mainE2eFailedJobs(results: Record<string, string>): string[] {
  return Object.entries(results).flatMap(([job, result]) =>
    result === "failed" ? [job] : result === "cancelled" ? [`${job} (timed out)`] : [],
  );
}

/** One row of a suite's run, from a suite summary or a runner's telemetry. */
type Row = { name: string; tags: string[]; ran: boolean; failed: boolean; error?: string };

/** A suite's rows: those tagged `tag`, or those whose title begins with `titlePrefix`. */
export type SuiteRows = { tag: string } | { titlePrefix: string };

/** A suite's verdict from a run's rows: green when every one of its rows passed (on its retry too),
 *  red naming each failed row with its first failure, or broken when the run proves nothing: no
 *  results, none of its rows, or one of them not run. Rows outside the suite are not its verdict,
 *  whatever their state. Pure. */
export function suiteVerdict(
  rows: Row[] | { broken: string },
  select: SuiteRows,
): { verdict: Verdict; failingRows: string[] } | { broken: string } {
  if ("broken" in rows) return rows;
  const which = "tag" in select ? `tagged ${select.tag}` : `titled ${select.titlePrefix}`;
  const suite = rows.filter((row) =>
    "tag" in select ? row.tags.includes(select.tag) : row.name.startsWith(select.titlePrefix),
  );
  if (suite.length === 0) return { broken: `no row ${which}` };
  const unrun = suite.filter((row) => !row.ran);
  if (unrun.length > 0)
    return { broken: `${unrun.length} row(s) ${which} did not run: ${unrun[0]!.name}` };
  const failingRows = [
    ...new Set(
      suite
        .filter((row) => row.failed)
        .map((row) => (row.error ? `${row.name} (${row.error})` : row.name)),
    ),
  ];
  return { verdict: failingRows.length > 0 ? "red" : "green", failingRows };
}

/** A suite summary's rows (the e2e jobs'), or why it proves nothing: none, or an incomplete one,
 *  whose rows cannot say which rows never ran (a cancelled job's, a runner cut short). Pure. */
export function summaryRows(
  summary: z.infer<typeof FlakeSuiteSummary> | undefined,
): Row[] | { broken: string } {
  if (!summary) return { broken: "no suite summary" };
  if (summary.status === "incomplete")
    return { broken: `an incomplete run: ${summary.diagnostics[0] || "no diagnostic"}` };
  return summary.tests.map((test) => ({
    name: test.name,
    tags: test.tags || [],
    ran: test.outcome !== "skip",
    failed: test.failed,
    error: test.error,
  }));
}

/** The parts of a runner's raw telemetry (packages/shared/src/test-support/ci-telemetry.ts) the
 *  real-model suite's verdict reads. */
const RawTelemetry = z.object({
  run: z.object({ status: z.string() }),
  tests: z.array(
    z.object({
      fullName: z.string(),
      leafName: z.string().optional(),
      state: z.string(),
      outcome: z.string().optional(),
      tags: z.array(z.string()),
      firstFailure: z.string().optional(),
    }),
  ),
});

/** The rows of a run's raw telemetry (the real-model job's), or why it proves nothing: no telemetry,
 *  or a runner that did not finish. Pure. */
export function telemetryRows(
  artifacts: z.infer<typeof RawTelemetry>[],
): Row[] | { broken: string } {
  if (artifacts.length === 0) return { broken: "no test telemetry" };
  const unfinished = artifacts.find(
    (artifact) => !["passed", "failed"].includes(artifact.run.status),
  );
  if (unfinished) return { broken: `a test run ended ${unfinished.run.status}` };
  return artifacts.flatMap((artifact) =>
    artifact.tests.map((test) => {
      const failed = testTelemetryFailed(test);
      return {
        name: test.leafName || test.fullName,
        tags: test.tags,
        ran: test.state === "passed" || failed,
        failed,
        error: test.firstFailure,
      };
    }),
  );
}

/** The page for a change of state, or null; on a test page, the suite's state whatever it was: ⚪
 *  `broken` naming why its run proved nothing. Pure. */
export function suitePage(input: {
  suite: (typeof SUITES)[number];
  previous: SuiteState | undefined;
  verdict: SuiteState | undefined;
  commit: { sha: string; subject: string };
  failedJobs: string[];
  failingRows: string[];
  /** Why the run proved nothing, for a `broken` verdict. */
  broken?: string;
  runUrl?: string;
  testRun: boolean;
}): Page | null {
  if (!input.verdict) return null;
  if (!input.testRun && input.verdict === (input.previous || "green")) return null;
  const commit = commitText(input.commit);
  if (input.verdict === "broken")
    return {
      tone: "none",
      headline: `${input.suite} unjudged at ${commit}`,
      details: [`broken probe: ${input.broken}`],
      link: input.runUrl,
    };
  if (input.verdict === "green")
    return {
      tone: "green",
      headline: `${input.suite} green${input.previous === "red" ? " again" : ""} at ${commit}`,
      details: [],
      link: input.runUrl,
    };
  const shown = input.failingRows.slice(0, 8);
  return {
    tone: "red",
    headline: `${input.suite} red at ${commit}`,
    details: [
      ...(input.failedJobs.length > 0 ? [`failed: ${input.failedJobs.join(", ")}`] : []),
      ...(shown.length > 0
        ? [
            `failing rows: ${shown.join("; ")}${input.failingRows.length > shown.length ? `; … and ${input.failingRows.length - shown.length} more` : ""}`,
          ]
        : []),
    ],
    link: input.runUrl,
  };
}

// Connect's JSON omits empty lists and strings (https://protobuf.dev/programming-guides/json/).
const WorkflowJobs = z.object({
  jobs: z
    .array(
      z.object({
        jobKey: z.string(),
        jobDisplayName: z.string().default(""),
        status: z.string(),
        attempts: z.array(z.object({ attemptId: z.string(), attempt: z.number() })).default([]),
      }),
    )
    .default([]),
});

/** What the main e2e checks read beside the jobs' results: each suite job's test results, per job
 *  attempt (docs/depot-ci.md#artifacts-per-job-attempt), and the suite summary beside its flake
 *  records in them (scripts/ci/flake-suite-summary.ts). */
export const mainE2eRecords = {
  workflow: "Main OS e2e",
  jobs: [
    { jobKey: "main-os-e2e.yml:e2e", suite: "preview-e2e" },
    { jobKey: "main-os-e2e.yml:specs", suite: "specs" },
  ],
  artifact: (attemptId: string) => `main-os-test-artifacts-attempt-${attemptId}`,
  file: (suite: string) => `flake-records/${suite}/suite-summary.json`,
} as const;

/** Judge the settled runs of `workflow` oldest first, then `current`, the run whose jobs have just
 *  ended, each against the suites' verdicts the one before it left, so a page names the run where
 *  its suite changed state: every run since the newest `memory` judged, or, on a first run (nothing
 *  judged yet) and a test run, only the newest. A `current` that is not newer than the newest judged
 *  (a re-run keeps its creation time) is not judged again. */
async function judgeEachRun(
  input: { depot: DepotApi; memory: E2eMemory; testRun: boolean; current?: SettledWorkflow },
  workflow: { name: keyof E2eMemory["judgedAt"]; triggers: string[] },
  judge: (
    run: SettledWorkflow,
    suites: E2eMemory["suites"],
  ) => Promise<{ pages: Page[]; suites: E2eMemory["suites"]; failures: string[] }>,
) {
  const after = input.testRun ? undefined : input.memory.judgedAt[workflow.name];
  const { current } = input;
  const settled = await settledWorkflows(input.depot, { ...workflow, after });
  const runs = [
    ...settled.filter((run) => run.workflowId !== current?.workflowId),
    ...(current && (!after || current.createdAt > after) ? [current] : []),
  ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  let memory = input.memory;
  const pages: Page[] = [];
  const failures: string[] = [];
  for (const run of after ? runs : runs.slice(-1)) {
    const judged = await judge(run, memory.suites);
    memory = {
      suites: judged.suites,
      judgedAt: { ...memory.judgedAt, [workflow.name]: run.createdAt },
    };
    pages.push(...judged.pages);
    failures.push(...judged.failures);
  }
  return { pages, memory, failures };
}

/** Judge each push run of Main OS e2e that `memory` has not, the settled ones and then `current`
 *  (`judgeEachRun`): main e2e from its jobs, and its slow rows from its E2E tests job's suite
 *  summary, which a suite whose deploy did not finish never wrote (and `broken` when the E2E tests
 *  job ran but its summary proves nothing about them). When Depot still lists a deploy or
 *  suite job of `current` as queued or running, that run has not settled, and judging it throws. An
 *  older run Depot lists as finished or failed with such a job (one Depot failed before its jobs
 *  started) has no verdict, and the state moves past it. */
export async function checkMainE2e(input: {
  depot: DepotApi;
  memory: E2eMemory;
  testRun: boolean;
  subject: (sha: string) => Promise<string>;
  /** The run whose page job this is (main-os-e2e.yml `alert`): its deploy and suite jobs have ended,
   *  but Depot lists it as running until the page job ends. */
  current?: SettledWorkflow;
}) {
  return judgeEachRun(
    input,
    { name: mainE2eRecords.workflow, triggers: ["push"] },
    async (run, suites) => {
      const { jobs } = WorkflowJobs.parse(
        await input.depot("GetWorkflow", { workflowId: run.workflowId }),
      );
      const mainJobs = jobs.filter((job) => MAIN_JOBS.includes(job.jobKey));
      const unsettled = mainJobs.find((job) => ["queued", "running"].includes(job.status));
      if (unsettled && run.workflowId === input.current?.workflowId)
        throw new Error(
          `${run.workflowId} has not settled: Depot lists ${unsettled.jobKey} as ${unsettled.status}`,
        );
      // A deploy that did not finish is the run's verdict alone: the suites start beside it and
      // fail waiting for it (main-os-e2e.yml), with no preview to test, or were skipped behind it.
      const deploy = mainJobs.find((job) => job.jobKey === "main-os-e2e.yml:deploy");
      const judgedJobs = deploy && deploy.status !== "finished" ? [deploy] : mainJobs;
      const results = Object.fromEntries(
        judgedJobs.map((job) => [job.jobDisplayName || job.jobKey, job.status]),
      );
      // A workflow Depot failed before any job ran has no job to name.
      const verdict: Verdict | undefined = mainJobs.length === 0 ? "red" : mainE2eVerdict(results);
      // A job that ran (an attempt) and left no summary proves nothing; one that never had a preview
      // judges nothing.
      const summary = async ({ jobKey, suite }: (typeof mainE2eRecords.jobs)[number]) => {
        const newest = judgedJobs
          .find((job) => job.jobKey === jobKey)
          ?.attempts.toSorted((a, b) => a.attempt - b.attempt)
          .at(-1);
        if (!newest) return { ran: false as const };
        const artifact = mainE2eRecords.artifact(newest.attemptId);
        const bytes = (
          await workflowArtifact(input.depot, run, (name) => name === artifact, "first")
        )?.[mainE2eRecords.file(suite)];
        return {
          ran: true as const,
          summary: bytes && FlakeSuiteSummary.parse(JSON.parse(new TextDecoder().decode(bytes))),
        };
      };
      const [e2e, specs] = await Promise.all([
        summary(mainE2eRecords.jobs[0]),
        summary(mainE2eRecords.jobs[1]),
      ]);
      const failingRows = [e2e, specs].flatMap((job) =>
        job.ran && job.summary
          ? job.summary.tests.filter((test) => test.failed).map((test) => test.name)
          : [],
      );
      const slow = e2e.ran ? suiteVerdict(summaryRows(e2e.summary), { tag: "slow" }) : undefined;
      const slowState = slow && ("broken" in slow ? "broken" : slow.verdict);
      console.log(JSON.stringify({ run: run.workflowId, results, verdict, failingRows, slow }));
      const commit = { sha: run.sha, subject: await input.subject(run.sha) };
      const pages = [
        suitePage({
          suite: "main e2e",
          previous: suites["main e2e"],
          verdict,
          commit,
          failedJobs: mainJobs.length === 0 ? ["the workflow"] : mainE2eFailedJobs(results),
          failingRows,
          runUrl: depotWorkflowUrl(run.workflowId),
          testRun: input.testRun,
        }),
        slow &&
          suitePage({
            suite: "slow e2e rows",
            previous: suites["slow e2e rows"],
            verdict: slowState,
            commit,
            failedJobs: [],
            failingRows: "broken" in slow ? [] : slow.failingRows,
            broken: "broken" in slow ? slow.broken : undefined,
            runUrl: depotWorkflowUrl(run.workflowId),
            testRun: input.testRun,
          }),
      ].filter((page) => !!page);
      return {
        pages,
        // a run whose verdict is none leaves the suite's last one standing
        suites: {
          ...suites,
          "main e2e": verdict || suites["main e2e"],
          "slow e2e rows": slowState || suites["slow e2e rows"],
        },
        failures: [],
      };
    },
  );
}

/** Judge the `REAL:` rows of each settled scheduled or push run of OS real model that `memory` has
 *  not (`judgeEachRun`), from its job's telemetry. */
export async function checkRealModel(input: {
  depot: DepotApi;
  memory: E2eMemory;
  testRun: boolean;
  subject: (sha: string) => Promise<string>;
}) {
  return judgeEachRun(
    input,
    { name: realModelTelemetry.workflow, triggers: ["schedule", "push"] },
    async (run, suites) => {
      const files =
        (await workflowArtifact(
          input.depot,
          run,
          (name) => name === realModelTelemetry.artifact,
          "first",
        )) ?? {};
      const artifacts = Object.entries(files)
        .filter(([path]) => /^raw\/.+\.json$/u.test(path))
        .map(([, bytes]) => RawTelemetry.parse(JSON.parse(new TextDecoder().decode(bytes))));
      const outcome = suiteVerdict(telemetryRows(artifacts), { titlePrefix: "REAL:" });
      console.log(JSON.stringify({ run: run.workflowId, outcome }));
      if ("broken" in outcome)
        return {
          pages: [],
          suites,
          failures: [`real-model e2e: broken probe: ${outcome.broken}`],
        };
      const page = suitePage({
        suite: "real-model e2e",
        previous: suites["real-model e2e"],
        verdict: outcome.verdict,
        commit: { sha: run.sha, subject: await input.subject(run.sha) },
        failedJobs: [],
        failingRows: outcome.failingRows,
        runUrl: depotWorkflowUrl(run.workflowId),
        testRun: input.testRun,
      });
      return {
        pages: page ? [page] : [],
        suites: { ...suites, "real-model e2e": outcome.verdict },
        failures: [],
      };
    },
  );
}
