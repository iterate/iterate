import { expect, test } from "vitest";
import {
  baselineWindow,
  GuardState,
  judgeRun,
  latencyEvents,
  readReport,
  rememberRun,
  renderPage,
  transition,
  type Reading,
} from "./os-latency-guard.ts";

test("a report's metrics come off each row's meta; a row that missed only budgets is not broken, anything else is", () => {
  const budgetMiss =
    "AssertionError: latency budget missed: rules.300.newest p50 160 ms, budget 150 (samples 160): expected true to be false";
  expect(
    readReport({
      testResults: [
        {
          name: "perf/rewrite-rules.perf.test.ts",
          status: "failed",
          assertionResults: [
            {
              fullName: "300 rules",
              status: "failed",
              failureMessages: [budgetMiss, budgetMiss],
              meta: { latency: { "rules.300.newest": [160], "rules.300.root": [20] } },
            },
          ],
        },
        {
          name: "perf/contexts.perf.test.ts",
          status: "failed",
          assertionResults: [
            {
              fullName: "a context the platform evicted",
              status: "failed",
              failureMessages: ["AssertionError: evicted after 15 s idle: expected 1 to be >= 3"],
              meta: {},
            },
            { fullName: "first append", status: "passed", failureMessages: [], meta: {} },
          ],
        },
        {
          name: "perf/sign-in-and-mcp.perf.test.ts",
          status: "failed",
          message: "Cannot find module",
          assertionResults: [],
        },
      ],
    }),
  ).toEqual({
    samples: { "rules.300.newest": [160], "rules.300.root": [20] },
    broken: [
      "a context the platform evicted: AssertionError: evicted after 15 s idle: expected 1 to be >= 3",
      "perf/sign-in-and-mcp.perf.test.ts: Cannot find module",
    ],
  });
});

test.for([
  {
    name: "under both lines",
    samples: [20, 21, 22, 23, 24],
    scale: 1,
    expected: { value: 22, budget: 150, baseline: 21, regressionLine: 121, over: false },
  },
  // twice the baseline is weather at 21 ms: the line is 100 ms above it
  {
    name: "twice the baseline but under the floor",
    samples: [44, 44, 44],
    scale: 1,
    expected: { value: 44, overBudget: false, regressed: false, over: false },
  },
  {
    name: "a sharp regression still under the budget",
    samples: [130, 130, 130],
    scale: 1,
    expected: { value: 130, overBudget: false, regressed: true, over: true },
  },
  {
    name: "over the budget",
    samples: [160, 170, 180],
    scale: 1,
    expected: { value: 170, overBudget: true, regressed: true, over: true },
  },
  {
    name: "a forced alert: the budget scaled to 1.5 ms",
    samples: [20, 21, 22],
    scale: 0.01,
    expected: { value: 21, budget: 1.5, overBudget: true, regressed: false, over: true },
  },
])("rules.300.newest (budget 150 ms, baseline 21 ms): $name", ({ samples, scale, expected }) => {
  const history = Array.from({ length: 5 }, (_, i) => ({
    ...stateRun(`r${i}`, []),
    judged: { "rules.300.newest": 21 },
  }));
  expect(
    judgeRun({ samples: { "rules.300.newest": samples }, history, scale }).find(
      (reading) => reading.metric === "rules.300.newest",
    ),
  ).toMatchObject(expected);
});

test("a rate's budget is a floor, and halving its baseline is a regression; a metric no row recorded is missing", () => {
  const history = Array.from({ length: 5 }, (_, i) => ({
    ...stateRun(`r${i}`, []),
    judged: { "push.flood.throughput": 8000 },
  }));
  const readings = judgeRun({
    samples: { "push.flood.throughput": [3000, 3500, 3900] },
    history,
    scale: 1,
  });
  expect(readings.find((reading) => reading.metric === "push.flood.throughput")).toMatchObject({
    value: 3500,
    budget: 1000,
    baseline: 8000,
    regressionLine: 4000,
    overBudget: false,
    regressed: true,
  });
  expect(readings.find((reading) => reading.metric === "rules.300.newest")).toEqual({
    metric: "rules.300.newest",
    missing: true,
  });
});

test("the baseline is the newest 10 runs that measured the metric, and none below 5", () => {
  const runs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((value, i) => ({
    ...stateRun(`r${i}`, []),
    judged: { "context.append": value * 10 },
  }));
  expect(baselineWindow("context.append", runs)).toEqual([
    30, 40, 50, 60, 70, 80, 90, 100, 110, 120,
  ]);
  expect(baselineWindow("context.append", runs.slice(0, 4))).toBe(undefined);
  expect(baselineWindow("context.wake", runs)).toBe(undefined);
});

