import { expect, test } from "vitest";
import {
  judge,
  LINES,
  measurePush,
  pageFor,
  pushEvents,
  readState,
  renderPage,
  summarizePushes,
  type RunMetrics,
} from "./pr-ttg-guard.ts";

// Depot's GetRunMetrics for run pxt90nlfvh (PR #3009, 2026-09-24), cut to the fields the guard reads.
const pxt90nlfvh: RunMetrics = {
  run: {
    runId: "pxt90nlfvh",
    ref: "refs/pull/3009/merge",
    createdAt: "2026-09-24T11:49:09.549Z",
  },
  workflows: [
    workflow("vd4b2fgdg1", "Lint and Typecheck", "finished", "2026-09-24T11:49:51.769Z"),
    workflow("xtjdzfvjhk", "LOC report", "finished", "2026-09-24T11:49:51.782Z"),
    workflow("nsbcf2f8mt", "Preview OS", "finished", "2026-09-24T11:54:25.587Z"),
    workflow("r70khb2kt1", "Test", "finished", "2026-09-24T11:52:21.228Z"),
  ],
};

// Depot's GetRunMetrics for run xwhttppx6h (PR #3197, 2026-09-25), cut to the fields the guard reads.
const xwhttppx6h: RunMetrics = {
  run: {
    runId: "xwhttppx6h",
    ref: "refs/pull/3197/merge",
    createdAt: "2026-09-25T21:12:29.946Z",
  },
  workflows: [
    check("clw7764jds", "Lint and Typecheck", "finished", "2026-09-25T21:13:30.104Z", {
      "lint-typecheck.yml:lint-typecheck": ["2026-09-25T21:13:27.395Z"],
    }),
    check("p48hfnzxh8", "Test", "finished", "2026-09-25T21:15:10.466Z", {
      "test.yml:test": ["2026-09-25T21:15:07.380Z"],
    }),
    previewOs("1pbtqdpdbt", "finished", "2026-09-25T21:17:10.931Z", {
      deploy: ["2026-09-25T21:14:01.290Z"],
      e2e: ["2026-09-25T21:15:13.748Z"],
      specs: ["2026-09-25T21:16:14.801Z"],
      trace: ["2026-09-25T21:17:06.769Z"],
    }),
  ],
};

test("a green push's time to green runs from the run's creation to its last check's end", () => {
  expect(
    measurePush({
      metrics: pxt90nlfvh,
      firstExecutions: {},
      nextRunAt: undefined,
      summary: {},
    }),
  ).toEqual({
    run: "pxt90nlfvh",
    pr: 3009,
    createdAt: "2026-09-24T11:49:09.549Z",
    outcome: "green",
    // Preview OS's end, 11:54:25.587; LOC report is not a check
    e2e: "every-row",
    seconds: 316,
    // the cut keeps none of its jobs: the check's name
    lastJob: "Preview OS",
  });
});

