import { expect, test } from "vitest";
import {
  checkMainE2e,
  checkRealModel,
  mainE2eFailedJobs,
  mainE2eVerdict,
  suitePage,
  suiteVerdict,
  summaryRows,
  telemetryRows,
  type E2eMemory,
} from "./e2e.ts";
import { fakeDepot } from "./fake-depot.ts";

// Depot's job statuses: a job that hit its timeout is `cancelled` (a run cancelled by hand is left
// out before this), a job its deploy's failure skipped is `skipped`.
test.for<{ results: Record<string, string>; verdict: string | undefined }>([
  { results: { deploy: "finished", e2e: "finished", specs: "finished" }, verdict: "green" },
  { results: { deploy: "finished", e2e: "failed", specs: "finished" }, verdict: "red" },
  { results: { deploy: "failed", e2e: "skipped", specs: "skipped" }, verdict: "red" },
  { results: { deploy: "finished", e2e: "cancelled", specs: "finished" }, verdict: "red" },
  { results: { deploy: "finished", e2e: "skipped", specs: "finished" }, verdict: undefined },
  { results: {}, verdict: undefined },
])("jobs $results → $verdict", ({ results, verdict }) => {
  expect(mainE2eVerdict(results)).toBe(verdict);
});

test("a red page names each failed job, and each cancelled one as timed out", () => {
  expect(
    mainE2eFailedJobs({
      "Deploy preview": "finished",
      "E2E tests": "failed",
      "Browser specs": "cancelled",
    }),
  ).toEqual(["E2E tests", "Browser specs (timed out)"]);
});

const commit = { sha: "0123456789abcdef", subject: "Some <change> (#1)" };

test.for([
  { name: "green to red pages red", previous: "green", verdict: "red", tone: "red" },
  { name: "red to green pages green again", previous: "red", verdict: "green", tone: "green" },
  { name: "red and still red pages nothing", previous: "red", verdict: "red", tone: undefined },
  {
    name: "green and still green pages nothing",
    previous: "green",
    verdict: "green",
    tone: undefined,
  },
  // the first run: no suite has paged, and green is what the channel assumes
  { name: "a first green pages nothing", previous: undefined, verdict: "green", tone: undefined },
  { name: "a first red pages red", previous: undefined, verdict: "red", tone: "red" },
  { name: "no verdict pages nothing", previous: "green", verdict: undefined, tone: undefined },
] as const)("$name", ({ previous, verdict, tone }) => {
  const page = suitePage({
    suite: "main e2e",
    previous,
    verdict,
    commit,
    failedJobs: [],
    failingRows: [],
    testRun: false,
  });
  expect(page?.tone).toBe(tone);
});

test("a red page names the commit, the failed jobs and the failing rows, the first eight", () => {
  expect(
    suitePage({
      suite: "main e2e",
      previous: "green",
      verdict: "red",
      commit,
      failedJobs: ["E2E tests"],
      failingRows: Array.from({ length: 10 }, (_, i) => `row ${i}`),
      runUrl: "https://depot.dev/run",
      testRun: false,
    }),
  ).toEqual({
    tone: "red",
    headline: "main e2e red at `012345678` (Some &lt;change&gt; (#1))",
    details: [
      "failed: E2E tests",
      "failing rows: row 0; row 1; row 2; row 3; row 4; row 5; row 6; row 7; … and 2 more",
    ],
    link: "https://depot.dev/run",
  });
  expect(
    suitePage({
      suite: "slow e2e rows",
      previous: "red",
      verdict: "green",
      commit,
      failedJobs: [],
      failingRows: [],
      testRun: false,
    })?.headline,
  ).toBe("slow e2e rows green again at `012345678` (Some &lt;change&gt; (#1))");
});

test("a test page shows the suite's verdict whatever the channel was told", () => {
  const page = (previous: "red" | "green") =>
    suitePage({
      suite: "real-model e2e",
      previous,
      verdict: "green",
      commit,
      failedJobs: [],
      failingRows: [],
      testRun: true,
    });
  expect(page("green")).toMatchObject({ tone: "green" });
  expect(page("red")).toMatchObject({ tone: "green" });
});