test("a metric whose runs spread wide regresses only beyond the slowest of them", () => {
  // the slowest of 25 concurrent projects: 7 s to 21 s across runs on one commit
  const history = [7, 9, 21, 8, 12, 10, 7].map((seconds, i) => ({
    ...stateRun(`r${i}`, []),
    judged: { "project.create.x25.all-ready": seconds * 1000 },
  }));
  const reading = (seconds: number) =>
    judgeRun({
      samples: { "project.create.x25.all-ready": [seconds * 1000] },
      history,
      scale: 1,
    }).find((reading) => reading.metric === "project.create.x25.all-ready");
  expect(reading(20)).toMatchObject({ baseline: 9000, regressionLine: 21000, regressed: false });
  expect(reading(22)).toMatchObject({ regressed: true });
});

test("a metric turns red when it crossed in two runs in a row, and pages once", () => {
  const empty: GuardState = { schemaVersion: 1, runs: [], red: [] };
  const first = transition({
    state: empty,
    readings: [],
    run: stateRun("r1", ["sign-in"]),
  });
  expect(first).toMatchObject({ page: null, turnedRed: [], next: { red: [] } });
  const second = transition({
    state: first.next,
    readings: [],
    run: stateRun("r2", ["sign-in", "mcp.call"]),
  });
  expect(second).toMatchObject({ page: "red", turnedRed: ["sign-in"], next: { red: ["sign-in"] } });
  const third = transition({
    state: second.next,
    readings: [],
    run: stateRun("r3", ["sign-in", "mcp.call"]),
  });
  expect(third).toMatchObject({
    page: "red",
    turnedRed: ["mcp.call"],
    next: { red: ["sign-in", "mcp.call"] },
  });
  const fourth = transition({
    state: third.next,
    readings: [],
    run: stateRun("r4", ["sign-in", "mcp.call"]),
  });
  expect(fourth).toMatchObject({ page: null, turnedRed: [], cleared: [] });
});

test("a red metric clears after two measured runs under its lines; green pages once nothing is red", () => {
  const red: GuardState = {
    schemaVersion: 1,
    runs: [stateRun("r1", ["sign-in", "mcp.call"]), stateRun("r2", ["sign-in", "mcp.call"])],
    red: ["sign-in", "mcp.call"],
  };
  const both = ["sign-in", "mcp.call"] as const;
  const once = transition({ state: red, readings: [], run: stateRun("r3", [], [...both]) });
  expect(once).toMatchObject({ page: null, cleared: [], next: { red: ["sign-in", "mcp.call"] } });
  // sign-in unmeasured (its row broke): it neither clears nor stays over
  const partly = transition({
    state: once.next,
    readings: [],
    run: stateRun("r4", [], ["mcp.call"]),
  });
  expect(partly).toMatchObject({ page: null, cleared: ["mcp.call"], next: { red: ["sign-in"] } });
  const measured = transition({
    state: partly.next,
    readings: [],
    run: stateRun("r5", [], [...both]),
  });
  expect(measured).toMatchObject({ page: null, cleared: [], next: { red: ["sign-in"] } });
  const green = transition({
    state: measured.next,
    readings: [],
    run: stateRun("r6", [], [...both]),
  });
  expect(green).toMatchObject({ page: "green", cleared: ["sign-in"], next: { red: [] } });
});

test("the state keeps the newest 20 runs", () => {
  const state: GuardState = {
    schemaVersion: 1,
    runs: Array.from({ length: 20 }, (_, i) => stateRun(`r${i}`, [])),
    red: [],
  };
  const { next } = transition({ state, readings: [], run: stateRun("r20", []) });
  expect(next.runs.map((run) => run.run)).toEqual(
    Array.from({ length: 20 }, (_, i) => `r${i + 1}`),
  );
});

test("a state from an older metrics table drops the metrics it no longer has", () => {
  expect(
    GuardState.parse({
      schemaVersion: 1,
      runs: [
        {
          sha: "abc",
          run: "r1",
          at: "2026-09-24T08:00:00.000Z",
          judged: { "sign-in": 1700, "project.create.x100.ready": 9000 },
          over: ["project.create.x100.ready", "sign-in"],
        },
      ],
      red: ["project.create.x100.ready"],
    }),
  ).toEqual({
    schemaVersion: 1,
    runs: [
      {
        sha: "abc",
        run: "r1",
        at: "2026-09-24T08:00:00.000Z",
        judged: { "sign-in": 1700 },
        over: ["sign-in"],
      },
    ],
    red: [],
  });
});

test("a run is remembered by each measured metric's judged value and what crossed", () => {
  const readings = judgeRun({
    samples: { "rules.300.newest": [160, 170, 180], "rules.300.root": [20, 30, 40] },
    history: [],
    scale: 1,
  });
  expect(rememberRun(readings, { sha: "abc", run: "r1", at: "2026-09-24T08:00:00.000Z" })).toEqual({
    sha: "abc",
    run: "r1",
    at: "2026-09-24T08:00:00.000Z",
    judged: { "rules.300.newest": 170, "rules.300.root": 30 },
    over: ["rules.300.newest"],
  });
});

