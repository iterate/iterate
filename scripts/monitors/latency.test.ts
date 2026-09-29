import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { LATENCY_METRICS, type LatencyMetricName } from "../../apps/os/perf/latency.ts";
import {
  baselineWindow,
  brokenEvents,
  brokenLine,
  brokenProbes,
  brokenReport,
  checkLatencyDelivery,
  judgeBroken,
  judgeReport,
  judgeRun,
  latencyEvents,
  latencyEventsHeld,
  readReport,
  rememberRun,
  renderPage,
  transition,
  type BrokenProbe,
  type LatencyMemory,
  type PlatformFailure,
} from "./latency.ts";

test("a report's metrics come off each row's meta; a row that missed only budgets is not broken, anything else is", () => {
  const budgetMiss =
    "AssertionError: latency budget missed: rules.300.newest p50 160 ms, budget 150 (samples 160): expected true to be false";
  expect(
    readReport({
      testResults: [
        {
          name: "/w/apps/os/perf/rewrite-rules.perf.test.ts",
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
          name: "/w/apps/os/perf/contexts.perf.test.ts",
          status: "failed",
          assertionResults: [
            {
              fullName: "a context the platform evicted",
              status: "failed",
              failureMessages: [
                "AssertionError: evicted after 15 s idle: expected 1 to be >= 3\n    at contexts.perf.test.ts:52:5",
              ],
              meta: {},
            },
            { fullName: "first append", status: "passed", failureMessages: [], meta: {} },
          ],
        },
        {
          name: "/w/apps/os/perf/sign-in-and-mcp.perf.test.ts",
          status: "failed",
          message: "Cannot find module",
          assertionResults: [],
        },
      ],
    }),
  ).toEqual({
    samples: { "rules.300.newest": [160], "rules.300.root": [20] },
    broken: [
      {
        probe: "a context the platform evicted",
        file: "/w/apps/os/perf/contexts.perf.test.ts",
        error: "AssertionError: evicted after 15 s idle: expected 1 to be >= 3",
        platform: undefined,
        evidence: undefined,
      },
      {
        probe: "/w/apps/os/perf/sign-in-and-mcp.perf.test.ts",
        file: "/w/apps/os/perf/sign-in-and-mcp.perf.test.ts",
        error: "Cannot find module",
      },
    ],
  });
});

