import { expect, test } from "vitest";
import {
  mainE2eFailedJobs,
  mainE2eFailingRows,
  mainE2ePage,
  mainE2eVerdict,
  previousMainE2eState,
  suiteVerdict,
} from "./main-e2e-alert.ts";

test.each<{ results: Record<string, string>; verdict: string | undefined }>([
  {
    results: { deploy: "success", e2e: "success", delete: "success" },
    verdict: "green",
  },
  {
    results: { deploy: "success", e2e: "failure", delete: "success" },
    verdict: "red",
  },
  {
    results: { deploy: "failure", e2e: "skipped", delete: "success" },
    verdict: "red",
  },
  // a failed cleanup left garbage behind: red too
  {
    results: { deploy: "success", e2e: "success", delete: "failure" },
    verdict: "red",
  },
  // a job that hit its timeout, which Depot reports as cancelled: red (a run cancelled by hand
  // never reaches the alert)
  {
    results: { deploy: "success", e2e: "cancelled", delete: "success" },
    verdict: "red",
  },
  {
    results: { parent: "cancelled", deploy: "skipped", e2e: "skipped", delete: "success" },
    verdict: "red",
  },
  {
    results: { deploy: "success", e2e: "skipped", delete: "success" },
    verdict: undefined,
  },
  { results: {}, verdict: undefined },
])("jobs $results → $verdict", ({ results, verdict }) => {
  expect(mainE2eVerdict(results)).toBe(verdict);
});

test("a red page names each failed job, and each cancelled one as timed out", () => {
  expect(
    mainE2eFailedJobs({
      parent: "success",
      deploy: "success",
      e2e: "cancelled",
      delete: "failure",
    }),
  ).toEqual(["e2e (timed out)", "delete"]);
});

test.each([
  { previous: "green", verdict: "red", pages: "red" },
  { previous: "red", verdict: "green", pages: "green" },
  { previous: "red", verdict: "red", pages: null },
  { previous: "green", verdict: "green", pages: null },
  { previous: "green", verdict: undefined, pages: null },
  { previous: "red", verdict: undefined, pages: null },
] as const)(
  "main was $previous, this run is $verdict → pages $pages",
  ({ previous, verdict, pages }) => {
    const page = mainE2ePage({
      previous,
      verdict,
      commitSha: "0123456789abcdef",
      commitSubject: "Some change (#1)",
      failedJobs: ["e2e"],
      failingRows: ["files.e2e.test.ts: reads a file"],
      runUrl: "https://depot.dev/run",
    });
    if (!pages) return expect(page).toBeNull();
    expect(page?.startsWith(pages === "red" ? "🔴 main e2e red" : "🟢 main e2e green again")).toBe(
      true,
    );
  },
);

test("a red page names the commit, the failed jobs and the failing rows, and mentions Jonas", () => {
  expect(
    mainE2ePage({
      previous: "green",
      verdict: "red",
      commitSha: "0123456789abcdef",
      commitSubject: "Some change (#1)",
      failedJobs: ["e2e", "delete"],
      failingRows: Array.from({ length: 10 }, (_, index) => `f.e2e.test.ts: row ${index}`),
      runUrl: "https://depot.dev/run",
    }),
  ).toBe(
    [
      "🔴 main e2e red at `012345678` (Some change (#1)) <@U067G4QRFK2>",
      "• failed: e2e, delete",
      "• failing rows: f.e2e.test.ts: row 0; f.e2e.test.ts: row 1; f.e2e.test.ts: row 2; f.e2e.test.ts: row 3; f.e2e.test.ts: row 4; f.e2e.test.ts: row 5; f.e2e.test.ts: row 6; f.e2e.test.ts: row 7; … and 2 more",
      "<https://depot.dev/run|the run>",
    ].join("\n"),
  );
});

test.each([
  { messages: [], state: "green" },
  { messages: [{ bot_id: "B", text: "🔴 main e2e red at `x`" }], state: "red" },
  {
    messages: [
      { bot_id: "B", text: "🟢 main e2e green again at `y`" },
      { bot_id: "B", text: "🔴 main e2e red at `x`" },
    ],
    state: "green",
  },
  // other bots' pages and people's replies are not this alert's state
  {
    messages: [
      { bot_id: "B", text: "🚨 prd fault page: …" },
      { text: "🟢 main e2e green again, says a person" },
      { bot_id: "B", text: "🔴 main e2e red at `x`" },
    ],
    state: "red",
  },
])("the channel's newest main e2e page is the state: $state", ({ messages, state }) => {
  expect(previousMainE2eState(messages)).toBe(state);
});

