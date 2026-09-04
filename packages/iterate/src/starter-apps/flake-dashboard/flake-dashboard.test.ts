import { strToU8, zipSync } from "fflate";
import { expect, test, vi } from "vitest";
import { makeProcessorHarness } from "../../processors/testing.ts";
import {
  FlakeDashboardProcessorContract,
  flakeEventTypes,
  CheckRunWebhookEvent,
  type FlakeDashboardState,
} from "./contract.ts";
import { FlakeDashboardApp, FlakeDashboardProcessor, renderBody } from "./worker.ts";

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
      counts: { pass: 1, "flake-fail": 1 },
      lastFlakeAt: day(0),
    },
    boot: { counts: { pass: 1 } },
  });
});

test("a renamed test's old row retires once absent from 3 suite runs, not before", async () => {
  // The specs suite runs on PR branches only (cloudflare-previews.yml has no
  // push trigger), so expiry must work from PR-branch runs alone — but a
  // 3-run window means no single PR push can hide a row by itself.
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [record("old name", "flake-fail", { at: day(0) })], {
      suite: "specs",
      branch: "some-pr",
    }),
  );
  expect(renderBody(h.state(), Date.UTC(2026, 0, 10))).toContain("`old name`");

  // Two runs carrying only the new name: the old row is still within the
  // suite's 3-run window, so it stays.
  for (const n of [2, 3]) {
    await h.append(
      runRecorded(n, [record("new name", "pass", { at: day(n) })], {
        suite: "specs",
        branch: "rename-pr",
      }),
    );
  }
  expect(renderBody(h.state(), Date.UTC(2026, 0, 10))).toContain("`old name`");

  // The third absent run pushes the old name out of the window: retired —
  // hidden from the table, never deleted from state.
  await h.append(
    runRecorded(4, [record("new name", "pass", { at: day(4) })], {
      suite: "specs",
      branch: "another-pr",
    }),
  );
  const body = renderBody(h.state(), Date.UTC(2026, 0, 10));
  expect(body).not.toContain("`old name`");
  expect(body).toContain("`new name`");
  expect(body).toContain("1 retired test hidden");
  expect(h.state().tests["old name"]).toBeDefined();
});

test("a transiently-absent test survives the window and returns with its history intact", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [record("deploy", "flake-fail", { at: day(0) })]),
    // A partial run (a push-cancelled suite that died before this test) does
    // not retire the row — one absent run is inside the 3-run window...
    runRecorded(2, [record("boot", "pass", { at: day(1) })]),
  );
  expect(renderBody(h.state(), Date.UTC(2026, 0, 10))).toContain("`deploy`");
  // ...and its next record resets the window, counts accumulated across the
  // gap — expiry is a projection choice over the log, nothing was deleted.
  await h.append(runRecorded(3, [record("deploy", "pass", { at: day(2) })]));
  expect(renderBody(h.state(), Date.UTC(2026, 0, 10))).toContain("`deploy`");
  expect(h.state().tests.deploy!.counts).toMatchObject({ pass: 1, "flake-fail": 1 });
});

test("a multi-suite test stays visible while any of its suites still carries it", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [record("flake sentinel", "pass", { at: day(0) })], { suite: "unit" }),
    runRecorded(2, [record("flake sentinel", "pass", { at: day(0) })], { suite: "local-smoke" }),
    // Three unit runs without the sentinel retire it from unit's window —
    // but it is still in local-smoke's latest run, so the row stays.
    runRecorded(3, [record("boot", "pass", { at: day(1) })], { suite: "unit" }),
    runRecorded(4, [record("boot", "pass", { at: day(1) })], { suite: "unit" }),
    runRecorded(5, [record("boot", "pass", { at: day(1) })], { suite: "unit" }),
  );
  expect(renderBody(h.state(), Date.UTC(2026, 0, 10))).toContain("`flake sentinel`");
});

