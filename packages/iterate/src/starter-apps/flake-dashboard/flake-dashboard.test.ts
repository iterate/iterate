import { expect, test, vi } from "vitest";
import { makeProcessorHarness } from "../../processors/testing.ts";
import {
  FlakeDashboardProcessorContract,
  flakeEventTypes,
  type FlakeDashboardState,
} from "./contract.ts";
import { FlakeDashboardProcessor } from "./processor.ts";

test("folds CI-reported records into per-test stats", async () => {
  const h = makeHarness();
  await h.append(birth(), runRecorded(1, [record("deploy", "flake-fail", { at: day(0) })]));
  await h.append(
    runRecorded(
      2,
      [record("deploy", "pass", { at: day(1) }), record("boot", "pass", { at: day(1) })],
      {
        suite: "e2e",
      },
    ),
  );

  expect(h.state().tests).toMatchObject({
    deploy: {
      pattern: "CPU startup time exceeded",
      suites: ["unit", "e2e"],
      counts: { pass: 1, flakeFail: 1, unexpectedError: 0 },
      lastFlakeAt: day(0),
    },
    boot: { counts: { pass: 1 } },
  });
});

test("default-branch streaks ignore other branches and reset on unexpected errors", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [record("deploy", "pass", { at: day(0) })]),
    runRecorded(2, [record("deploy", "pass", { at: day(1) })]),
    runRecorded(3, [record("deploy", "flake-fail", { at: day(2) })], { branch: "some-pr" }),
  );
  // The PR-branch flake neither breaks nor extends the main-branch streak.
  expect(h.state().tests.deploy!.defaultBranchStreak).toMatchObject({
    outcome: "pass",
    runs: 2,
    firstAt: day(0),
    lastAt: day(1),
  });

  await h.append(runRecorded(4, [record("deploy", "unexpected-error", { at: day(3) })]));
  expect(h.state().tests.deploy!.defaultBranchStreak).toBeNull();
});

test("a long passing streak proposes exactly one unwrap", async () => {
  const h = makeHarness();
  await h.append(birth());
  // 50 consecutive main passes spread over 10 days: crosses both the run
  // count and the minimum span.
  for (let i = 0; i < 50; i++) {
    await h.append(runRecorded(i, [record("deploy", "pass", { at: day(i / 5) })]));
  }
  const proposals = h.events(flakeEventTypes.transitionProposed);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.payload).toMatchObject({
    testName: "deploy",
    transition: "unwrap",
    evidence: { consecutiveRuns: 50, firstAt: day(0) },
  });

  // The streak keeps growing; the proposal does not repeat.
  await h.append(runRecorded(50, [record("deploy", "pass", { at: day(11) })]));
  expect(h.events(flakeEventTypes.transitionProposed)).toHaveLength(1);
  expect(h.state().tests.deploy!.proposed).toEqual([`unwrap:${day(0)}`]);
});

test("a fast passing streak proposes nothing until the span threshold is met", async () => {
  const h = makeHarness();
  await h.append(birth());
  // 60 passes within one day: plenty of runs, not enough elapsed time — the
  // sentinel-derived guard against unwrapping on a lucky burst.
  for (let i = 0; i < 60; i++) {
    await h.append(runRecorded(i, [record("deploy", "pass", { at: day(i / 100) })]));
  }
  expect(h.events(flakeEventTypes.transitionProposed)).toHaveLength(0);
});

test("a never-passing test proposes switch-to-failing", async () => {
  const h = makeHarness();
  await h.append(birth());
  for (let i = 0; i < 25; i++) {
    await h.append(runRecorded(i, [record("deploy", "flake-fail", { at: day(i / 10) })]));
  }
  expect(h.events(flakeEventTypes.transitionProposed)).toMatchObject([
    { payload: { testName: "deploy", transition: "switch-to-failing" } },
  ]);
});