// Depot's GetRunMetrics for run l9b40r65b2 (PR #3094) and v7gm132nt1 (PR #3009, whose e2e failed
// and passed on a re-run), cut to the fields the guard reads.
test.for<{
  metrics: RunMetrics;
  firstExecutions: Parameters<typeof measurePush>[0]["firstExecutions"];
  expected: object;
}>([
  {
    metrics: {
      run: {
        runId: "l9b40r65b2",
        ref: "refs/pull/3094/merge",
        createdAt: "2026-09-24T19:56:00.152Z",
      },
      workflows: [
        workflow("fn4fhm8q96", "Lint and Typecheck", "finished", "2026-09-24T19:57:04.915Z"),
        workflow("xh81bck8bm", "Test", "finished", "2026-09-24T19:58:40.106Z"),
        previewOs("26hmfc2c77", "finished", "2026-09-24T20:02:19.475Z", {
          deploy: ["2026-09-24T19:57:40.086Z"],
          e2e: ["2026-09-24T20:01:31.057Z"],
          specs: ["2026-09-24T19:59:19.763Z"],
          trace: ["2026-09-24T20:02:11.591Z"],
        }),
      ],
    },
    firstExecutions: {},
    // E2E tests' end, 48 s before the trace's
    expected: { outcome: "green", seconds: 330.9, lastJob: "preview-os.yml:e2e" },
  },
  {
    metrics: {
      run: {
        runId: "v7gm132nt1",
        ref: "refs/pull/3009/merge",
        createdAt: "2026-09-24T11:37:49.951Z",
      },
      workflows: [
        workflow("jkmnhnhp8z", "Lint and Typecheck", "finished", "2026-09-24T11:38:23.614Z"),
        workflow("v5lv047b1c", "Test", "finished", "2026-09-24T11:41:01.194Z"),
        previewOs("2lprg4f8q9", "finished", "2026-09-24T11:47:33.757Z", {
          deploy: ["2026-09-24T11:39:25.275Z"],
          e2e: ["2026-09-24T11:42:46.744Z", "2026-09-24T11:47:18.153Z"],
          trace: ["2026-09-24T11:43:00.575Z", "2026-09-24T11:47:31.889Z"],
        }),
      ],
    },
    firstExecutions: { "2lprg4f8q9": { status: "failed", finishedAt: "2026-09-24T11:43:01Z" } },
    // the first E2E tests attempt's end, before its trace and the re-run
    expected: { outcome: "red", seconds: 296.8, lastJob: "preview-os.yml:e2e" },
  },
  {
    metrics: xwhttppx6h,
    firstExecutions: {},
    // Browser specs' end, 61 s after E2E tests' and 64 s after Test's
    expected: { outcome: "green", seconds: 224.9, lastJob: "preview-os.yml:specs" },
  },
])(
  "Preview OS reaches its verdict at its last job but the CI trace: $metrics.run.runId",
  ({ metrics, firstExecutions, expected }) => {
    expect(
      measurePush({ metrics, firstExecutions, nextRunAt: undefined, summary: {} }),
    ).toMatchObject(expected);
  },
);

// Depot's GetRunMetrics for run 7cjwv9crwz (PR #3192, 2026-09-25), which changed no preview path, cut
// to the fields the guard reads.
const r7cjwv9crwz: RunMetrics = {
  run: {
    runId: "7cjwv9crwz",
    ref: "refs/pull/3192/merge",
    createdAt: "2026-09-25T20:13:27.979Z",
  },
  workflows: [
    check("x3nn5v3l3x", "Lint and Typecheck", "finished", "2026-09-25T20:14:37.692Z", {
      "lint-typecheck.yml:lint-typecheck": ["2026-09-25T20:14:34.961Z"],
    }),
    check("k2rn3vd449", "Test", "finished", "2026-09-25T20:16:18Z", {
      "test.yml:test": ["2026-09-25T20:16:14.704Z"],
    }),
    {
      workflow: {
        workflowId: "ppzs6zfbpk",
        name: "Preview OS",
        status: "finished",
        finishedAt: "2026-09-25T20:13:38.400Z",
      },
      jobs: [
        {
          job: { jobKey: "preview-os.yml:deploy", status: "finished" },
          attempts: [{ attempt: { attempt: 1, finishedAt: "2026-09-25T20:13:35.959Z" } }],
        },
        ...["e2e", "specs", "trace"].map((job) => ({
          job: { jobKey: `preview-os.yml:${job}`, status: "skipped" },
          attempts: [],
        })),
      ],
    },
  ],
};

test.for([
  {
    name: "Test ends a push whose Preview OS ran no suite",
    metrics: r7cjwv9crwz,
    expected: { e2e: "no-preview", seconds: 170, lastJob: "test.yml:test" },
  },
  {
    name: "a matrix's legs are one job, whichever leg finished last",
    metrics: {
      ...xwhttppx6h,
      workflows: xwhttppx6h.workflows.map((entry) =>
        entry.workflow.name === "Preview OS"
          ? previewOs("1pbtqdpdbt", "finished", "2026-09-25T21:17:10.931Z", {
              deploy: ["2026-09-25T21:14:01.290Z"],
              e2e: ["2026-09-25T21:15:13.748Z"],
              "specs:matrix-0": ["2026-09-25T21:15:50.000Z"],
              "specs:matrix-1": ["2026-09-25T21:16:14.801Z"],
              "specs:matrix-2": ["2026-09-25T21:16:01.000Z"],
              trace: ["2026-09-25T21:17:06.769Z"],
            })
          : entry,
      ),
    },
    expected: { seconds: 224.9, lastJob: "preview-os.yml:specs" },
  },
])("$name", ({ metrics, expected }) => {
  expect(
    measurePush({ metrics, firstExecutions: {}, nextRunAt: undefined, summary: undefined }),
  ).toMatchObject({ outcome: "green", ...expected });
});