// THE RED RUNS OF MAIN, each one row broken by the platform with every budget fine: their failure
// messages as the perf reports hold them, and the meta the rows now leave beside them
// (perf/setup.ts, perf/push-delivery.perf.test.ts) with the values the job logs and Workers Logs
// measured.
const redRunsOfMain: {
  main: string;
  row: string;
  file: string;
  failureMessages: string[];
  meta: Parameters<typeof readReport>[0]["testResults"][number]["assertionResults"][number]["meta"];
  platform: PlatformFailure;
  evidence?: string;
  unrecorded: LatencyMetricName[];
}[] = [
  {
    main: "927f7a835",
    row: "an MCP tool call on a project, with a personal access token",
    file: "sign-in-and-mcp",
    failureMessages: ["TypeError: fetch failed"],
    meta: { failure: { causes: ["ECONNRESET"], socketsLost: [] } },
    platform: "connection-reset",
    evidence: "caused by ECONNRESET",
    unrecorded: ["mcp.call"],
  },
  {
    main: "6c4bd2319",
    row: "a context the platform evicted answers its first call",
    file: "contexts",
    failureMessages: [
      "Error: WebSocket connection failed.\n    at WebSocket.<anonymous> (file:///home/runner/work/iterate/iterate/node_modules/.pnpm/@iterate-com+capnweb@0.12.2/node_modules/@iterate-com/capnweb/dist/index.js:3021:40)\n    at WebSocket.#onSocketClose (node:internal/deps/undici/undici:15786:11)",
    ],
    meta: {
      failure: {
        causes: [],
        socketsLost: [
          { openedAfterMs: 65, failedAfterMs: 15_825, reason: "" },
          { openedAfterMs: 379, failedAfterMs: 15_831, reason: "" },
          { openedAfterMs: 546, failedAfterMs: 15_836, reason: "" },
        ],
      },
    },
    platform: "socket-lost",
    evidence: "3 sockets lost with no Close frame 15,825–15,836 ms after the dial",
    unrecorded: ["context.wake"],
  },
  {
    main: "a8e6c6525",
    row: "200 push subscribers: one append reaches all 200 in under 2 s, and a whoami during it takes under 1.5 s",
    file: "push-delivery",
    failureMessages: [
      "Error: until(warm round complete): timed out after 60000ms (1200 polls, 0 threw, the slowest 1ms): 167 of 200 callbacks had the warm ping; the subscribes took 3012, 3150, 3204, 3088, 3121, 3066, 3175, 3190 ms a batch of 25\n    at pushSubscribers (/home/runner/work/iterate/iterate/apps/os/e2e/support/push-load.ts:128:11)",
    ],
    meta: {
      failure: { causes: [], socketsLost: [] },
      subscribeBatchMs: [3012, 3150, 3204, 3088, 3121, 3066, 3175, 3190],
    },
    platform: "edge-stall",
    evidence: "subscribe round trips 3,012, 3,150, 3,204, 3,088, 3,121, 3,066, 3,175, 3,190 ms",
    unrecorded: ["push.fan200.all", "push.fan200.whoami"],
  },
  {
    main: "f12b3d1ea",
    row: "50 userspace processors: one append reaches all 50 in under 5 s, and a whoami during it takes under 1.5 s",
    file: "push-delivery",
    failureMessages: [
      "Error: Network connection lost.\n    at Evaluator.evaluateImpl (file:///home/runner/work/iterate/iterate/node_modules/.pnpm/@iterate-com+capnweb@0.12.2/node_modules/@iterate-com/capnweb/dist/index.js:2087:69)\n    at Evaluator.evaluateWithDepth (file:///home/runner/work/iterate/iterate/node_modules/.pnpm/@iterate-com+capnweb@0.12.2/node_modules/@iterate-com/capnweb/dist/index.js:2010:25)\n    at Evaluator.evaluate (file:///home/runner/work/iterate/iterate/node_modules/.pnpm/@iterate-com+capnweb@0.12.2/node_modules/@iterate-com/capnweb/dist/index.js:2005:15)\n    at RpcSessionImpl.readLoop (file:///home/runner/work/iterate/iterate/node_modules/.pnpm/@iterate-com+capnweb@0.12.2/node_modules/@iterate-com/capnweb/dist/index.js:2897:62)",
    ],
    meta: { failure: { causes: [], socketsLost: [] } },
    platform: "transport-cut",
    unrecorded: ["push.fan50.all", "push.fan50.whoami"],
  },
];

test.for(redRunsOfMain)(
  "main $main: $platform broke one row, the metrics it left unrecorded are its breakage, and the run is RECORDED, not red",
  ({ row, file, failureMessages, meta, platform, evidence, unrecorded }) => {
    const report = readReport({
      testResults: [
        {
          name: `/home/runner/work/iterate/iterate/apps/os/perf/${file}.perf.test.ts`,
          status: "failed",
          assertionResults: [{ fullName: row, status: "failed", failureMessages, meta }],
        },
      ],
    });
    const readings = judgeRun({ samples: everyMetricBut(unrecorded), history: [] });
    const broken = brokenProbes(report.broken, readings);
    expect(broken).toMatchObject([{ probe: row, platform, evidence }]);
    expect(judgeBroken(broken, stateRun("the run before", []))).toMatchObject([
      { probe: row, redBecause: undefined },
    ]);
    // broken again on the next run: red
    expect(judgeBroken(broken, { ...stateRun("the run before", []), broken: [row] })).toMatchObject(
      [{ redBecause: "broken in the run before too" }],
    );
  },
);