test.for([
  {
    name: "red: mentions Jonas, and says which line each metric crossed",
    page: "red" as const,
    testRun: undefined,
    expected: [
      "🔴 latency over its lines at `3b6b1c8b0` (A &lt;change&gt;) <@U067G4QRFK2>",
      "• *rules.300.newest* p50 170 ms: over its budget of 150 ms and a sharp regression (line 121 ms) (baseline 21 ms, 8.1×); n=3, max 180",
      "still red: sign-in",
      "<https://depot.dev/run|the run>",
    ].join("\n"),
  },
  {
    name: "a test run: marked, and mentions nobody",
    page: "red" as const,
    testRun: { scale: 0.01 },
    expected: [
      "🧪 TEST RUN (budgets × 0.01) 🔴 latency over its lines at `3b6b1c8b0` (A &lt;change&gt;)",
      "• *rules.300.newest* p50 170 ms: over its budget of 150 ms and a sharp regression (line 121 ms) (baseline 21 ms, 8.1×); n=3, max 180",
      "still red: sign-in",
      "<https://depot.dev/run|the run>",
    ].join("\n"),
  },
  {
    name: "green",
    page: "green" as const,
    testRun: undefined,
    expected: [
      "🟢 latency back under its lines at `3b6b1c8b0` (A &lt;change&gt;)",
      "• rules.300.newest p50 170 ms (budget 150, baseline 21 ms, 8.1×)",
      "still red: sign-in",
      "<https://depot.dev/run|the run>",
    ].join("\n"),
  },
])("the page, $name", ({ page, testRun, expected }) => {
  const history = Array.from({ length: 5 }, (_, i) => ({
    ...stateRun(`r${i}`, []),
    judged: { "rules.300.newest": 21 },
  }));
  expect(
    renderPage({
      page,
      readings: judgeRun({
        samples: { "rules.300.newest": [160, 170, 180] },
        history,
        scale: 1,
      }),
      metrics: ["rules.300.newest"],
      stillRed: ["sign-in"],
      commit: { sha: "3b6b1c8b0aaaaaaa", subject: "A <change>" },
      runUrl: "https://depot.dev/run",
      testRun,
    }),
  ).toBe(expected);
});

test("PostHog gets one event per measured metric and percentile, deduplicated per run attempt", () => {
  const readings: Reading[] = judgeRun({
    samples: { "rules.300.newest": [10, 20, 30, 40, 50] },
    history: [],
    scale: 1,
  });
  const events = latencyEvents(readings, {
    sha: "abc",
    run: "42-1",
    ref: "refs/heads/main",
    trigger: "schedule",
    testRun: false,
    at: "2026-09-24T08:00:00.000Z",
  });
  expect(
    events.map(({ event, timestamp, properties }) => ({
      event,
      timestamp,
      insertId: properties.$insert_id,
      metric: properties.metric,
      percentile: properties.percentile,
      value: properties.value,
      judged: properties.judged,
    })),
  ).toEqual([
    {
      event: "os latency measured",
      timestamp: "2026-09-24T08:00:00.000Z",
      insertId: "os-latency:42-1:rules.300.newest:p50",
      metric: "rules.300.newest",
      percentile: "p50",
      value: 30,
      judged: true,
    },
    {
      event: "os latency measured",
      timestamp: "2026-09-24T08:00:00.000Z",
      insertId: "os-latency:42-1:rules.300.newest:p95",
      metric: "rules.300.newest",
      percentile: "p95",
      value: 50,
      judged: false,
    },
    {
      event: "os latency measured",
      timestamp: "2026-09-24T08:00:00.000Z",
      insertId: "os-latency:42-1:rules.300.newest:max",
      metric: "rules.300.newest",
      percentile: "max",
      value: 50,
      judged: false,
    },
  ]);
  expect(events[0]!.properties).toMatchObject({
    unit: "ms",
    budget: 150,
    over: false,
    samples: 5,
    sha: "abc",
    run: "42-1",
    ref: "refs/heads/main",
    trigger: "schedule",
    test_run: false,
    distinct_id: "os-latency-guard",
  });
});

/** A remembered main run that measured `over` over its lines and `under` under them (each at 1). */
function stateRun(
  run: string,
  over: GuardState["runs"][number]["over"],
  under: GuardState["runs"][number]["over"] = [],
) {
  return {
    sha: "abc",
    run,
    at: "2026-09-24T08:00:00.000Z",
    judged: Object.fromEntries([...over, ...under].map((metric) => [metric, 1])),
    over,
  } satisfies GuardState["runs"][number];
}