test.for([
  { summary: { slowRows: "skipped" as const }, e2e: "slow-rows-skipped" },
  { summary: { slowRows: "ran" as const }, e2e: "every-row" },
  // a suite with no row tagged slow: every row ran
  { summary: {}, e2e: "every-row" },
  // e2e wrote no summary (its deploy failed, say)
  { summary: undefined, e2e: "no-summary" },
])("suite summary $summary → $e2e", ({ summary, e2e }) => {
  expect(
    measurePush({ metrics: pxt90nlfvh, firstExecutions: {}, nextRunAt: undefined, summary }),
  ).toMatchObject({ e2e });
});

test("a push without Preview OS waits for Lint and Typecheck and Test alone", () => {
  expect(
    measurePush({
      metrics: {
        ...pxt90nlfvh,
        workflows: pxt90nlfvh.workflows.filter(({ workflow }) => workflow.name !== "Preview OS"),
      },
      firstExecutions: {},
      nextRunAt: undefined,
      summary: undefined,
    }),
  ).toMatchObject({ outcome: "green", e2e: "no-preview", seconds: 191.7 });
});

// Since Preview OS runs on every push, a push that changes no preview path runs its Deploy preview
// job alone, to decide so, and skips E2E tests.
test("a push whose Preview OS skipped E2E tests has no preview, and still waits for Preview OS", () => {
  const skipped = {
    ...pxt90nlfvh,
    workflows: pxt90nlfvh.workflows.map((entry) =>
      entry.workflow.name === "Preview OS"
        ? {
            workflow: { ...entry.workflow, finishedAt: "2026-09-24T11:52:30.000Z" },
            jobs: [
              { job: { jobKey: "preview-os.yml:deploy", status: "finished" }, attempts: [{}] },
              { job: { jobKey: "preview-os.yml:e2e", status: "skipped" }, attempts: [] },
              { job: { jobKey: "preview-os.yml:specs", status: "skipped" }, attempts: [] },
            ],
          }
        : entry,
    ),
  };
  expect(
    measurePush({
      metrics: skipped,
      firstExecutions: {},
      nextRunAt: undefined,
      summary: undefined,
    }),
  ).toMatchObject({ outcome: "green", e2e: "no-preview", seconds: 200.5 });
});

test("a re-run check counts at its first execution: red at that execution's end", () => {
  // run v7gm132nt1: Preview OS's e2e failed, its re-run passed at 11:47:33
  expect(
    measurePush({
      metrics: withWorkflow("nsbcf2f8mt", {
        status: "finished",
        finishedAt: "2026-09-24T11:59:00.000Z",
        attempts: 2,
      }),
      firstExecutions: {
        nsbcf2f8mt: { status: "failed", finishedAt: "2026-09-24T11:53:09.549Z" },
      },
      nextRunAt: undefined,
      summary: {},
    }),
  ).toMatchObject({ outcome: "red", seconds: 240 });
});

test.for([
  // Test cancelled 4.7 s after the PR's next run was created: superseded (runs xpqdpl3n30, jl03bzphth)
  { nextRunAt: "2026-09-24T11:50:05Z", outcome: "superseded" },
  // the next push came after Test had already been cancelled: that cancel was a timeout
  { nextRunAt: "2026-09-24T11:51:00Z", outcome: "red" },
  { nextRunAt: undefined, outcome: "red" },
])(
  "a cancelled Test with the next run created at $nextRunAt → $outcome",
  ({ nextRunAt, outcome }) => {
    expect(
      measurePush({
        metrics: withWorkflow("r70khb2kt1", {
          status: "cancelled",
          finishedAt: "2026-09-24T11:50:10.745Z",
        }),
        firstExecutions: {},
        nextRunAt,
        summary: {},
      }),
    ).toMatchObject({ outcome });
  },
);

