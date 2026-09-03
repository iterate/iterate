import { strToU8, zipSync } from "fflate";
import { expect, test, vi } from "vitest";
import { makeProcessorHarness } from "../../processors/testing.ts";
import {
  FlakeDashboardProcessorContract,
  flakeEventTypes,
  CheckRunWebhookEvent,
  type FlakeDashboardState,
} from "./contract.ts";
import { FlakeDashboardApp, FlakeDashboardProcessor } from "./worker.ts";

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
  overrides?: { at: string },
) {
  return {
    name,
    outcome,
    pattern: "CPU startup time exceeded",
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
  const { itx, appended } = fakeItx({
    artifacts: [
      { artifact_id: "art-71", name: "flake-records-unit", size_bytes: 1000, attempt: 2 },
      { artifact_id: "art-72", name: "unit-test-telemetry", size_bytes: 1000 },
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
    artifacts: [{ artifact_id: "art-72", name: "unit-test-telemetry", size_bytes: 1000 }],
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
    artifacts: [
      { artifact_id: "art-71", name: "flake-records-unit", size_bytes: 1000, attempt: 2 },
    ],
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

test("an idempotency conflict on run-recorded means already ingested and does not throw", async () => {
  const { itx, appended } = fakeItx({
    artifacts: [
      { artifact_id: "art-71", name: "flake-records-unit", size_bytes: 1000, attempt: 2 },
    ],
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
        { artifact_id: "art-71", name: "flake-records-unit", size_bytes: 50 * 1024 * 1024 },
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
  return new FlakeDashboardApp(ctx as any, { ITX: { get: async () => itx } } as any);
}

function fakeItx(setup: {
  artifacts: { artifact_id: string; name: string; size_bytes: number; attempt?: number }[];
  zips: Record<string, Uint8Array>;
  failAppendsMatching?: RegExp;
}) {
  const appended: any[] = [];
  // The worker talks to Depot's Connect API and the signed download URL over
  // plain fetch; the stub answers both by URL shape.
  vi.stubGlobal("fetch", async (url: string, init?: any) => {
    const method = String(url).split("/").pop();
    if (method === "ListRuns") return jsonResponse({ runs: [{ run_id: "run-77" }] });
    if (method === "ListArtifacts") return jsonResponse({ artifacts: setup.artifacts });
    if (method === "GetArtifactDownloadURL") {
      const { artifact_id } = JSON.parse(init.body);
      return jsonResponse({ url: `https://signed.example/${artifact_id}` });
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
  return { itx, appended };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
