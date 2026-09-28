// What a signal's verdict owes its page (./page.ts): the action for every change of state, and the
// memory a red or unjudged signal keeps. Rendering is each check's; sending is ./health.ts's.
import { expect, test } from "vitest";
import { z } from "zod";
import { mainE2eFailedJobs, mainE2eVerdict, suiteUpdate, type E2eMemory } from "./e2e.ts";
import fixture from "./fixtures/main-e2e-runs-2026-09-23.json" with { type: "json" };
import { advance, decide, type PageState } from "./page.ts";

test.for<{
  name: string;
  previous: PageState | undefined;
  next: PageState;
  worse: boolean;
  action: string | null;
}>([
  {
    name: "a first green owes nothing",
    previous: undefined,
    next: "green",
    worse: false,
    action: null,
  },
  {
    name: "a first red posts a page",
    previous: undefined,
    next: "red",
    worse: false,
    action: "post",
  },
  {
    name: "green after green owes nothing",
    previous: "green",
    next: "green",
    worse: false,
    action: null,
  },
  {
    name: "red after green posts a page",
    previous: "green",
    next: "red",
    worse: false,
    action: "post",
  },
  {
    name: "unjudged after green posts a page",
    previous: "green",
    next: "broken",
    worse: false,
    action: "post",
  },
  {
    name: "red after red edits the page",
    previous: "red",
    next: "red",
    worse: false,
    action: "edit",
  },
  {
    name: "worse red after red escalates",
    previous: "red",
    next: "red",
    worse: true,
    action: "escalate",
  },
  {
    name: "unjudged after unjudged edits",
    previous: "broken",
    next: "broken",
    worse: false,
    action: "edit",
  },
  {
    name: "green after red resolves",
    previous: "red",
    next: "green",
    worse: false,
    action: "resolve",
  },
  {
    name: "green after unjudged resolves",
    previous: "broken",
    next: "green",
    worse: false,
    action: "resolve",
  },
  {
    name: "unjudged after red replaces the page",
    previous: "red",
    next: "broken",
    worse: false,
    action: "replace",
  },
  {
    name: "red after unjudged replaces the page",
    previous: "broken",
    next: "red",
    worse: false,
    action: "replace",
  },
])("$name", ({ previous, next, worse, action }) => {
  expect(decide(previous, next, worse)).toBe(action);
});

test.for([
  {
    name: "a red run after green opens a streak at its commit",
    previous: { state: "green" as const },
    verdict: { state: "red" as const, sha: "aaa", failures: ["E2E tests", "a row"] },
    expected: {
      action: "post",
      news: [],
      memory: { state: "red", since: "aaa", runs: 1, failures: ["E2E tests", "a row"] },
    },
  },
  {
    name: "a red run naming what the page named edits it and counts the run",
    previous: { state: "red" as const, since: "aaa", runs: 1, failures: ["E2E tests", "a row"] },
    verdict: { state: "red" as const, sha: "bbb", failures: ["a row"] },
    expected: {
      action: "edit",
      news: [],
      memory: { state: "red", since: "aaa", runs: 2, failures: ["E2E tests", "a row"] },
    },
  },
  {
    name: "a red run naming a new failure escalates and adds it",
    previous: { state: "red" as const, since: "aaa", runs: 2, failures: ["E2E tests", "a row"] },
    verdict: { state: "red" as const, sha: "ccc", failures: ["E2E tests", "another row"] },
    expected: {
      action: "escalate",
      news: ["another row"],
      memory: {
        state: "red",
        since: "aaa",
        runs: 3,
        failures: ["E2E tests", "a row", "another row"],
      },
    },
  },
  {
    name: "an unjudged run after red starts a streak of its own",
    previous: { state: "red" as const, since: "aaa", runs: 3, failures: ["E2E tests"] },
    verdict: { state: "broken" as const, sha: "ddd", failures: [] },
    expected: {
      action: "replace",
      news: [],
      memory: { state: "broken", since: "ddd", runs: 1, failures: [] },
    },
  },
  {
    name: "green forgets the streak",
    previous: { state: "red" as const, since: "aaa", runs: 3, failures: ["E2E tests"] },
    verdict: { state: "green" as const, sha: "eee", failures: [] },
    expected: { action: "resolve", news: [], memory: { state: "green" } },
  },
])("$name", ({ previous, verdict, expected }) => {
  // exact: the memory keeps the streak and nothing more
  expect(advance(previous, verdict)).toEqual(expected);
});

// Main OS e2e's push runs from 2026-09-23 20:55 to 2026-09-28 12:01 UTC, as Depot recorded their
// jobs' results (fixtures/main-e2e-runs-2026-09-23.json): 286 settled runs, and each red that the
// channel heard as 18 messages is one page, its edits and its resolution.
test("main e2e over Depot's runs of 2026-09-23..28 is 9 pages, 4 edits and 9 resolutions", () => {
  let memory: E2eMemory["suites"]["main e2e"];
  const kinds: Record<string, number> = {};
  const runs = z
    .array(z.object({ sha: z.string(), results: z.record(z.string(), z.string()) }))
    .parse(fixture);
  for (const { sha, results } of runs) {
    const judged = suiteUpdate({
      suite: "main e2e",
      previous: memory,
      verdict: mainE2eVerdict(results),
      commit: { sha, subject: "" },
      failedJobs: mainE2eFailedJobs(results),
      failingRows: [],
      testRun: false,
    });
    memory = judged.memory;
    if (judged.update) kinds[judged.update.kind] = (kinds[judged.update.kind] || 0) + 1;
  }
  // exact: no escalation, since each red streak failed the same job throughout
  expect(kinds).toEqual({ post: 9, edit: 4, resolve: 9 });
});
