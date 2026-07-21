import { expect, it } from "vitest";
import { PreviewE2eTelemetryArtifact } from "./e2e-telemetry.ts";

it("stores orchestration timing separately from runner artifacts", () => {
  const telemetry = new PreviewE2eTelemetryArtifact({
    environment: {
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_REPOSITORY: "iterate/iterate",
    },
    headSha: "abcdef0123456789",
    operation: "test",
    pullRequestNumber: 42,
    runUrl: "https://example.test/run/123",
  });
  telemetry.appFinished({
    app: "os",
    slot: "preview_3",
    status: "passed",
    durationMs: 21_000,
    exitCode: 0,
    testCount: 1,
    retryCount: 0,
    collectionErrors: [],
  });
  telemetry.runFinished({ status: "passed", durationMs: 22_000 });

  expect(telemetry.artifactForTest()).toMatchObject({
    artifactSchemaVersion: 1,
    producer: "preview-e2e-orchestrator",
    ci: {
      headSha: "abcdef0123456789",
      pullRequestNumber: 42,
      workflowRunId: "123",
      workflowRunAttempt: "2",
    },
    context: { framework: "mixed", testKind: "e2e", lane: "preview" },
    run: { status: "passed", durationMs: 22_000 },
    tests: [],
    modules: [],
    lanes: [
      expect.objectContaining({
        context: expect.objectContaining({ app: "os", previewSlot: "preview_3" }),
        status: "passed",
        testCount: 1,
      }),
    ],
  });
});