// The rows tagged `slow` of main's E2E tests job, from its suite summary.
test.for<{ label: string; tests: SummaryTest[]; status?: "incomplete"; verdict: unknown }>([
  {
    label: "every slow row passed, the rest of the run skipped or failed",
    tests: [
      { name: "the careless facet", tags: ["slow"] },
      { name: "a plain row", failed: true },
      { name: "a skipped row", outcome: "skip" },
    ],
    verdict: { verdict: "green", failingRows: [] },
  },
  {
    label: "a failed slow row, named with its first failure",
    tests: [
      { name: "the careless facet", tags: ["slow"] },
      { name: "the chatty facet", tags: ["slow"], failed: true, error: "Error: resident" },
    ],
    verdict: { verdict: "red", failingRows: ["the chatty facet (Error: resident)"] },
  },
  {
    label: "no row tagged slow",
    tests: [{ name: "a plain row" }],
    verdict: { broken: "no row tagged slow" },
  },
  {
    label: "an incomplete run, a cancelled job's, which cannot say which rows never ran",
    tests: [{ name: "the careless facet", tags: ["slow"] }],
    status: "incomplete",
    verdict: { broken: "an incomplete run: CI run cancelled" },
  },
  {
    label: "a slow row not run",
    tests: [
      { name: "the careless facet", tags: ["slow"] },
      { name: "the chatty facet", tags: ["slow"], outcome: "skip" },
    ],
    verdict: { broken: "1 row(s) tagged slow did not run: the chatty facet" },
  },
])("tagged slow: $label", ({ tests, status, verdict }) => {
  expect(suiteVerdict(summaryRows(summary(tests, status)), { tag: "slow" })).toEqual(verdict);
});

test("a job that wrote no suite summary proves nothing", () => {
  expect(suiteVerdict(summaryRows(undefined), { tag: "slow" })).toEqual({
    broken: "no suite summary",
  });
});

// The `REAL:` rows of the real-model job, from its raw telemetry.
test.for<{ label: string; rows: TelemetryTest[]; status?: string; verdict: unknown }>([
  {
    label: "every REAL: row passed; the intercepted rows beside them are not the suite's",
    rows: [
      { name: "one turn through the default model, the provider intercepted", state: "failed" },
      { name: "REAL: one turn through the default model", state: "passed" },
    ],
    verdict: { verdict: "green", failingRows: [] },
  },
  {
    label: "a failed REAL: row",
    rows: [
      {
        name: "REAL: one turn through the default model",
        state: "failed",
        firstFailure: "Error: the AI Gateway's spend cap refused the model request",
      },
    ],
    verdict: {
      verdict: "red",
      failingRows: [
        "REAL: one turn through the default model (Error: the AI Gateway's spend cap refused the model request)",
      ],
    },
  },
  {
    label: "REAL: rows skipped (E2E_REAL_MODELS unset)",
    rows: [{ name: "REAL: one turn through the default model", state: "skipped" }],
    verdict: {
      broken: "1 row(s) titled REAL: did not run: REAL: one turn through the default model",
    },
  },
  {
    label: "a runner that did not finish",
    rows: [{ name: "REAL: one turn through the default model", state: "passed" }],
    status: "interrupted",
    verdict: { broken: "a test run ended interrupted" },
  },
])("titled REAL: $label", ({ rows, status, verdict }) => {
  expect(suiteVerdict(telemetryRows([telemetry(rows, status)]), { titlePrefix: "REAL:" })).toEqual(
    verdict,
  );
  expect(suiteVerdict(telemetryRows([]), { titlePrefix: "REAL:" })).toEqual({
    broken: "no test telemetry",
  });
});

