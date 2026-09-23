import { expect, test } from "vitest";
import {
  mainE2eFailingRows,
  mainE2ePage,
  mainE2eVerdict,
  previousMainE2eState,
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
  // a newer push superseded the run: no verdict either way
  {
    results: { deploy: "success", e2e: "cancelled", delete: "success" },
    verdict: undefined,
  },
  {
    results: { deploy: "success", e2e: "skipped", delete: "success" },
    verdict: undefined,
  },
  { results: {}, verdict: undefined },
])("jobs $results → $verdict", ({ results, verdict }) => {
  expect(mainE2eVerdict(results)).toBe(verdict);
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