// Preview OS cancels its run in progress when the PR's next push starts (preview-os.yml
// `concurrency:`), even in the CI trace, after its suites passed.
test.for([
  { nextRunAt: "2026-09-24T11:55:00Z", ended: "2026-09-24T12:30:00.000Z", outcome: "superseded" },
  { nextRunAt: "2026-09-24T11:54:20Z", ended: "2026-09-24T11:54:25.587Z", outcome: "superseded" },
  // cancelled before the next push: a timeout or a person
  { nextRunAt: "2026-09-24T11:55:00Z", ended: "2026-09-24T11:54:25.587Z", outcome: "red" },
  { nextRunAt: undefined, ended: "2026-09-24T11:54:25.587Z", outcome: "red" },
])(
  "a Preview OS cancelled in its trace at $ended, the next run created at $nextRunAt → $outcome",
  ({ nextRunAt, ended, outcome }) => {
    expect(
      measurePush({
        metrics: {
          ...pxt90nlfvh,
          workflows: pxt90nlfvh.workflows.map((entry) =>
            entry.workflow.name === "Preview OS"
              ? previewOs("nsbcf2f8mt", "cancelled", ended, {
                  deploy: ["2026-09-24T11:50:40.000Z"],
                  e2e: ["2026-09-24T11:53:59.000Z"],
                  specs: ["2026-09-24T11:52:10.000Z"],
                  trace: [ended],
                })
              : entry,
          ),
        },
        firstExecutions: {},
        nextRunAt,
        summary: { slowRows: "skipped" },
      }),
    ).toMatchObject({ outcome });
  },
);

test("a PR run without Test is not a push; one with a check still unfinished is not measured yet", () => {
  expect(
    measurePush({
      metrics: {
        ...pxt90nlfvh,
        workflows: pxt90nlfvh.workflows.filter(({ workflow }) => workflow.name === "LOC report"),
      },
      firstExecutions: {},
      nextRunAt: undefined,
      summary: undefined,
    }),
  ).toMatchObject({ outcome: "not-a-push" });
  expect(
    measurePush({
      metrics: withWorkflow("nsbcf2f8mt", { status: "running", finishedAt: "" }),
      firstExecutions: {},
      nextRunAt: undefined,
      summary: {},
    }),
  ).toBeUndefined();
});

test("summarizes the window's pushes by what their e2e ran, with interpolated percentiles", () => {
  const summary = summarizePushes(
    [
      ...[100, 110, 120, 130, 200].map((seconds, index) =>
        push({
          seconds,
          e2e: "slow-rows-skipped",
          minute: index,
          lastJob: index % 2 ? "preview-os.yml:e2e" : "preview-os.yml:specs",
        }),
      ),
      // a red push's last job does not count
      ...[5, 6].map((minute) =>
        push({
          seconds: 400,
          e2e: "slow-rows-skipped",
          outcome: "red",
          minute,
          lastJob: "preview-os.yml:e2e",
        }),
      ),
      push({ seconds: 300, e2e: "every-row", minute: 7, lastJob: "preview-os.yml:e2e" }),
      push({ seconds: 180, e2e: "no-preview", minute: 8, lastJob: "test.yml:test" }),
      push({ outcome: "superseded", minute: 9 }),
      // created before the window
      push({ seconds: 999, e2e: "slow-rows-skipped", minute: -1 }),
    ],
    { from: Date.parse("2026-09-24T12:00:00Z"), to: Date.parse("2026-09-24T13:00:00Z") },
  );
  expect(summary.byRows["slow-rows-skipped"]).toEqual({
    pushes: 7,
    red: 2,
    timeToGreen: { n: 5, p50: 120, p90: 172 },
    firstVerdict: { n: 7, p50: 130, p90: 400 },
    lastJob: { job: "preview-os.yml:specs", pushes: 3 },
  });
  expect(summary.byRows["no-summary"]).toEqual({
    pushes: 0,
    red: 0,
    timeToGreen: undefined,
    firstVerdict: undefined,
    lastJob: undefined,
  });
  // 3 each for E2E tests and Browser specs: the first by name
  expect(summary.all).toMatchObject({
    pushes: 9,
    red: 2,
    timeToGreen: { n: 7 },
    lastJob: { job: "preview-os.yml:e2e", pushes: 3 },
  });
  expect(summary).toMatchObject({ slowRowsShare: 1 / 8, superseded: 1 });
});