test.for([
  {
    name: "a wait that timed out while the subscribes ran at their usual ~0.1 s",
    failureMessages: [
      "Error: until(warm round complete): timed out after 60000ms (1200 polls, 0 threw, the slowest 1ms): 190 of 200 callbacks had the warm ping",
    ],
    meta: { subscribeBatchMs: [90, 110, 95, 120, 88, 101, 97, 93] },
  },
  {
    name: "a wait that timed out on a row that timed no subscribes",
    failureMessages: ["Error: until(all 200 received round 3): timed out after 10000ms"],
    meta: {},
  },
  {
    name: "a fetch that failed beside an assertion that failed",
    failureMessages: ["TypeError: fetch failed", "AssertionError: expected 500 to be 200"],
    meta: {},
  },
  {
    name: "a socket the Worker closed (a close frame: ours)",
    failureMessages: ["Error: Peer closed WebSocket: 3000 the session ended"],
    meta: {},
  },
  {
    name: "an MCP call our Worker answered with an error",
    failureMessages: ['Error: MCP tools/call answered 500: {"error":"boom"}'],
    meta: {},
  },
])("not a platform failure: $name", ({ failureMessages, meta }) => {
  const { broken } = readReport({
    testResults: [
      {
        name: "/w/apps/os/perf/push-delivery.perf.test.ts",
        status: "failed",
        assertionResults: [{ fullName: "a row", status: "failed", failureMessages, meta }],
      },
    ],
  });
  expect(broken).toMatchObject([{ probe: "a row", platform: undefined }]);
  expect(judgeBroken(broken, undefined)).toMatchObject([{ redBecause: "not a platform failure" }]);
});

test("a metric no row recorded is broken on its own unless a row or file of its perf file broke", () => {
  const broken: BrokenProbe[] = [
    { probe: "the MCP row", file: "/w/apps/os/perf/sign-in-and-mcp.perf.test.ts", error: "x" },
  ];
  const readings = judgeRun({
    samples: everyMetricBut(["mcp.call", "sign-in", "rules.300.root"]),
    history: [],
  });
  expect(brokenProbes(broken, readings)).toEqual([
    ...broken,
    { probe: "rules.300.root", error: "not recorded" },
  ]);
});

test("two broken probes in one run are both red, whatever broke them", () => {
  const broken: BrokenProbe[] = [
    { probe: "a", error: "TypeError: fetch failed", platform: "connection-reset" },
    { probe: "b", error: "Error: WebSocket connection failed.", platform: "socket-lost" },
  ];
  expect(judgeBroken(broken, undefined)).toMatchObject([
    { probe: "a", redBecause: "one of 2 broken probes in this run" },
    { probe: "b", redBecause: "one of 2 broken probes in this run" },
  ]);
  // a probe broken in the run before, then not, then broken again: recorded again
  expect(judgeBroken([broken[0]!], { ...stateRun("r2", []), broken: ["b"] })).toMatchObject([
    { redBecause: undefined },
  ]);
});

test("a broken probe's line says whether it is red and why, what broke it, and what the row saw", () => {
  const probe = {
    probe: "an MCP tool call on a project, with a personal access token",
    error: "TypeError: fetch failed",
    platform: "connection-reset",
    evidence: "caused by ECONNRESET",
  } as const;
  expect(brokenLine({ ...probe, redBecause: undefined })).toBe(
    "RECORDED, broken by the platform: an MCP tool call on a project, with a personal access token: TypeError: fetch failed — connection-reset, a fetch got no HTTP response: the connection to the edge failed — caused by ECONNRESET. The run stays green; broken again in the next run, it is red.",
  );
  expect(brokenLine({ ...probe, redBecause: "broken in the run before too" })).toBe(
    "RED, broken in the run before too: an MCP tool call on a project, with a personal access token: TypeError: fetch failed — connection-reset, a fetch got no HTTP response: the connection to the edge failed — caused by ECONNRESET",
  );
  expect(
    brokenLine({ probe: "mcp.call", error: "not recorded", redBecause: "not a platform failure" }),
  ).toBe("RED, not a platform failure: mcp.call: not recorded");
});