test("failing rows are the unexpected (Playwright) or failed (vitest) tests, once each", () => {
  const artifact = (tests: { state: string; outcome?: string; name: string; module: string }[]) =>
    ({
      tests: tests.map((row) => ({
        fullName: `suite > ${row.name}`,
        leafName: row.name,
        moduleId: `/repo/apps/os/e2e/${row.module}`,
        state: row.state,
        outcome: row.outcome,
      })),
    }) as unknown as Parameters<typeof mainE2eFailingRows>[0][number];
  expect(
    mainE2eFailingRows([
      artifact([
        { state: "passed", name: "fine", module: "a.e2e.test.ts" },
        { state: "failed", name: "broken", module: "a.e2e.test.ts" },
        { state: "timedOut", name: "slow", module: "b.e2e.test.ts" },
      ]),
      artifact([
        { state: "failed", outcome: "flaky", name: "retried green", module: "c.spec.ts" },
        { state: "failed", outcome: "unexpected", name: "red spec", module: "c.spec.ts" },
        { state: "failed", name: "broken", module: "a.e2e.test.ts" },
      ]),
    ]),
  ).toEqual(["a.e2e.test.ts: broken", "b.e2e.test.ts: slow", "c.spec.ts: red spec"]);
});

// A suite: the rows tagged `slow` of main's e2e run, or the `REAL:` rows of the real-model suite.
test.each<{ label: string; rows: Row[]; status?: string; verdict: unknown }>([
  {
    label: "every slow row passed, the rest of the run skipped or failed",
    rows: [
      { name: "the careless facet", state: "passed", tags: ["slow"] },
      { name: "a plain row", state: "failed" },
      { name: "a skipped row", state: "skipped" },
    ],
    status: "failed",
    verdict: { verdict: "green", failingRows: [] },
  },
  {
    label: "a failed slow row, named with its first failure",
    rows: [
      { name: "the careless facet", state: "passed", tags: ["slow"] },
      {
        name: "the chatty facet",
        state: "failed",
        tags: ["slow"],
        firstFailure: "Error: resident",
      },
    ],
    verdict: {
      verdict: "red",
      failingRows: ["f.e2e.test.ts: the chatty facet (Error: resident)"],
    },
  },
  { label: "no telemetry", rows: [], verdict: { broken: "no test telemetry" } },
  {
    label: "no row tagged slow",
    rows: [{ name: "a plain row", state: "passed" }],
    verdict: { broken: "no row tagged slow" },
  },
  {
    label: "a slow row not run",
    rows: [
      { name: "the careless facet", state: "passed", tags: ["slow"] },
      { name: "the chatty facet", state: "skipped", tags: ["slow"] },
    ],
    verdict: { broken: expect.stringContaining("1 row(s) tagged slow did not run (skipped)") },
  },
  {
    label: "a runner that did not finish",
    rows: [{ name: "the careless facet", state: "passed", tags: ["slow"] }],
    status: "interrupted",
    verdict: { broken: "a test run ended interrupted" },
  },
])("tagged slow: $label", ({ rows, status, verdict }) => {
  expect(suiteVerdict(rows.length ? [artifact(rows, status)] : [], { tag: "slow" })).toEqual(
    verdict,
  );
});

test.each<{ label: string; rows: Row[]; verdict: unknown }>([
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
        "f.e2e.test.ts: REAL: one turn through the default model (Error: the AI Gateway's spend cap refused the model request)",
      ],
    },
  },
  {
    label: "REAL: rows skipped (E2E_REAL_MODELS unset)",
    rows: [{ name: "REAL: one turn through the default model", state: "skipped" }],
    verdict: { broken: expect.stringContaining("titled REAL: did not run (skipped)") },
  },
])("titled REAL: $label", ({ rows, verdict }) => {
  expect(suiteVerdict([artifact(rows)], { titlePrefix: "REAL:" })).toEqual(verdict);
});

test.each(["slow e2e rows", "real-model e2e"])(
  "the %s suite's pages name no jobs, and its state is its own, never main e2e's",
  (suite) => {
    const page = mainE2ePage({
      suite,
      previous: "green",
      verdict: "red",
      commitSha: "0123456789abcdef",
      commitSubject: "Some change (#1)",
      failedJobs: [],
      failingRows: ["f.e2e.test.ts: a row"],
    });
    expect(page).toBe(
      `🔴 ${suite} red at \`012345678\` (Some change (#1)) <@U067G4QRFK2>\n• failing rows: f.e2e.test.ts: a row`,
    );
    const history = [
      { bot_id: "B", text: page! },
      { bot_id: "B", text: "🟢 main e2e green again at `x`" },
    ];
    expect(previousMainE2eState(history, suite)).toBe("red");
    expect(previousMainE2eState(history)).toBe("green");
  },
);

type Row = { name: string; state: string; tags?: string[]; firstFailure?: string };

/** The parts of a vitest telemetry artifact a suite's verdict reads. */
function artifact(
  rows: Row[],
  status = rows.some((row) => row.state === "failed") ? "failed" : "passed",
) {
  return {
    run: { status },
    tests: rows.map((row) => ({
      fullName: row.name,
      leafName: row.name,
      moduleId: "/repo/apps/os/e2e/f.e2e.test.ts",
      state: row.state,
      tags: row.tags || [],
      firstFailure: row.firstFailure,
    })),
  } as unknown as Parameters<typeof suiteVerdict>[0][number];
}