test.for([
  { name: "one push is too few to judge", seconds: [150], judged: { judgement: "too-few" } },
  {
    name: "20 pushes at 150 s are under",
    seconds: Array(20).fill(150),
    judged: { judgement: "under", p50: 150 },
  },
  {
    name: "a median on the line is under",
    seconds: Array(20).fill(165),
    judged: { judgement: "under", p50: 165 },
  },
  {
    name: "a median a second over the line is over",
    seconds: Array(20).fill(166),
    judged: { judgement: "over", p50: 166 },
  },
  {
    name: "a p90 over 200 s is over with the median under",
    seconds: [...Array(17).fill(150), 250, 250, 250],
    judged: { judgement: "over", p50: 150 },
  },
])("$name", ({ seconds, judged }) => {
  const pushes = seconds.map((value, minute) =>
    push({ seconds: value, e2e: "slow-rows-skipped", minute }),
  );
  // other pushes never count toward the line
  pushes.push(
    ...Array.from({ length: 30 }, (_, minute) => push({ seconds: 999, e2e: "every-row", minute })),
  );
  expect(
    judge(
      summarizePushes(pushes, {
        from: Date.parse("2026-09-24T12:00:00Z"),
        to: Date.parse("2026-09-24T13:00:00Z"),
      }),
    ),
  ).toEqual(judged);
  expect(LINES).toEqual({ p50: 165, p90: 200, worse: 20, minPushes: 20 });
});

test.for([
  {
    name: "over before any page pages red",
    lastPage: undefined,
    judged: { judgement: "over", p50: 170 },
    page: "over",
    next: { judgement: "over", bestP50: 170 },
  },
  {
    name: "over after a green page pages red",
    lastPage: { judgement: "under", bestP50: 150 },
    judged: { judgement: "over", p50: 170 },
    page: "over",
    next: { judgement: "over", bestP50: 170 },
  },
  {
    name: "still over, 20 s over the best since the red page, pages nothing",
    lastPage: { judgement: "over", bestP50: 198 },
    judged: { judgement: "over", p50: 218 },
    page: null,
    next: { judgement: "over", bestP50: 198 },
  },
  {
    name: "still over, more than 20 s over the best since the red page, pages red again",
    lastPage: { judgement: "over", bestP50: 198 },
    judged: { judgement: "over", p50: 218.1 },
    page: "worse",
    next: { judgement: "over", bestP50: 218.1 },
  },
  {
    name: "still over and better lowers the best, and pages nothing",
    lastPage: { judgement: "over", bestP50: 218 },
    judged: { judgement: "over", p50: 190 },
    page: null,
    next: { judgement: "over", bestP50: 190 },
  },
  {
    name: "back under after a red page pages green",
    lastPage: { judgement: "over", bestP50: 190 },
    judged: { judgement: "under", p50: 160 },
    page: "under",
    next: { judgement: "under", bestP50: 160 },
  },
  {
    name: "under and 40 s worse than the green page pages nothing: under the lines only the lines page",
    lastPage: { judgement: "under", bestP50: 120 },
    judged: { judgement: "under", p50: 160 },
    page: null,
    next: { judgement: "under", bestP50: 120 },
  },
  {
    name: "under before any page pages nothing and keeps nothing",
    lastPage: undefined,
    judged: { judgement: "under", p50: 160 },
    page: null,
    next: undefined,
  },
  {
    name: "too few pushes page nothing and keep what the channel was told",
    lastPage: { judgement: "over", bestP50: 218 },
    judged: { judgement: "too-few" },
    page: null,
    next: { judgement: "over", bestP50: 218 },
  },
  {
    name: "too few pushes before any page page nothing",
    lastPage: undefined,
    judged: { judgement: "too-few" },
    page: null,
    next: undefined,
  },
] as const)("$name", ({ lastPage, judged, page, next }) => {
  expect(pageFor(lastPage, judged)).toEqual({ page, lastPage: next });
});

// Medians the guard judged, replayed from its state: its red page (2026-09-24 18:47, 23 pushes),
// then every third hourly run from 19:47 to 09-26 19:47. They fell to 180 s without going under the
// lines and rose past 200 s from 09-25 22:47. Against the red page's median that rise is never 20 s;
// against the best since, it pages once.
test("a median that recovers while over and then rises more than 20 s pages red again, once", () => {
  const medians = [
    234.1, 210.4, 195.3, 186.2, 184.8, 181.9, 179.9, 183, 189, 183, 202.9, 205.9, 205.1, 207.3,
    208.2, 208.2, 210.2, 208.3,
  ];
  let lastPage: Parameters<typeof pageFor>[0];
  const pages = medians.flatMap((p50) => {
    const owed = pageFor(lastPage, { judgement: "over", p50 });
    lastPage = owed.lastPage;
    return owed.page ? [{ p50, page: owed.page }] : [];
  });
  expect(pages).toEqual([
    { p50: 234.1, page: "over" },
    { p50: 202.9, page: "worse" },
  ]);
  expect(lastPage).toEqual({ judgement: "over", bestP50: 202.9 });
});