test("streak squares show up to 10 outcomes from any branch, oldest first", async () => {
  const h = makeHarness();
  await h.append(birth(), runRecorded(0, [record("deploy", "flake-fail", { at: day(0) })]));
  for (let i = 1; i <= 8; i++) {
    await h.append(runRecorded(i, [record("deploy", "pass", { at: day(i) })]));
  }
  // A PR-branch outcome enters the bar too — the specs and preview-e2e
  // suites only ever run on PRs, so a main-only bar would stay empty for
  // the suites where most flakes live.
  await h.append(
    runRecorded(99, [record("deploy", "unexpected-error", { at: day(9) })], {
      branch: "some-pr",
    }),
  );
  const row = renderBody(h.state(), Date.UTC(2026, 0, 10))
    .split("\n")
    .find((line) => line.startsWith("`deploy`"))!;
  // Squares in recorded order, each linking to the commit that produced it.
  expect(row.match(/🟥|🟩|❌/gu)).toEqual(["🟥", ...Array<string>(8).fill("🟩"), "❌"]);
  expect(row).toContain("[🟥](https://github.com/iterate/iterate/commit/commit-0)");
  expect(row).toContain("[❌](https://github.com/iterate/iterate/commit/commit-99)");
  // The numeric default-branch streak rides below the squares.
  expect(row).toContain("<br>8× pass (main)");

  // An 11th outcome evicts the oldest: the bar caps at 10.
  await h.append(runRecorded(10, [record("deploy", "pass", { at: day(10) })]));
  expect(h.state().tests.deploy!.recent).toEqual([
    ...Array.from({ length: 8 }, (_, i) => ({ outcome: "pass", commit: `commit-${i + 1}` })),
    { outcome: "unexpected-error", commit: "commit-99" },
    { outcome: "pass", commit: "commit-10" },
  ]);
});

test("info and stats render as line-per-fact cells with readable dates", async () => {
  const h = makeHarness();
  await h.append(birth(), runRecorded(1, [record("deploy", "flake-fail", { at: day(0) })]));
  const row = renderBody(h.state(), Date.UTC(2026, 0, 10))
    .split("\n")
    .find((line) => line.startsWith("`deploy`"))!;
  expect(row).toContain("pattern: `/CPU startup time exceeded/`<br>suites: unit");
  expect(row).toContain("runs: 1<br>flake rate: 100%<br>last flake: Jan 1, 12:00am");
});

test("rows group into sections by kind, sentinels split out of Flakes", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [
      record("deploy", "flake-fail", { at: day(0) }),
      record("flake sentinel", "pass", { at: day(0) }),
      record("stale facet", "pinned-fail", { at: day(0), kind: "failing" }),
      record("chat upload", "retried-pass", {
        at: day(0),
        kind: "unknown",
        error: "Timeout 30000ms exceeded | waiting for getByLabel('attachment')",
      }),
    ]),
  );
  const body = renderBody(h.state(), Date.parse(day(1)));
  // Section order and membership: each row under its own heading.
  const order = [
    "## Flakes",
    "`deploy`",
    "## Failures",
    "`stale facet`",
    "## Sentinels",
    "`flake sentinel`",
    "## Unknown flakes",
    "`chat upload`",
  ];
  const positions = order.map((needle) => body.indexOf(needle));
  expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
  expect(positions.every((position) => position >= 0)).toBe(true);
});

test("failure rows show pin-held stats and pinned since dates the pin, not the flake era", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    // The designed lifecycle: tracked as a flake first, then switched to a
    // createFailing pin — "pinned since" must date the switch.
    runRecorded(0, [record("stale facet", "flake-fail", { at: day(0) })]),
    runRecorded(1, [record("stale facet", "pinned-fail", { at: day(1), kind: "failing" })]),
    runRecorded(2, [record("stale facet", "pinned-fail", { at: day(2), kind: "failing" })]),
    runRecorded(3, [record("stale facet", "unexpected-pass", { at: day(3), kind: "failing" })]),
  );
  const row = renderBody(h.state(), Date.parse(day(4)))
    .split("\n")
    .find((line) => line.startsWith("`stale facet`"))!;
  expect(row).toContain(
    "runs: 4<br>pin held: 2<br>unexpected passes: 1<br>pinned since: Jan 2, 12:00am",
  );
  // Honest colors for a pin: red while the bug is present, green when it
  // unexpectedly passes.
  expect(row.match(/🟥|🟩|❌/gu)).toEqual(["🟥", "🟥", "🟥", "🟩"]);
});