test("main e2e is the newest settled push run: its jobs, the failing rows of both suites, its slow rows; a dispatch or a newer run in progress is not judged", async () => {
  const depot = fakeDepot({
    "Main OS e2e": [
      mainRun("old", "2026-09-26T19:00:00Z", {}),
      mainRun("newest", "2026-09-26T20:00:00Z", {
        e2e: "failed",
        e2eTests: [
          { name: "a plain row", failed: true },
          { name: "the careless facet", tags: ["slow"], failed: true, error: "Error: resident" },
        ],
        specsTests: [{ name: "sends a message", failed: true }],
      }),
      { ...mainRun("dispatched", "2026-09-26T20:30:00Z", {}), trigger: "workflow_dispatch" },
      { ...mainRun("running", "2026-09-26T20:40:00Z", {}), status: "running" },
    ],
  });

  const judged = await checkMainE2e({ depot, memory: empty, testRun: false, subject });

  expect(judged).toEqual({
    pages: [
      {
        tone: "red",
        headline: "main e2e red at `newestaaa` (the subject of new)",
        details: [
          "failed: E2E tests",
          "failing rows: a plain row; the careless facet; sends a message",
        ],
        link: "https://depot.dev/orgs/0p91s0lz49/workflows/wf-newest",
      },
      {
        tone: "red",
        headline: "slow e2e rows red at `newestaaa` (the subject of new)",
        details: ["failing rows: the careless facet (Error: resident)"],
        link: "https://depot.dev/orgs/0p91s0lz49/workflows/wf-newest",
      },
    ],
    memory: {
      suites: { "main e2e": "red", "slow e2e rows": "red" },
      judgedAt: { "Main OS e2e": "2026-09-26T20:00:00Z" },
    },
    failures: [],
  });

  // judged once: the next hour, with nothing newer, pages nothing and remembers the same
  const again = await checkMainE2e({ depot, memory: judged.memory, testRun: false, subject });
  expect(again).toEqual({ pages: [], memory: judged.memory, failures: [] });
});

test("a main run whose deploy failed is red, and its skipped suites judge no slow rows", async () => {
  const depot = fakeDepot({
    "Main OS e2e": [
      mainRun("deployfailed", "2026-09-26T20:00:00Z", {
        deploy: "failed",
        e2e: "skipped",
        specs: "skipped",
      }),
    ],
  });
  const judged = await checkMainE2e({
    depot,
    memory: { suites: { "main e2e": "green", "slow e2e rows": "green" }, judgedAt: {} },
    testRun: false,
    subject,
  });
  expect(judged).toMatchObject({
    pages: [
      {
        headline: "main e2e red at `deployfai` (the subject of dep)",
        details: ["failed: Deploy preview"],
      },
    ],
    memory: { suites: { "main e2e": "red", "slow e2e rows": "green" } },
  });
});

test("slow rows the run proves nothing about fail the health run and page nothing", async () => {
  const depot = fakeDepot({
    "Main OS e2e": [
      mainRun("noslow", "2026-09-26T20:00:00Z", { e2eTests: [{ name: "a plain row" }] }),
    ],
  });
  const judged = await checkMainE2e({ depot, memory: empty, testRun: false, subject });
  expect(judged).toMatchObject({
    pages: [],
    failures: ["slow e2e rows: broken probe: no row tagged slow"],
    memory: { suites: { "main e2e": "green", "slow e2e rows": undefined } },
  });
});

test("an E2E tests job that ran and kept no suite summary is a broken probe, judged once", async () => {
  const withoutRecords = mainRun("norecords", "2026-09-26T20:00:00Z", {});
  withoutRecords.artifacts = Object.fromEntries(
    Object.entries(withoutRecords.artifacts).filter(([name]) => !name.includes("preview-e2e")),
  );
  const depot = fakeDepot({ "Main OS e2e": [withoutRecords] });
  const judged = await checkMainE2e({ depot, memory: empty, testRun: false, subject });
  expect(judged).toMatchObject({
    pages: [],
    failures: ["slow e2e rows: broken probe: no suite summary"],
    memory: { judgedAt: { "Main OS e2e": "2026-09-26T20:00:00Z" } },
  });
});

test("real-model e2e is the newest scheduled or push run's REAL: rows, from its telemetry", async () => {
  const run = (id: string, createdAt: string, rows: TelemetryTest[], trigger = "schedule") => ({
    workflowId: `wf-${id}`,
    runId: `run-${id}`,
    status: "finished",
    trigger,
    sha: id.padEnd(40, "b"),
    createdAt,
    artifacts: {
      "os-real-model-telemetry": {
        "raw/vitest-os.json": JSON.stringify(telemetry(rows)),
      },
    },
  });
  const depot = fakeDepot({
    "OS real model": [
      run("pushed", "2026-09-26T05:47:00Z", [{ name: "REAL: a turn", state: "passed" }], "push"),
      run("daily", "2026-09-26T06:00:00Z", [
        { name: "REAL: a turn", state: "failed", firstFailure: "Error: spend cap" },
      ]),
    ],
  });
  const judged = await checkRealModel({
    depot,
    memory: { suites: { "real-model e2e": "green" }, judgedAt: {} },
    testRun: false,
    subject,
  });
  expect(judged).toEqual({
    pages: [
      {
        tone: "red",
        headline: "real-model e2e red at `dailybbbb` (the subject of dai)",
        details: ["failing rows: REAL: a turn (Error: spend cap)"],
        link: "https://depot.dev/orgs/0p91s0lz49/workflows/wf-daily",
      },
    ],
    memory: {
      suites: { "real-model e2e": "red" },
      judgedAt: { "OS real model": "2026-09-26T06:00:00Z" },
    },
    failures: [],
  });
});