test("renders the dashboard once caught up and settles the attempt durably", async () => {
  const renderDashboard = vi.fn(async (_state: FlakeDashboardState) => ({
    status: "succeeded" as const,
    issueNumber: 7,
    issueUrl: "https://github.com/iterate/iterate/issues/7",
  }));
  const h = makeHarness(renderDashboard);
  await h.append(birth(), runRecorded(1, [record("deploy", "flake-fail", { at: day(0) })]));

  expect(renderDashboard).toHaveBeenCalled();
  expect(h.state().render).toMatchObject({ issueNumber: 7 });
  const settled = h.events(flakeEventTypes.dashboardRenderSettled);
  expect(settled.at(-1)!.payload).toMatchObject({
    result: { status: "succeeded", issueNumber: 7 },
  });

  // No new data → no further renders; the settled event must not demand one.
  const rendersSoFar = renderDashboard.mock.calls.length;
  await h.settle();
  expect(renderDashboard.mock.calls.length).toBe(rendersSoFar);

  // New data → exactly one more render.
  await h.append(runRecorded(2, [record("deploy", "pass", { at: day(1) })]));
  expect(renderDashboard.mock.calls.length).toBe(rendersSoFar + 1);
});

test("a failed render settles as failed and the retry can still settle success at the same offset", async () => {
  const renderDashboard = vi
    .fn(async (_state: FlakeDashboardState) => ({
      status: "succeeded" as const,
      issueNumber: 7,
      issueUrl: "https://github.com/iterate/iterate/issues/7",
    }))
    .mockRejectedValueOnce(new Error("GitHub is down"));
  const h = makeHarness(renderDashboard);
  await h.append(birth(), runRecorded(1, [record("deploy", "pass", { at: day(0) })]));

  // The failed settlement's own delivery re-drives a retry at the SAME data
  // offset, and the success must land — the failed settlement must not have
  // claimed the offset's only idempotency key (its status is part of the key).
  const settled = h.events(flakeEventTypes.dashboardRenderSettled);
  expect(settled.map((event) => (event.payload as any).result.status)).toEqual([
    "failed",
    "succeeded",
  ]);
  expect((settled[0]!.payload as any).throughOffset).toBe(
    (settled[1]!.payload as any).throughOffset,
  );
  expect(h.state().render).toMatchObject({ issueNumber: 7 });
});

test("refold after a crash reproduces the same state", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [record("deploy", "flake-fail", { at: day(0) })]),
    runRecorded(2, [record("deploy", "pass", { at: day(1) })]),
  );
  const before = h.state();
  h.crash();
  // Revival comes from the durable recovery alarm, not settle(): a crashed
  // incarnation re-delivers from its checkpoint when the alarm fires.
  await h.advanceTime(24 * 60 * 60 * 1000);
  expect(h.state()).toEqual(before);
});

// --- helpers ---

function makeHarness(
  renderDashboard: (
    state: FlakeDashboardState,
  ) => Promise<{ status: "succeeded"; issueNumber: number; issueUrl: string }> = async () => ({
    status: "succeeded",
    issueNumber: 1,
    issueUrl: "https://github.com/iterate/iterate/issues/1",
  }),
) {
  return makeProcessorHarness<FlakeDashboardProcessorContract, FlakeDashboardProcessor>({
    createProcessor: (deps) => new FlakeDashboardProcessor({ ...deps, renderDashboard }),
    path: "/flakes",
  });
}

function birth() {
  return {
    type: flakeEventTypes.created,
    idempotencyKey: "flakes/created",
    payload: {
      config: {
        repository: { owner: "iterate", repo: "iterate" },
        issueTitle: "Flake dashboard",
        defaultBranch: "main",
      },
    },
  } as const;
}

function runRecorded(
  n: number,
  records: ReturnType<typeof record>[],
  overrides?: { branch?: string; suite?: string },
) {
  return {
    type: flakeEventTypes.runRecorded,
    idempotencyKey: `flakes/run:${n}:${overrides?.suite || "unit"}`,
    payload: {
      runId: `run-${n}`,
      suite: overrides?.suite || "unit",
      branch: overrides?.branch || "main",
      commit: `commit-${n}`,
      records,
    },
  } as const;
}

function record(
  name: string,
  outcome: "pass" | "flake-fail" | "unexpected-error",
  overrides: { at: string },
) {
  return {
    name,
    outcome,
    pattern: "CPU startup time exceeded",
    durationMs: 5,
    at: overrides.at,
  };
}

/** ISO timestamp `days` (fractional ok) after a fixed epoch. */
function day(days: number) {
  return new Date(Date.UTC(2026, 0, 1) + days * 24 * 60 * 60 * 1000).toISOString();
}