test("a red page names the lines, the job that ended the pushes and each group, and mentions Jonas unless it is a test", () => {
  const summary = summarizePushes(
    [
      ...Array.from({ length: 20 }, (_, minute) =>
        push({ seconds: 170 + minute, e2e: "slow-rows-skipped", minute }),
      ),
      push({ seconds: 300, e2e: "every-row", outcome: "red", minute: 21 }),
      push({ seconds: 190, e2e: "no-preview", minute: 22, lastJob: "test.yml:test" }),
    ],
    { from: Date.parse("2026-09-24T12:00:00Z"), to: Date.parse("2026-09-24T13:00:00Z") },
  );
  expect(
    renderPage({
      page: "over",
      summary,
      lastPage: undefined,
      runUrl: "https://depot.dev/run",
      testRun: false,
    }),
  ).toBe(
    [
      "🔴 PR time to green over its lines <@U067G4QRFK2>: pushes that skipped the slow rows, last 24 h: p50 180 s (line 165 s), p90 187 s (line 200 s), n=20",
      "Their critical path ends with preview-os.yml:specs on 20 of the 20",
      "• Preview OS, slow rows skipped: time to green p50 180 s, p90 187 s (n=20; 20 ended by preview-os.yml:specs); first verdict p50 180 s, p90 187 s (n=20, 0 % red)",
      "• Preview OS, every row: none green; first verdict p50 300 s, p90 300 s (n=1, 100 % red)",
      "• Preview OS, no e2e summary: no pushes",
      "• no Preview OS: time to green p50 190 s, p90 190 s (n=1; 1 ended by test.yml:test); first verdict p50 190 s, p90 190 s (n=1, 0 % red)",
      "• every push: time to green p50 180 s, p90 188 s (n=21; 20 ended by preview-os.yml:specs); first verdict p50 181 s, p90 189 s (n=22, 5 % red)",
      "slow rows ran in 5 % of Preview OS pushes; 0 superseded pushes left out",
      "<https://depot.dev/run|the run>",
    ].join("\n"),
  );
  expect(
    renderPage({
      page: "worse",
      summary,
      lastPage: { judgement: "over", bestP50: 158 },
      testRun: false,
    }).split("\n")[0],
  ).toBe(
    "🔴 PR time to green more than 20 s worse again <@U067G4QRFK2>: pushes that skipped the slow rows, last 24 h: p50 180 s (line 165 s; 158 s at best since the last page), p90 187 s (line 200 s), n=20",
  );
  const test = renderPage({ page: "over", summary, lastPage: undefined, testRun: true });
  expect(test).toMatch(/^🧪 TEST RUN 🔴 PR time to green over its lines: /);
  expect(test).not.toContain("<@");
  expect(
    renderPage({
      page: "under",
      summary,
      lastPage: { judgement: "over", bestP50: 180 },
      testRun: false,
    }),
  ).toMatch(/^🟢 PR time to green back under its lines: /);
  // a test page before any push skipped the slow rows
  expect(
    renderPage({
      page: "too-few",
      summary: summarizePushes([], { from: 0, to: 1 }),
      lastPage: undefined,
      testRun: true,
    }).split("\n")[0],
  ).toBe(
    "🧪 TEST RUN ⚪ PR time to green not judged below 20 pushes: pushes that skipped the slow rows, last 24 h: none green",
  );
});