test("PostHog counts every broken probe, recorded or red, deduplicated per run attempt", () => {
  const [event] = brokenEvents(
    [
      {
        probe: "the MCP row",
        error: "TypeError: fetch failed",
        platform: "connection-reset",
        evidence: "caused by ECONNRESET",
        redBecause: undefined,
      },
    ],
    {
      sha: "abc",
      run: "42-1",
      ref: "refs/heads/main",
      trigger: "schedule",
      testRun: false,
      at: "2026-09-24T08:00:00.000Z",
    },
  );
  expect(event).toMatchObject({
    event: "os latency probe broken",
    properties: {
      $insert_id: "os-latency:42-1:broken:the MCP row",
      probe: "the MCP row",
      platform_failure: "connection-reset",
      verdict: "recorded",
      red_because: null,
      evidence: "caused by ECONNRESET",
      sha: "abc",
      test_run: false,
    },
  });
});

test("every metric names the perf file that records it", () => {
  for (const [metric, { file }] of Object.entries(LATENCY_METRICS))
    expect(
      readFileSync(resolve(import.meta.dirname, "../../apps/os", file), "utf8"),
      `${file} records ${metric}`,
    ).toContain(`"${metric}"`);
});

// ONE REPORT JUDGED: the verdict on its broken probes, the job summary and warnings they give, and
// the memory the next report is judged by.
test.for([
  {
    name: "a probe the platform broke is recorded: a warning and a summary line, and the run stays green",
    brokenBefore: [],
    red: false,
  },
  {
    name: "the same probe broken in the run before too: red",
    brokenBefore: ["an MCP tool call on a project, with a personal access token"],
    red: true,
  },
])("a report: $name", ({ brokenBefore, red }) => {
  const mcpRow = "an MCP tool call on a project, with a personal access token";
  const judged = judgeReport({
    report: {
      testResults: [
        {
          name: "/w/apps/os/perf/sign-in-and-mcp.perf.test.ts",
          status: "failed",
          assertionResults: [
            {
              fullName: mcpRow,
              status: "failed",
              failureMessages: ["TypeError: fetch failed"],
              meta: { failure: { causes: ["ECONNRESET"], socketsLost: [] } },
            },
            {
              fullName: "every other metric",
              status: "passed",
              failureMessages: [],
              meta: { latency: everyMetricBut(["mcp.call"]) },
            },
          ],
        },
      ],
    },
    memory: { runs: [{ ...stateRun("the run before", []), broken: brokenBefore }], red: [] },
    run: { sha: "abc", subject: "A change", run: "w42", at: "2026-09-26T21:29:00.000Z" },
    testRun: false,
  });

  expect(judged.broken).toMatchObject([
    {
      probe: mcpRow,
      platform: "connection-reset",
      redBecause: red ? "broken in the run before too" : undefined,
    },
  ]);
  const { summary, warnings } = brokenReport(judged.broken);
  expect(summary).toContain("### Broken latency probes");
  expect(summary).toContain(
    `${red ? "RED, broken in the run before too" : "RECORDED, broken by the platform"}: ${mcpRow}: TypeError: fetch failed`,
  );
  expect(warnings).toHaveLength(red ? 0 : 1);
  // the memory remembers the broken probe either way, for the next report's verdict, and the report
  expect(judged.memory).toMatchObject({ judgedAt: "2026-09-26T21:29:00.000Z" });
  expect(judged.memory.runs.at(-1)).toMatchObject({ run: "w42", broken: [mcpRow] });
});

test("a run that kept no report is red: the report and every metric it would have recorded are broken", () => {
  const judged = judgeReport({
    report: undefined,
    memory: { runs: [], red: [] },
    run: { sha: "abc", subject: "", run: "w43", at: "2026-09-26T21:29:00.000Z" },
    testRun: false,
  });
  expect(judged.broken.map(({ probe, redBecause }) => ({ probe, redBecause }))).toEqual(
    ["the perf report", ...Object.keys(LATENCY_METRICS)].map((probe) => ({
      probe,
      redBecause: "not a platform failure",
    })),
  );
});

