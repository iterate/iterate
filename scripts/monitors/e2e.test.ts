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
import { fakeDepot, mainRun, summary, type SummaryTest } from "./fake-depot.ts";

// Depot's job statuses: a job that hit its timeout is `cancelled` (a run cancelled by hand is left
// out before this), a job skipped by its `if` or its needs is `skipped`.
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

test("a first run judges only the newest settled push run of main e2e: its jobs, the failing rows of both suites, its slow rows; a dispatch or a newer run in progress is not judged", async () => {
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

test("each run since the last judged pages where its suite changed state: green, red, red again pages red at the first red run", async () => {
  const depot = fakeDepot({
    "Main OS e2e": [
      mainRun("judged", "2026-09-26T19:00:00Z", {}),
      mainRun("green", "2026-09-26T19:05:00Z", {}),
      mainRun("firstred", "2026-09-26T19:30:00Z", {
        e2e: "failed",
        e2eTests: [
          { name: "a slow row", tags: ["slow"] },
          { name: "a plain row", failed: true },
        ],
      }),
      mainRun("stillred", "2026-09-26T19:55:00Z", {
        e2e: "failed",
        e2eTests: [
          { name: "a slow row", tags: ["slow"], failed: true },
          { name: "a plain row", failed: true },
        ],
      }),
    ],
  });

  const judged = await checkMainE2e({
    depot,
    memory: {
      suites: { "main e2e": "green", "slow e2e rows": "green" },
      judgedAt: { "Main OS e2e": "2026-09-26T19:00:00Z" },
    },
    testRun: false,
    subject,
  });

  expect(judged).toMatchObject({
    pages: [
      {
        tone: "red",
        headline: "main e2e red at `firstreda` (the subject of fir)",
        link: "https://depot.dev/orgs/0p91s0lz49/workflows/wf-firstred",
      },
      {
        tone: "red",
        headline: "slow e2e rows red at `stillreda` (the subject of sti)",
        link: "https://depot.dev/orgs/0p91s0lz49/workflows/wf-stillred",
      },
    ],
    memory: {
      suites: { "main e2e": "red", "slow e2e rows": "red" },
      judgedAt: { "Main OS e2e": "2026-09-26T19:55:00Z" },
    },
    failures: [],
  });
  expect(judged.pages).toHaveLength(2);
});

test("the run whose page job this is is judged last, after each settled run the state has not: a run whose page was lost still pages where it turned", async () => {
  const current = mainRun("current", "2026-09-26T20:00:00Z", { running: true });
  const depot = fakeDepot({
    "Main OS e2e": [
      mainRun("judged", "2026-09-26T19:00:00Z", {}),
      // its page job could not post, so it kept no state
      mainRun("lost", "2026-09-26T19:30:00Z", {
        e2e: "failed",
        e2eTests: [
          { name: "a slow row", tags: ["slow"] },
          { name: "a plain row", failed: true },
        ],
      }),
      current,
    ],
  });

  const judged = await checkMainE2e({
    depot,
    memory: {
      suites: { "main e2e": "green", "slow e2e rows": "green" },
      judgedAt: { "Main OS e2e": "2026-09-26T19:00:00Z" },
    },
    testRun: false,
    subject,
    current: settled(current),
  });

  expect(judged).toEqual({
    pages: [
      {
        tone: "red",
        headline: "main e2e red at `lostaaaaa` (the subject of los)",
        details: ["failed: E2E tests", "failing rows: a plain row"],
        link: "https://depot.dev/orgs/0p91s0lz49/workflows/wf-lost",
      },
      {
        tone: "green",
        headline: "main e2e green again at `currentaa` (the subject of cur)",
        details: [],
        link: "https://depot.dev/orgs/0p91s0lz49/workflows/wf-current",
      },
    ],
    memory: {
      suites: { "main e2e": "green", "slow e2e rows": "green" },
      judgedAt: { "Main OS e2e": "2026-09-26T20:00:00Z" },
    },
    failures: [],
  });
});

test("a first run judges only the run whose page job this is", async () => {
  const current = mainRun("current", "2026-09-26T20:00:00Z", {
    specs: "failed",
    specsTests: [{ name: "sends a message", failed: true }],
    running: true,
  });
  const depot = fakeDepot({
    "Main OS e2e": [mainRun("older", "2026-09-26T19:00:00Z", { e2e: "failed" }), current],
  });
  const judged = await checkMainE2e({
    depot,
    memory: empty,
    testRun: false,
    subject,
    current: settled(current),
  });
  expect(judged).toMatchObject({
    pages: [{ tone: "red", headline: "main e2e red at `currentaa` (the subject of cur)" }],
    memory: {
      suites: { "main e2e": "red", "slow e2e rows": "green" },
      judgedAt: { "Main OS e2e": "2026-09-26T20:00:00Z" },
    },
  });
  expect(judged.pages).toHaveLength(1);
});

test("a re-run, which keeps its creation time, is not judged again", async () => {
  const rerun = mainRun("rerun", "2026-09-26T19:00:00Z", { running: true });
  const depot = fakeDepot({
    "Main OS e2e": [rerun, mainRun("newer", "2026-09-26T19:30:00Z", {})],
  });
  const memory: E2eMemory = {
    suites: { "main e2e": "red", "slow e2e rows": "green" },
    judgedAt: { "Main OS e2e": "2026-09-26T19:30:00Z" },
  };
  const judged = await checkMainE2e({
    depot,
    memory,
    testRun: false,
    subject,
    current: settled(rerun),
  });
  expect(judged).toEqual({ pages: [], memory, failures: [] });
});

test("the run whose page job this is has not settled while Depot lists its suite as running: judging it throws", async () => {
  const current = mainRun("current", "2026-09-26T20:00:00Z", { specs: "running", running: true });
  const depot = fakeDepot({ "Main OS e2e": [current] });
  await expect(
    checkMainE2e({ depot, memory: empty, testRun: false, subject, current: settled(current) }),
  ).rejects.toThrow("wf-current has not settled: Depot lists main-os-e2e.yml:specs as running");
});

test("an older run Depot failed before its jobs started has no verdict: the state moves past it, and the next page job judges its own run", async () => {
  const stuck = {
    ...mainRun("stuck", "2026-09-26T19:30:00Z", {
      deploy: "queued",
      e2e: "queued",
      specs: "queued",
    }),
    status: "failed",
    artifacts: {},
  };
  const current = mainRun("current", "2026-09-26T20:00:00Z", { running: true });
  const depot = fakeDepot({ "Main OS e2e": [stuck, current] });
  const judged = await checkMainE2e({
    depot,
    memory: {
      suites: { "main e2e": "red", "slow e2e rows": "green" },
      judgedAt: { "Main OS e2e": "2026-09-26T19:00:00Z" },
    },
    testRun: false,
    subject,
    current: settled(current),
  });
  expect(judged).toEqual({
    pages: [
      {
        tone: "green",
        headline: "main e2e green again at `currentaa` (the subject of cur)",
        details: [],
        link: "https://depot.dev/orgs/0p91s0lz49/workflows/wf-current",
      },
    ],
    memory: {
      suites: { "main e2e": "green", "slow e2e rows": "green" },
      judgedAt: { "Main OS e2e": "2026-09-26T20:00:00Z" },
    },
    failures: [],
  });
});

// A deploy that failed is the run's verdict alone, whether its suites failed waiting for it or were
// skipped.
test.for([
  { name: "suites that failed waiting for it", suites: "failed" },
  { name: "skipped suites", suites: "skipped" },
])(
  "a main run whose deploy failed is red for its deploy alone, and its $name judge no slow rows",
  async ({ suites }) => {
    const depot = fakeDepot({
      "Main OS e2e": [
        mainRun("deployfailed", "2026-09-26T20:00:00Z", {
          deploy: "failed",
          e2e: suites,
          specs: suites,
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
      failures: [],
    });
  },
);

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

test("real-model e2e is the REAL: rows of each scheduled or push run since the last judged, from its telemetry", async () => {
  const depot = fakeDepot({
    "OS real model": [
      realModelRun("judged", "2026-09-25T05:47:00Z", [{ name: "REAL: a turn", state: "passed" }]),
      realModelRun(
        "broke",
        "2026-09-26T05:47:00Z",
        [{ name: "REAL: a turn", state: "failed", firstFailure: "Error: spend cap" }],
        "push",
      ),
      realModelRun("fixed", "2026-09-26T06:00:00Z", [{ name: "REAL: a turn", state: "passed" }]),
    ],
  });
  const judged = await checkRealModel({
    depot,
    memory: {
      suites: { "real-model e2e": "green" },
      judgedAt: { "OS real model": "2026-09-25T05:47:00Z" },
    },
    testRun: false,
    subject,
  });
  expect(judged).toMatchObject({
    pages: [
      { tone: "red", headline: "real-model e2e red at `brokebbbb` (the subject of bro)" },
      { tone: "green", headline: "real-model e2e green again at `fixedbbbb` (the subject of fix)" },
    ],
    memory: {
      suites: { "real-model e2e": "green" },
      judgedAt: { "OS real model": "2026-09-26T06:00:00Z" },
    },
  });
});

test("a first run judges only the newest real-model run", async () => {
  const depot = fakeDepot({
    "OS real model": [
      realModelRun(
        "pushed",
        "2026-09-26T05:47:00Z",
        [{ name: "REAL: a turn", state: "failed", firstFailure: "Error: an older failure" }],
        "push",
      ),
      realModelRun("daily", "2026-09-26T06:00:00Z", [
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

/** A run as ListWorkflows lists it: what the page job passes as its own run. */
function settled({ jobs: _jobs, artifacts: _artifacts, ...run }: ReturnType<typeof mainRun>) {
  return run;
}

/** A settled run of OS real model: the raw telemetry of its `rows` in the artifact it keeps. */
function realModelRun(id: string, createdAt: string, rows: TelemetryTest[], trigger = "schedule") {
  return {
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
  };
}

/** A commit's subject, as GitHub would answer it. */
async function subject(sha: string) {
  return `the subject of ${sha.slice(0, 3)}`;
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
