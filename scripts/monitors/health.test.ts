import { expect, test } from "vitest";
import { readState, renderMessage } from "./health.ts";

const now = [
  { name: "main e2e", tone: "red" as const },
  { name: "slow e2e rows", tone: "green" as const },
  { name: "real-model e2e", tone: "none" as const },
  { name: "latency", tone: "green" as const },
  { name: "PR time to green", tone: "red" as const },
];

test("one message: each page as a block, the first red one mentioning Jonas, then every signal now", () => {
  expect(
    renderMessage({
      pages: [
        {
          tone: "green",
          headline: "latency back under its lines at `3b6b1c8b0`",
          details: ["sign-in median 400 ms (budget 1,500, baseline 380 ms, 1.1×)"],
          link: "https://depot.dev/latency",
        },
        {
          tone: "red",
          headline: "main e2e red at `012345678` (A change)",
          details: ["failed: E2E tests", "failing rows: a row"],
          link: "https://depot.dev/main",
        },
        {
          tone: "red",
          headline: "PR time to green over its lines: p50 180 s",
          details: [],
        },
      ],
      now,
      testRun: false,
    }),
  ).toBe(
    [
      "🟢 latency back under its lines at `3b6b1c8b0`",
      "• sign-in median 400 ms (budget 1,500, baseline 380 ms, 1.1×)",
      "<https://depot.dev/latency|the run>",
      "🔴 main e2e red at `012345678` (A change) <@U067G4QRFK2>",
      "• failed: E2E tests",
      "• failing rows: a row",
      "<https://depot.dev/main|the run>",
      "🔴 PR time to green over its lines: p50 180 s",
      "now: 🔴 main e2e · 🟢 slow e2e rows · ⚪ real-model e2e · 🟢 latency · 🔴 PR time to green",
    ].join("\n"),
  );
});

test("a test page is marked and mentions nobody", () => {
  const text = renderMessage({
    pages: [{ tone: "red", headline: "main e2e red at `012345678`", details: [] }],
    now,
    testRun: true,
  });
  expect(text.split("\n")[0]).toBe("🧪 TEST RUN 🔴 main e2e red at `012345678`");
  expect(text).not.toContain("<@");
});

test.for([
  { name: "no previous state starts empty", previous: undefined },
  { name: "a state of another schemaVersion starts over", previous: { schemaVersion: 2 } },
  // what pr-ttg.yml kept before the health job
  {
    name: "the time-to-green guard's own state starts over",
    previous: { schemaVersion: 2, pushes: [] },
  },
])("$name", ({ previous }) => {
  // exact: starting over remembers nothing
  expect(readState(previous)).toEqual({
    schemaVersion: 1,
    ttg: { pushes: [] },
    latency: { runs: [], red: [] },
    e2e: { suites: {}, judgedAt: {} },
  });
});

test("a state of this version reads back as written, and one that does not parse throws", () => {
  const state = {
    schemaVersion: 1,
    ttg: { pushes: [], lastPage: { judgement: "over", bestP50: 208 } },
    latency: { runs: [], red: ["sign-in"], judgedAt: "2026-09-26T21:29:00.000Z" },
    e2e: {
      suites: { "main e2e": "green", "slow e2e rows": "red" },
      judgedAt: { "Main OS e2e": "2026-09-26T20:00:00.000Z" },
    },
  };
  // exact: the state reads back untouched
  expect(readState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  expect(() => readState({ ...state, latency: { runs: "none" } })).toThrow();
});
