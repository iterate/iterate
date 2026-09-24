import { expect, test } from "vitest";
import {
  judge,
  LINES,
  measurePush,
  pageFor,
  pushEvents,
  renderPage,
  summarizePushes,
  TtgState,
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

test("a green push's time to green runs from the run's creation to its last check's end, trace included", () => {
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
  });
});

test.each([
  { summary: { slowRows: "skipped" as const }, e2e: "slow-rows-skipped" },
  { summary: { slowRows: "ran" as const }, e2e: "every-row" },
  // a summary written before the slow tag existed: every row ran
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

test.each([
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

test("a cancelled Preview OS is red even when the PR's next run came first: it never cancels for a newer push", () => {
  expect(
    measurePush({
      metrics: withWorkflow("nsbcf2f8mt", {
        status: "cancelled",
        finishedAt: "2026-09-24T12:30:00.000Z",
      }),
      firstExecutions: {},
      nextRunAt: "2026-09-24T11:55:00Z",
      summary: undefined,
    }),
  ).toMatchObject({ outcome: "red", e2e: "no-summary" });
});

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
        push({ seconds, e2e: "slow-rows-skipped", minute: index }),
      ),
      push({ seconds: 400, e2e: "slow-rows-skipped", outcome: "red", minute: 5 }),
      push({ seconds: 300, e2e: "every-row", minute: 6 }),
      push({ seconds: 180, e2e: "no-preview", minute: 7 }),
      push({ outcome: "superseded", minute: 8 }),
      // created before the window
      push({ seconds: 999, e2e: "slow-rows-skipped", minute: -1 }),
    ],
    { from: Date.parse("2026-09-24T12:00:00Z"), to: Date.parse("2026-09-24T13:00:00Z") },
  );
  expect(summary.byRows["slow-rows-skipped"]).toEqual({
    pushes: 6,
    red: 1,
    timeToGreen: { n: 5, p50: 120, p90: 172 },
    firstVerdict: { n: 6, p50: 125, p90: 300 },
  });
  expect(summary.byRows["no-summary"]).toEqual({
    pushes: 0,
    red: 0,
    timeToGreen: undefined,
    firstVerdict: undefined,
  });
  expect(summary.all).toMatchObject({ pushes: 8, red: 1, timeToGreen: { n: 7 } });
  expect(summary).toMatchObject({ slowRowsShare: 1 / 7, superseded: 1 });
});

test.each([
  { seconds: [150], judgement: "too-few" },
  { seconds: Array(20).fill(150), judgement: "under" },
  { seconds: Array(20).fill(165), judgement: "under" },
  { seconds: Array(20).fill(166), judgement: "over" },
  // p50 150 s, p90 over 200 s
  { seconds: [...Array(17).fill(150), 250, 250, 250], judgement: "over" },
])("judges $judgement", ({ seconds, judgement }) => {
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
  ).toBe(judgement);
  expect(LINES).toEqual({ p50: 165, p90: 200, minPushes: 20 });
});

test.each([
  { paged: "under", judgement: "over", page: "over" },
  { paged: "over", judgement: "over", page: null },
  { paged: "over", judgement: "under", page: "under" },
  { paged: "under", judgement: "under", page: null },
  { paged: "over", judgement: "too-few", page: null },
  { paged: "under", judgement: "too-few", page: null },
] as const)("told $paged, judged $judgement → pages $page", ({ paged, judgement, page }) => {
  expect(pageFor(paged, judgement)).toBe(page);
});

test("a red page names the lines and each group, and mentions Jonas unless it is a test", () => {
  const summary = summarizePushes(
    [
      ...Array.from({ length: 20 }, (_, minute) =>
        push({ seconds: 170 + minute, e2e: "slow-rows-skipped", minute }),
      ),
      push({ seconds: 300, e2e: "every-row", outcome: "red", minute: 21 }),
      push({ seconds: 190, e2e: "no-preview", minute: 22 }),
    ],
    { from: Date.parse("2026-09-24T12:00:00Z"), to: Date.parse("2026-09-24T13:00:00Z") },
  );
  expect(
    renderPage({ page: "over", summary, runUrl: "https://depot.dev/run", testRun: false }),
  ).toBe(
    [
      "🔴 PR time to green over its lines <@U067G4QRFK2>: pushes that skipped the slow rows, last 24 h: p50 180 s (line 165 s), p90 187 s (line 200 s), n=20",
      "• Preview OS, slow rows skipped: time to green p50 180 s, p90 187 s (n=20); first verdict p50 180 s, p90 187 s (n=20, 0 % red)",
      "• Preview OS, every row: none green; first verdict p50 300 s, p90 300 s (n=1, 100 % red)",
      "• Preview OS, no e2e summary: no pushes",
      "• no Preview OS: time to green p50 190 s, p90 190 s (n=1); first verdict p50 190 s, p90 190 s (n=1, 0 % red)",
      "• every push: time to green p50 180 s, p90 188 s (n=21); first verdict p50 181 s, p90 189 s (n=22, 5 % red)",
      "slow rows ran in 5 % of Preview OS pushes; 0 superseded pushes left out",
      "<https://depot.dev/run|the run>",
    ].join("\n"),
  );
  const test = renderPage({ page: "over", summary, testRun: true });
  expect(test).toMatch(/^🧪 TEST RUN 🔴 PR time to green over its lines: /);
  expect(test).not.toContain("<@");
  expect(renderPage({ page: "under", summary, testRun: false })).toMatch(
    /^🟢 PR time to green back under its lines: /,
  );
  // a test page before any push skipped the slow rows
  expect(
    renderPage({
      page: "too-few",
      summary: summarizePushes([], { from: 0, to: 1 }),
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

test("the state round-trips through its schema", () => {
  const state = {
    schemaVersion: 1,
    pushes: [
      push({ seconds: 150, e2e: "no-summary", minute: 0 }),
      push({ outcome: "not-a-push", minute: 1 }),
    ],
    paged: "over",
  };
  expect(TtgState.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
});

function workflow(workflowId: string, name: string, status: string, finishedAt: string) {
  return { workflow: { workflowId, name, status, finishedAt }, jobs: [{ attempts: [{}] }] };
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
}) {
  const base = {
    run: `run${input.minute}`,
    pr: 1,
    createdAt: new Date(Date.parse("2026-09-24T12:00:00Z") + input.minute * 60_000).toISOString(),
  };
  const outcome = input.outcome || "green";
  return outcome === "green" || outcome === "red"
    ? { ...base, outcome, e2e: input.e2e!, seconds: input.seconds! }
    : { ...base, outcome };
}
