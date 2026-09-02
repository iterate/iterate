import { strToU8, zipSync } from "fflate";
import { expect, test, vi } from "vitest";
import {
  ingestWorkflowRunFlakeArtifacts,
  parseWorkflowRunWebhook,
} from "./workflow-artifact-ingestion.ts";

test("a completed workflow_run's flake artifacts become one run-recorded event per suite", async () => {
  const { itx, appended } = fakeItx({
    artifacts: [
      { id: 71, name: "flake-records-unit", size_in_bytes: 1000 },
      { id: 72, name: "unit-test-telemetry", size_in_bytes: 1000 },
    ],
    zips: {
      71: zipSync({
        "flake-records-123.jsonl": strToU8(
          [
            JSON.stringify(record("flake sentinel", "pass")),
            "not json at all",
            JSON.stringify({ name: "bad shape" }),
            JSON.stringify(record("deploy", "flake-fail")),
          ].join("\n"),
        ),
      }),
    },
  });
  const webhook = parseWorkflowRunWebhook(webhookEvent());
  expect(webhook).not.toBeNull();

  await ingestWorkflowRunFlakeArtifacts(itx, webhook!);

  // Birth offered first, then exactly one run-recorded for the one matching
  // artifact — the telemetry artifact is ignored, malformed lines skipped.
  expect(appended.map((event: any) => event.type)).toEqual([
    "events.iterate.com/flakes/created",
    "events.iterate.com/flakes/run-recorded",
  ]);
  expect(appended[1]).toMatchObject({
    idempotencyKey: "flakes/run:9001-2:unit",
    payload: {
      runId: "9001-2",
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
    artifacts: [{ id: 72, name: "unit-test-telemetry", size_in_bytes: 1000 }],
    zips: {},
  });
  await ingestWorkflowRunFlakeArtifacts(itx, parseWorkflowRunWebhook(webhookEvent())!);
  expect(appended).toEqual([]);
});

test("the parse gate rejects everything but completed workflow_run deliveries on connection streams", () => {
  expect(parseWorkflowRunWebhook(webhookEvent())).toMatchObject({
    connection: "install-1",
    run: { id: 9001 },
  });
  expect(parseWorkflowRunWebhook(webhookEvent({ path: "/flakes" }))).toBeNull();
  expect(parseWorkflowRunWebhook(webhookEvent({ deliveryName: "check_run" }))).toBeNull();
  expect(parseWorkflowRunWebhook(webhookEvent({ action: "requested" }))).toBeNull();
  expect(
    parseWorkflowRunWebhook({
      type: "events.iterate.com/flakes/run-recorded",
      path: "/integrations/github/install-1",
      payload: {},
    } as any),
  ).toBeNull();
});

test("an idempotency conflict on run-recorded means already ingested and does not throw", async () => {
  const { itx, appended } = fakeItx({
    artifacts: [{ id: 71, name: "flake-records-unit", size_in_bytes: 1000 }],
    zips: {
      71: zipSync({ "r.jsonl": strToU8(JSON.stringify(record("flake sentinel", "pass"))) }),
    },
    failAppendsMatching: /run-recorded/,
  });
  await expect(
    ingestWorkflowRunFlakeArtifacts(itx, parseWorkflowRunWebhook(webhookEvent())!),
  ).resolves.toBeUndefined();
  expect(appended.map((event: any) => event.type)).toEqual(["events.iterate.com/flakes/created"]);
});

test("an ingest failure logs and drops instead of propagating into event delivery", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { itx } = fakeItx({ artifacts: [], zips: {} });
    // A poisoned webhook that throws mid-ingest must not reject: a throw out
    // of the app's processEvent would fail the whole delivery batch and
    // retry the same webhook forever.
    itx.integrations.github.get = () => {
      throw new Error("GitHub is down");
    };
    await expect(
      ingestWorkflowRunFlakeArtifacts(itx, parseWorkflowRunWebhook(webhookEvent())!),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/ingestion failed for run 9001/),
      expect.objectContaining({ message: "GitHub is down" }),
    );
  } finally {
    consoleError.mockRestore();
  }
});

test("oversized artifacts are skipped with a warning", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { itx, appended } = fakeItx({
      artifacts: [{ id: 71, name: "flake-records-unit", size_in_bytes: 50 * 1024 * 1024 }],
      zips: {},
    });
    await ingestWorkflowRunFlakeArtifacts(itx, parseWorkflowRunWebhook(webhookEvent())!);
    expect(appended.map((event: any) => event.type)).toEqual(["events.iterate.com/flakes/created"]);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringMatching(/oversized artifact/));
  } finally {
    consoleWarn.mockRestore();
  }
});

// --- helpers ---

function record(name: string, outcome: string) {
  return {
    name,
    outcome,
    pattern: "monthly flake sentinel",
    durationMs: 5,
    at: "2026-09-02T09:00:00Z",
  };
}

function webhookEvent(overrides?: { path?: string; deliveryName?: string; action?: string }) {
  return {
    type: "events.iterate.com/github/webhook-received",
    path: overrides?.path || "/integrations/github/install-1",
    payload: {
      delivery: { name: overrides?.deliveryName || "workflow_run" },
      body: {
        action: overrides?.action || "completed",
        workflow_run: {
          id: 9001,
          run_attempt: 2,
          head_branch: "main",
          head_sha: "abc123",
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

function fakeItx(setup: {
  artifacts: { id: number; name: string; size_in_bytes: number }[];
  zips: Record<number, Uint8Array>;
  failAppendsMatching?: RegExp;
}) {
  const appended: any[] = [];
  const itx = {
    integrations: {
      github: {
        get: () => ({
          octokit: {
            paginate: async () => setup.artifacts,
            rest: {
              actions: {
                downloadArtifact: async ({ artifact_id }: any) => ({
                  data: setup.zips[artifact_id]!.buffer,
                }),
              },
            },
          },
        }),
      },
    },
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