test("unknown-flake rows show error samples and retire after 14 quiet days", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [
      record("chat upload", "retried-pass", {
        at: day(0),
        kind: "unknown",
        error: "Timeout 30000ms exceeded | waiting\nfor getByLabel('attachment')",
      }),
    ]),
  );
  const fresh = renderBody(h.state(), Date.parse(day(2)));
  // The error sample is the copy-paste material for a createFlake pattern —
  // rendered as code, with the table-breaking pipe escaped and the
  // row-splitting newline collapsed.
  expect(fresh).toContain("`Timeout 30000ms exceeded \\| waiting for getByLabel('attachment')`");
  expect(fresh).toContain("flakes: 1<br>last flake: Jan 1, 12:00am");

  // Unknown rows only record when they flake, so absence-from-runs cannot
  // retire them; time does instead.
  const stale = renderBody(h.state(), Date.parse(day(15)));
  expect(stale).not.toContain("`chat upload`");
  expect(stale).toContain("1 retired test hidden");
});

test("sentinel streaks never propose transitions", async () => {
  const h = makeHarness();
  await h.append(birth());
  for (let i = 0; i < 60; i++) {
    await h.append(runRecorded(i, [record("flake sentinel", "pass", { at: day(i / 5) })]));
  }
  expect(h.events(flakeEventTypes.transitionProposed)).toHaveLength(0);
});