test.for([
  {
    name: "x25 ready under both lines",
    metric: "project.create.x25.ready" as const,
    samples: [1900, 2000, 2100],
    expected: { value: 2000, budget: 20_000, baseline: 2000, regressionLine: 6000, over: false },
  },
  {
    name: "x25 ready, a sharp regression still under its budget",
    metric: "project.create.x25.ready" as const,
    samples: [7000, 7000, 7000],
    expected: { value: 7000, overBudget: false, regressed: true, over: true },
  },
  {
    name: "x25 ready over its budget",
    metric: "project.create.x25.ready" as const,
    samples: [20_500, 21_000, 21_500],
    expected: { value: 21_000, overBudget: true, regressed: true, over: true },
  },
  // three times a 21 ms round trip is weather: the line is 250 ms above it
  {
    name: "rules.300.newest at three times its baseline, under the floor",
    metric: "rules.300.newest" as const,
    samples: [66, 66, 66],
    expected: { value: 66, regressionLine: 271, overBudget: false, regressed: false, over: false },
  },
])("$name", ({ metric, samples, expected }) => {
  // five runs at 2 s (x25 ready) and 21 ms (the rule table), none over its lines
  const history = Array.from({ length: 5 }, (_, i) => ({
    ...stateRun(`r${i}`, []),
    judged: { "project.create.x25.ready": 2000, "rules.300.newest": 21 },
  }));
  expect(
    judgeRun({ samples: { [metric]: samples }, history }).find(
      (reading) => reading.metric === metric,
    ),
  ).toMatchObject(expected);
});