test("one PostHog event per push with a verdict, the same id whenever it is sent", () => {
  const events = pushEvents([
    push({ seconds: 150, e2e: "slow-rows-skipped", minute: 0 }),
    push({ seconds: 300, e2e: "every-row", outcome: "red", minute: 1 }),
    push({ outcome: "superseded", minute: 2 }),
  ]);
  expect(events.map((event) => event.properties)).toMatchObject([
    {
      outcome: "green",
      e2e_rows: "slow-rows-skipped",
      time_to_green_s: 150,
      pull_request_number: 1,
      last_job: "preview-os.yml:specs",
    },
    {
      outcome: "red",
      e2e_rows: "every-row",
      time_to_green_s: undefined,
      time_to_first_verdict_s: 300,
    },
  ]);
  expect(events[0]).toMatchObject({
    event: "pr checks settled",
    timestamp: "2026-09-24T12:02:30.000Z",
  });
  expect(pushEvents([push({ seconds: 150, e2e: "no-preview", minute: 0 })])[0]?.uuid).toBe(
    events[0]?.uuid,
  );
});

// The newest pr-ttg-state artifact of schemaVersion 1 (2026-09-26), cut to one push.
const schemaVersion1 = {
  schemaVersion: 1,
  pushes: [
    {
      run: "j200wskz5n",
      pr: 3225,
      createdAt: "2026-09-26T19:42:23.012Z",
      outcome: "green",
      e2e: "slow-rows-skipped",
      seconds: 178.6,
    },
  ],
  paged: "over",
};

test.for([
  { name: "no previous state starts empty", previous: undefined },
  { name: "a state of another schemaVersion starts over", previous: schemaVersion1 },
])("$name", ({ previous }) => {
  expect(readState(previous)).toEqual({ schemaVersion: 2, pushes: [] });
});

test("a state of this version reads back as written, and one that does not parse throws", () => {
  const state = {
    schemaVersion: 2,
    pushes: [
      push({ seconds: 150, e2e: "no-summary", minute: 0 }),
      push({ outcome: "not-a-push", minute: 1 }),
    ],
    lastPage: { judgement: "over", bestP50: 208 },
  };
  expect(readState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  expect(() => readState({ ...schemaVersion1, schemaVersion: 2 })).toThrow();
});

function workflow(workflowId: string, name: string, status: string, finishedAt: string) {
  return { workflow: { workflowId, name, status, finishedAt }, jobs: [{ attempts: [{}] }] };
}

/** A check whose jobs (by their Depot job key) finished each attempt at `ends`. */
function check(
  workflowId: string,
  name: string,
  status: string,
  finishedAt: string,
  ends: Record<string, string[]>,
): RunMetrics["workflows"][number] {
  return {
    workflow: { workflowId, name, status, finishedAt },
    jobs: Object.entries(ends).map(([jobKey, attempts]) => ({
      job: { jobKey, status: "finished" },
      attempts: attempts.map((end, index) => ({
        attempt: { attempt: index + 1, finishedAt: end },
      })),
    })),
  };
}

/** A Preview OS workflow whose jobs (by their key in preview-os.yml) finished each attempt at `ends`. */
function previewOs(
  workflowId: string,
  status: string,
  finishedAt: string,
  ends: Record<string, string[]>,
) {
  return check(
    workflowId,
    "Preview OS",
    status,
    finishedAt,
    Object.fromEntries(Object.entries(ends).map(([job, at]) => [`preview-os.yml:${job}`, at])),
  );
}

function withWorkflow(
  workflowId: string,
  change: { status: string; finishedAt: string; attempts?: number },
): RunMetrics {
  return {
    ...pxt90nlfvh,
    workflows: pxt90nlfvh.workflows.map((entry) =>
      entry.workflow.workflowId === workflowId
        ? {
            workflow: { ...entry.workflow, status: change.status, finishedAt: change.finishedAt },
            jobs: [{ attempts: Array(change.attempts || 1).fill({}) }],
          }
        : entry,
    ),
  };
}

function push(input: {
  minute: number;
  seconds?: number;
  e2e?: "slow-rows-skipped" | "every-row" | "no-summary" | "no-preview";
  outcome?: "green" | "red" | "superseded" | "not-a-push";
  lastJob?: string;
}) {
  const base = {
    run: `run${input.minute}`,
    pr: 1,
    createdAt: new Date(Date.parse("2026-09-24T12:00:00Z") + input.minute * 60_000).toISOString(),
  };
  const outcome = input.outcome || "green";
  return outcome === "green" || outcome === "red"
    ? {
        ...base,
        outcome,
        e2e: input.e2e!,
        seconds: input.seconds!,
        lastJob: input.lastJob || "preview-os.yml:specs",
      }
    : { ...base, outcome };
}