test("a pin that keeps passing unexpectedly proposes unwrap-failing", async () => {
  const h = makeHarness();
  await h.append(birth());
  for (let i = 0; i < 10; i++) {
    await h.append(
      runRecorded(i, [
        record("stale facet", "unexpected-pass", { at: day(i / 3), kind: "failing" }),
      ]),
    );
  }
  expect(h.events(flakeEventTypes.transitionProposed)).toMatchObject([
    { payload: { testName: "stale facet", transition: "unwrap-failing" } },
  ]);
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
  outcome:
    | "pass"
    | "flake-fail"
    | "unexpected-error"
    | "pinned-fail"
    | "unexpected-pass"
    | "retried-pass",
  overrides?: { at?: string; kind?: "flake" | "failing" | "unknown"; error?: string },
) {
  const kind = overrides?.kind || "flake";
  return {
    name,
    kind,
    outcome,
    ...(kind === "unknown" ? {} : { pattern: "CPU startup time exceeded" }),
    ...(overrides?.error === undefined ? {} : { error: overrides.error }),
    durationMs: 5,
    at: overrides?.at || "2026-09-02T09:00:00Z",
  };
}

/** ISO timestamp `days` (fractional ok) after a fixed epoch. */
function day(days: number) {
  return new Date(Date.UTC(2026, 0, 1) + days * 24 * 60 * 60 * 1000).toISOString();
}

// --- webhook artifact ingestion, driven through the DO's real processEvent ---

test("a completed workflow_run's flake artifacts become one run-recorded event per suite", async () => {
  const { itx, appended, depotRequests } = fakeItx({
    artifacts: [
      { artifactId: "art-71", name: "flake-records-unit", sizeBytes: 1000, attempt: 2 },
      { artifactId: "art-72", name: "unit-test-telemetry", sizeBytes: 1000 },
    ],
    zips: {
      // Two files exercising both zip entry kinds our reader supports:
      // deflate-compressed (fflate's default) and stored (level 0).
      "art-71": zipSync({
        "flake-records-123.jsonl": strToU8(
          [
            JSON.stringify(record("flake sentinel", "pass")),
            "not json at all",
            JSON.stringify({ name: "bad shape" }),
          ].join("\n"),
        ),
        "flake-records-124.jsonl": [
          strToU8(JSON.stringify(record("deploy", "flake-fail"))),
          { level: 0 },
        ],
      }),
    },
  });
  await makeApp(itx).processEvent(webhookEvent());

  // The run lookup must NOT filter by run status: Depot groups all workflows
  // for a sha into one run whose status settles only after the last check
  // completes, and that check's webhook arrives before the flip — a
  // finished/failed filter permanently missed the last-completing check's
  // artifacts on prd (run rs7dwp1l27's specs + preview-e2e suites).
  expect(depotRequests.find((r) => r.method === "ListRuns")!.body).not.toHaveProperty("status");

  // Birth offered first, then exactly one run-recorded for the one matching
  // artifact — the telemetry artifact is ignored, malformed lines skipped.
  expect(appended.map((event: any) => event.type)).toEqual([
    "events.iterate.com/flakes/created",
    "events.iterate.com/flakes/run-recorded",
  ]);
  expect(appended[1]).toMatchObject({
    idempotencyKey: "flakes/run:run-77-2:unit",
    payload: {
      runId: "run-77-2",
      suite: "unit",
      branch: "main",
      commit: "abc123",
      records: [
        { name: "flake sentinel", outcome: "pass" },
        { name: "deploy", outcome: "flake-fail" },
      ],
    },
  });
});

test("runs without flake artifacts append nothing, not even a birth", async () => {
  const { itx, appended } = fakeItx({
    artifacts: [{ artifactId: "art-72", name: "unit-test-telemetry", sizeBytes: 1000 }],
    zips: {},
  });
  await makeApp(itx).processEvent(webhookEvent());
  expect(appended).toEqual([]);
});

test("the webhook schema accepts only completed check_run deliveries on connection streams", () => {
  expect(CheckRunWebhookEvent.safeParse(webhookEvent({ conclusion: "cancelled" })).success).toBe(
    false,
  );
  expect(CheckRunWebhookEvent.safeParse(webhookEvent())).toMatchObject({
    success: true,
    data: { payload: { body: { check_run: { head_sha: "abc123" } } } },
  });
  expect(CheckRunWebhookEvent.safeParse(webhookEvent({ path: "/flakes" })).success).toBe(false);
  expect(
    CheckRunWebhookEvent.safeParse(webhookEvent({ deliveryName: "workflow_run" })).success,
  ).toBe(false);
  expect(CheckRunWebhookEvent.safeParse(webhookEvent({ action: "created" })).success).toBe(false);
  expect(
    CheckRunWebhookEvent.safeParse({
      type: "events.iterate.com/flakes/run-recorded",
      path: "/integrations/github/install-1",
      payload: {},
    }).success,
  ).toBe(false);
});

test("a birth conflict means already born and the records still append", async () => {
  // The poisoned-prd lesson: once ANY body exists under the birth key, every
  // later offer conflicts — that must never cost the run's records.
  const { itx, appended } = fakeItx({
    artifacts: [{ artifactId: "art-71", name: "flake-records-unit", sizeBytes: 1000, attempt: 2 }],
    zips: {
      "art-71": zipSync({ "r.jsonl": strToU8(JSON.stringify(record("flake sentinel", "pass"))) }),
    },
    failAppendsMatching: /flakes\/created/,
  });
  await expect(makeApp(itx).processEvent(webhookEvent())).resolves.toBeUndefined();
  expect(appended.map((event: any) => event.type)).toEqual([
    "events.iterate.com/flakes/run-recorded",
  ]);
});

test("a webhook without depot config is skipped without touching itx", async () => {
  const { itx, appended } = fakeItx({ artifacts: [], zips: {} });
  itx.secrets.get = () => {
    throw new Error("must not be called");
  };
  await expect(makeApp(itx).raw.processEvent(webhookEvent())).resolves.toBeUndefined();
  expect(appended).toEqual([]);
});

test("an idempotency conflict on run-recorded means already ingested and does not throw", async () => {
  const { itx, appended } = fakeItx({
    artifacts: [{ artifactId: "art-71", name: "flake-records-unit", sizeBytes: 1000, attempt: 2 }],
    zips: {
      "art-71": zipSync({ "r.jsonl": strToU8(JSON.stringify(record("flake sentinel", "pass"))) }),
    },
    failAppendsMatching: /run-recorded/,
  });
  await expect(makeApp(itx).processEvent(webhookEvent())).resolves.toBeUndefined();
  expect(appended.map((event: any) => event.type)).toEqual(["events.iterate.com/flakes/created"]);
});

test("an ingest failure logs and drops instead of propagating into event delivery", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { itx } = fakeItx({ artifacts: [], zips: {} });
    // A poisoned webhook that throws mid-ingest must not reject: a throw out
    // of the app's processEvent would fail the whole delivery batch and
    // retry the same webhook forever.
    itx.secrets.get = () => {
      throw new Error("Depot token unavailable");
    };
    await expect(makeApp(itx).processEvent(webhookEvent())).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/ingestion failed for sha abc123/),
      expect.objectContaining({ message: "Depot token unavailable" }),
    );
  } finally {
    consoleError.mockRestore();
  }
});