test("a rate's budget is a floor, and a third of its baseline is a regression; a metric no row recorded is missing", () => {
  const history = Array.from({ length: 5 }, (_, i) => ({
    ...stateRun(`r${i}`, []),
    judged: { "push.flood.throughput": 9000 },
  }));
  const readings = judgeRun({
    samples: { "push.flood.throughput": [2000, 2500, 2900] },
    history,
  });
  expect(readings.find((reading) => reading.metric === "push.flood.throughput")).toMatchObject({
    value: 2500,
    budget: 1000,
    baseline: 9000,
    regressionLine: 3000,
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
  expect(baselineWindow("context.append", runs)?.map((run) => run.value)).toEqual([
    30, 40, 50, 60, 70, 80, 90, 100, 110, 120,
  ]);
  expect(baselineWindow("context.append", runs.slice(0, 4))).toBe(undefined);
  expect(baselineWindow("context.wake", runs)).toBe(undefined);
});

test("a metric whose runs spread wide regresses only beyond the slowest of them", () => {
  // the slowest of 25 concurrent projects: 7 s to 21 s across runs on one commit, and once 35 s
  const history = [7, 9, 35, 8, 12, 10, 7].map((seconds, i) => ({
    ...stateRun(`r${i}`, []),
    judged: { "project.create.x25.all-ready": seconds * 1000 },
  }));
  const reading = (seconds: number) =>
    judgeRun({
      samples: { "project.create.x25.all-ready": [seconds * 1000] },
      history,
    }).find((reading) => reading.metric === "project.create.x25.all-ready");
  expect(reading(30)).toMatchObject({ baseline: 9000, regressionLine: 35_000, regressed: false });
  expect(reading(36)).toMatchObject({ regressed: true });
});

test("a run that crossed a line does not raise the line the next run is judged by", () => {
  const history = [7, 9, 8, 12, 10].map((seconds, i) => ({
    ...stateRun(`r${i}`, []),
    judged: { "project.create.x25.ready": seconds * 1000 },
  }));
  const slow = {
    ...stateRun("r5", ["project.create.x25.ready"]),
    judged: { "project.create.x25.ready": 40_000 },
  };
  // the median counts the slow run (a lasting change moves it), the extreme does not
  expect(
    judgeRun({
      samples: { "project.create.x25.ready": [35_000] },
      history: [...history, slow],
    }).find((reading) => reading.metric === "project.create.x25.ready"),
  ).toMatchObject({ baseline: 10_000, regressionLine: 30_000, regressed: true });
});

test("a metric turns red when it crossed in two runs in a row: the page opens, escalates when another turns, then is edited", () => {
  const empty: LatencyMemory = { runs: [], red: [] };
  const first = transition({
    state: empty,
    readings: [],
    run: stateRun("r1", ["sign-in"]),
  });
  expect(first).toMatchObject({ action: null, turnedRed: [], next: { red: [] } });
  const second = transition({
    state: first.next,
    readings: [],
    run: stateRun("r2", ["sign-in", "mcp.call"]),
  });
  expect(second).toMatchObject({
    action: "post",
    turnedRed: ["sign-in"],
    next: { red: ["sign-in"], signal: { state: "red", since: "abc", runs: 1 } },
  });
  const third = transition({
    state: second.next,
    readings: [],
    run: stateRun("r3", ["sign-in", "mcp.call"]),
  });
  expect(third).toMatchObject({
    action: "escalate",
    turnedRed: ["mcp.call"],
    next: { red: ["sign-in", "mcp.call"], signal: { runs: 2 } },
  });
  const fourth = transition({
    state: third.next,
    readings: [],
    run: stateRun("r4", ["sign-in", "mcp.call"]),
  });
  expect(fourth).toMatchObject({ action: "edit", turnedRed: [], cleared: [] });
});

test("a run whose row broke neither breaks a streak of crossings nor completes one", () => {
  const crossed: LatencyMemory = { runs: [stateRun("r1", ["sign-in"])], red: [] };
  // r2 measured nothing of sign-in (its row broke)
  const broken = transition({
    state: crossed,
    readings: [],
    run: stateRun("r2", [], ["mcp.call"]),
  });
  expect(broken).toMatchObject({ action: null, next: { red: [] } });
  const again = transition({ state: broken.next, readings: [], run: stateRun("r3", ["sign-in"]) });
  expect(again).toMatchObject({ action: "post", turnedRed: ["sign-in"] });
});

test("a red metric clears after two measured runs under its lines; the page resolves once nothing is red", () => {
  const red: LatencyMemory = {
    runs: [stateRun("r1", ["sign-in", "mcp.call"]), stateRun("r2", ["sign-in", "mcp.call"])],
    red: ["sign-in", "mcp.call"],
    signal: { state: "red", since: "abc", runs: 1, failures: ["sign-in", "mcp.call"] },
  };
  const both = ["sign-in", "mcp.call"] as const;
  const once = transition({ state: red, readings: [], run: stateRun("r3", [], [...both]) });
  expect(once).toMatchObject({
    action: "edit",
    cleared: [],
    next: { red: ["sign-in", "mcp.call"] },
  });
  // sign-in unmeasured (its row broke): it neither clears nor stays over
  const partly = transition({
    state: once.next,
    readings: [],
    run: stateRun("r4", [], ["mcp.call"]),
  });
  expect(partly).toMatchObject({
    action: "edit",
    cleared: ["mcp.call"],
    next: { red: ["sign-in"] },
  });
  // under again: with r3, its last measured run, that is two in a row
  const green = transition({
    state: partly.next,
    readings: [],
    run: stateRun("r5", [], [...both]),
  });
  expect(green).toMatchObject({
    action: "resolve",
    cleared: ["sign-in"],
    next: { red: [], signal: { state: "green" } },
  });
});

test("the state keeps the newest 20 runs", () => {
  const state: LatencyMemory = {
    runs: Array.from({ length: 20 }, (_, i) => stateRun(`r${i}`, [])),
    red: [],
  };
  const { next } = transition({ state, readings: [], run: stateRun("r20", []) });
  expect(next.runs.map((run) => run.run)).toEqual(
    Array.from({ length: 20 }, (_, i) => `r${i + 1}`),
  );
});

test("a run is remembered by each measured metric's median, what crossed, and what broke", () => {
  const readings = judgeRun({
    samples: { "rules.300.newest": [160, 170, 180], "rules.300.root": [20, 30, 40] },
    history: [],
  });
  expect(
    rememberRun(readings, { sha: "abc", run: "r1", at: "2026-09-24T08:00:00.000Z" }, [
      { probe: "the MCP row", error: "TypeError: fetch failed", platform: "connection-reset" },
    ]),
  ).toEqual({
    sha: "abc",
    run: "r1",
    at: "2026-09-24T08:00:00.000Z",
    judged: { "rules.300.newest": 170, "rules.300.root": 30 },
    over: ["rules.300.newest"],
    broken: ["the MCP row"],
  });
});

test.for([
  {
    name: "a page says which line each red metric crossed, and since when",
    kind: "edit" as const,
    expected: {
      signal: "latency",
      kind: "edit",
      page: {
        what: "latency over its lines at `3b6b1c8b0` (A &lt;change&gt;)",
        impact:
          "*rules.300.newest* median 170 ms: over its budget of 150 ms (baseline 21 ms, 8.1×); n=3, max 180; sign-in: not measured; red since `abcdef`, 2 runs",
        action: "fix or revert the change that slowed rules.300.newest, sign-in",
        link: "https://depot.dev/run",
      },
    },
  },
  {
    name: "an escalation names the metric that just turned",
    kind: "escalate" as const,
    expected: {
      kind: "escalate",
      news: "latency: rules.300.newest over its lines too at `3b6b1c8b0` (A &lt;change&gt;)",
      broadcast: false,
    },
  },
  {
    name: "a resolution names what came back",
    kind: "resolve" as const,
    expected: {
      signal: "latency",
      kind: "resolve",
      why: "latency back under its lines at `3b6b1c8b0` (A &lt;change&gt;); rules.300.newest median 170 ms (budget 150, baseline 21 ms, 8.1×)",
    },
  },
])("$name", ({ kind, expected }) => {
  const history = Array.from({ length: 5 }, (_, i) => ({
    ...stateRun(`r${i}`, []),
    judged: { "rules.300.newest": 21 },
  }));
  expect(
    renderPage({
      kind,
      readings: judgeRun({
        samples: { "rules.300.newest": [160, 170, 180] },
        history,
      }),
      red: ["rules.300.newest", "sign-in"],
      turnedRed: ["rules.300.newest"],
      cleared: ["rules.300.newest"],
      signal: { state: "red", since: "abcdef", runs: 2, failures: ["sign-in", "rules.300.newest"] },
      commit: { sha: "3b6b1c8b0aaaaaaa", subject: "A <change>" },
      runUrl: "https://depot.dev/run",
    }),
  ).toMatchObject(expected);
});

test("a rate's page line says it fell under its budget, and its lowest round", () => {
  expect(
    renderPage({
      kind: "post",
      readings: judgeRun({
        samples: { "push.flood.throughput": [600, 800, 900] },
        history: [],
      }),
      red: ["push.flood.throughput"],
      turnedRed: ["push.flood.throughput"],
      cleared: [],
      signal: { state: "red", since: "abc", runs: 1, failures: ["push.flood.throughput"] },
      commit: { sha: "3b6b1c8b0aaaaaaa", subject: "A change" },
    }),
  ).toMatchObject({
    page: {
      impact:
        "*push.flood.throughput* median 800 events/s: under its budget of 1,000 events/s (no baseline yet); n=3, min 600",
    },
  });
});

test("PostHog gets one event per measured metric and percentile, deduplicated per run attempt", () => {
  const readings = judgeRun({
    samples: { "rules.300.newest": [10, 20, 30, 40, 50] },
    history: [],
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
    })),
  ).toEqual([
    {
      event: "os latency measured",
      timestamp: "2026-09-24T08:00:00.000Z",
      insertId: "os-latency:42-1:rules.300.newest:p50",
      metric: "rules.300.newest",
      percentile: "p50",
      value: 30,
    },
    {
      event: "os latency measured",
      timestamp: "2026-09-24T08:00:00.000Z",
      insertId: "os-latency:42-1:rules.300.newest:p95",
      metric: "rules.300.newest",
      percentile: "p95",
      value: 50,
    },
    {
      event: "os latency measured",
      timestamp: "2026-09-24T08:00:00.000Z",
      insertId: "os-latency:42-1:rules.300.newest:max",
      metric: "rules.300.newest",
      percentile: "max",
      value: 50,
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

test.for<{
  name: string;
  runs: LatencyMemory["runs"];
  held: number;
  expected: { asked: string[]; failure?: string };
}>([
  {
    name: "a run whose every event PostHog holds passes",
    runs: [stateRun("r1", ["sign-in"]), stateRun("r2", ["sign-in"], ["mcp.call"])],
    held: 6,
    expected: { asked: ["r2"] },
  },
  {
    name: "a run PostHog dropped events of fails the health run, naming it and the likely cause",
    runs: [stateRun("r1", ["sign-in"]), stateRun("r2", ["sign-in"], ["mcp.call"])],
    held: 0,
    expected: {
      asked: ["r2"],
      failure:
        "PostHog holds 0 of the 6 `os latency measured` events of OS latency run r2 (2026-09-24T08:00:00.000Z), which an earlier health run sent: PostHog answers 200 to a batch it drops, as it does while the organization is over its billing limit",
    },
  },
  {
    name: "a first run has sent nothing to check",
    runs: [],
    held: 0,
    expected: { asked: [] },
  },
  {
    name: "a run that measured nothing sent no measurement",
    runs: [stateRun("r1", [])],
    held: 0,
    expected: { asked: [] },
  },
])("$name", async ({ runs, held, expected }) => {
  const asked: string[] = [];
  const checked = checkLatencyDelivery(runs.at(-1), async (run) => {
    asked.push(run.run);
    return held;
  });
  if (expected.failure) await expect(checked).rejects.toThrow(expected.failure);
  else await expect(checked).resolves.toBeUndefined();
  expect(asked).toEqual(expected.asked);
});

test("PostHog is asked for the run's events around its creation, each UUID counted once", async () => {
  const posthog = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ results: [[69]], columns: ["count"] }));
  vi.stubGlobal("fetch", posthog);

  await expect(
    latencyEventsHeld({ run: "qz7f3w5jkv", at: "2026-09-29T18:29:34.000Z" }, "phx_read"),
  ).resolves.toBe(69);

  const [url, init] = posthog.mock.calls[0]!;
  expect(url).toBe("https://eu.posthog.com/api/projects/115112/query/");
  expect(init?.headers).toMatchObject({ authorization: "Bearer phx_read" });
  expect(JSON.parse(String(init?.body))).toEqual({
    query: {
      kind: "HogQLQuery",
      query:
        "SELECT count(DISTINCT uuid) FROM events WHERE event = 'os latency measured' AND properties.run = {run} AND timestamp >= toDateTime({at}) - INTERVAL 1 DAY AND timestamp <= toDateTime({at}) + INTERVAL 1 DAY",
      values: { run: "qz7f3w5jkv", at: "2026-09-29T18:29:34.000Z" },
    },
  });
});

/** A remembered main run that measured `over` over its lines and `under` under them (each at 1). */
function stateRun(
  run: string,
  over: LatencyMemory["runs"][number]["over"],
  under: LatencyMemory["runs"][number]["over"] = [],
) {
  return {
    sha: "abc",
    run,
    at: "2026-09-24T08:00:00.000Z",
    judged: Object.fromEntries([...over, ...under].map((metric) => [metric, 1])),
    over,
    broken: [],
  } satisfies LatencyMemory["runs"][number];
}

/** A sample of every metric but `unrecorded`, each under its budget. */
function everyMetricBut(unrecorded: readonly LatencyMetricName[]) {
  return Object.fromEntries(
    Object.entries(LATENCY_METRICS)
      .filter(([metric]) => !unrecorded.includes(metric as LatencyMetricName))
      .map(([metric, { unit, budget }]) => [
        metric,
        [unit === "events/s" ? budget * 2 : budget / 2],
      ]),
  );
}