const empty: E2eMemory = { suites: {}, judgedAt: {} };

/** A commit's subject, as GitHub would answer it. */
async function subject(sha: string) {
  return `the subject of ${sha.slice(0, 3)}`;
}

type SummaryTest = {
  name: string;
  tags?: string[];
  outcome?: "pass" | "fail" | "skip";
  failed?: boolean;
  error?: string;
};

/** A suite summary as the finalizer writes it (packages/shared/src/test-support/flake-suite-summary.ts). */
function summary(tests: SummaryTest[], status: "complete" | "incomplete" = "complete") {
  return {
    headSha: "abc",
    branch: "main",
    status,
    startedAt: "2026-09-26T20:00:00.000Z",
    finishedAt: "2026-09-26T20:05:00.000Z",
    testCount: tests.length,
    tests: tests.map(({ name, tags, outcome, failed = false, error }) => ({
      name,
      outcome: outcome || (failed ? "fail" : "pass"),
      durationMs: 1000,
      tags,
      failed,
      error,
    })),
    unknownFlakeCount: 0,
    failedCount: tests.filter((test) => test.failed).length,
    diagnostics: status === "incomplete" ? ["CI run cancelled"] : [],
    runUrl: "https://depot.dev/run",
  };
}

type TelemetryTest = { name: string; state: string; tags?: string[]; firstFailure?: string };

/** The parts of a runner's raw telemetry the real-model verdict reads. */
function telemetry(
  rows: TelemetryTest[],
  status = rows.some((row) => row.state === "failed") ? "failed" : "passed",
) {
  return {
    run: { status },
    tests: rows.map((row) => ({
      fullName: row.name,
      leafName: row.name,
      state: row.state,
      tags: row.tags || [],
      firstFailure: row.firstFailure,
    })),
  };
}

/** A settled push run of Main OS e2e: its jobs' statuses (finished unless named) and the suite
 *  summary each suite job's newest attempt uploaded with its flake records. */
function mainRun(
  id: string,
  createdAt: string,
  input: {
    deploy?: string;
    e2e?: string;
    specs?: string;
    e2eTests?: SummaryTest[];
    specsTests?: SummaryTest[];
  },
) {
  const job = (key: string, displayName: string, status = "finished") => ({
    jobKey: `main-os-e2e.yml:${key}`,
    jobDisplayName: displayName,
    status,
    attempts:
      status === "skipped"
        ? []
        : [
            { attemptId: `${id}-${key}-1`, attempt: 1 },
            { attemptId: `${id}-${key}-2`, attempt: 2 },
          ],
  });
  const records = (suite: string, key: string, tests: SummaryTest[]) => ({
    // the older attempt's records, which a retried job keeps beside the newest's
    [`flake-records-${suite}-attempt-${id}-${key}-1`]: {
      "suite-summary.json": JSON.stringify(summary([{ name: "an older attempt", failed: true }])),
    },
    [`flake-records-${suite}-attempt-${id}-${key}-2`]: {
      "suite-summary.json": JSON.stringify(summary(tests)),
    },
  });
  return {
    workflowId: `wf-${id}`,
    runId: `run-${id}`,
    status: "finished",
    trigger: "push",
    sha: id.padEnd(40, "a"),
    createdAt,
    jobs: [
      job("deploy", "Deploy preview", input.deploy),
      job("e2e", "E2E tests", input.e2e),
      job("specs", "Browser specs", input.specs),
      job("trace", "CI trace"),
    ],
    artifacts:
      input.deploy === "failed"
        ? {}
        : {
            ...records(
              "preview-e2e",
              "e2e",
              input.e2eTests || [{ name: "a slow row", tags: ["slow"] }],
            ),
            ...records("specs", "specs", input.specsTests || [{ name: "sends a message" }]),
          },
  };
}