test("oversized artifacts are skipped with a warning", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { itx, appended } = fakeItx({
      artifacts: [
        { artifactId: "art-71", name: "flake-records-unit", sizeBytes: 50 * 1024 * 1024 },
      ],
      zips: {},
    });
    await makeApp(itx).processEvent(webhookEvent());
    expect(appended.map((event: any) => event.type)).toEqual(["events.iterate.com/flakes/created"]);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringMatching(/oversized artifact/));
  } finally {
    consoleWarn.mockRestore();
  }
});

// --- helpers ---

function webhookEvent(overrides?: {
  path?: string;
  deliveryName?: string;
  action?: string;
  conclusion?: string;
}) {
  return {
    type: "events.iterate.com/github/webhook-received",
    path: overrides?.path || "/integrations/github/install-1",
    payload: {
      delivery: { name: overrides?.deliveryName || "check_run" },
      body: {
        action: overrides?.action || "completed",
        check_run: {
          conclusion: overrides?.conclusion || "success",
          head_sha: "abc123",
          check_suite: { head_branch: "main" },
        },
        repository: {
          name: "iterate",
          owner: { login: "iterate" },
          default_branch: "main",
        },
      },
    },
  } as any;
}

/**
 * The real Durable Object with fake platform underpinnings: ctx is never
 * touched on the ingestion path, and env.ITX hands back the fake itx. Tests
 * drive the same public processEvent the config worker dispatches to.
 */
function makeApp(itx: any) {
  // Just enough ctx for the base constructor's alarm overlay; the ingestion
  // path never touches storage or alarms.
  const ctx = { storage: { kv: { put() {}, get() {} }, setAlarm() {}, deleteAlarm() {} } };
  const app = new FlakeDashboardApp(ctx as any, { ITX: { get: async () => itx } } as any);
  return {
    processEvent: (event: any) =>
      app.processEvent(event, { depot: { orgId: "org-1", secretPath: "/secrets/depot-ci-token" } }),
    raw: app,
  };
}

function fakeItx(setup: {
  artifacts: { artifactId: string; name: string; sizeBytes: number; attempt?: number }[];
  zips: Record<string, Uint8Array>;
  failAppendsMatching?: RegExp;
}) {
  const appended: any[] = [];
  const depotRequests: { method: string; body: any }[] = [];
  // The worker talks to Depot's Connect API and the signed download URL over
  // plain fetch; the stub answers both by URL shape.
  vi.stubGlobal("fetch", async (url: string, init?: any) => {
    const method = String(url).split("/").pop();
    if (init?.body) depotRequests.push({ method: method!, body: JSON.parse(init.body) });
    if (method === "ListRuns") return jsonResponse({ runs: [{ runId: "run-77" }] });
    if (method === "ListArtifacts") return jsonResponse({ artifacts: setup.artifacts });
    if (method === "GetArtifactDownloadURL") {
      const { artifactId } = JSON.parse(init.body);
      return jsonResponse({ url: `https://signed.example/${artifactId}` });
    }
    if (String(url).startsWith("https://signed.example/")) {
      const id = String(url).split("/").pop()!;
      return new Response(setup.zips[id]!.slice().buffer as ArrayBuffer);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const itx = {
    [Symbol.dispose]() {},
    secrets: { get: () => ({ reveal: async () => "depot-test-token" }) },
    streams: {
      get: () => ({
        append: async (...events: any[]) => {
          for (const event of events) {
            if (setup.failAppendsMatching?.test(event.type)) {
              throw new Error(
                `idempotency key "${event.idempotencyKey}" already names a different event at offset 6`,
              );
            }
            appended.push(event);
          }
        },
      }),
    },
  } as any;
  return { itx, appended, depotRequests };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
