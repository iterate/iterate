import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { PreviewE2eTelemetryArtifact } from "./e2e-telemetry.ts";

it("stores orchestration timing separately from runner artifacts", () => {
  const artifactDirectory = mkdtempSync(join(tmpdir(), "preview-e2e-telemetry-"));
  const telemetry = new PreviewE2eTelemetryArtifact({
    environment: {
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_REPOSITORY: "iterate/iterate",
      TEST_TELEMETRY_ARTIFACT_DIR: artifactDirectory,
    },
    headSha: "abcdef0123456789",
    operation: "test",
    pullRequestNumber: 42,
    runUrl: "https://example.test/run/123",
  });
  telemetry.appStarted([
    {
      producer: "playwright-telemetry-reporter",
      framework: "playwright",
      testKind: "e2e",
      lane: "playwright",
      workspace: "iterate-root",
    },
  ]);
  const [sentinelFile] = readdirSync(artifactDirectory);
  const sentinel = JSON.parse(
    readFileSync(join(artifactDirectory, sentinelFile!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(sentinel).toMatchObject({
    run: { error: { name: "TestTelemetryIncompleteError" } },
    expectedArtifactSources: [
      {
        producer: "playwright-telemetry-reporter",
        framework: "playwright",
        testKind: "e2e",
        lane: "playwright",
        workspace: "iterate-root",
      },
    ],
  });
  telemetry.deployRunStarted();
  telemetry.deployAppFinished({
    app: "os",
    slot: "preview-3",
    status: "passed",
    durationMs: 12_000,
    configDurationMs: 500,
    commandDurationMs: 4_000,
    readinessDurationMs: 7_500,
    workerName: "os-preview-3",
    workerVersion: "11111111-1111-4111-8111-111111111111",
  });
  telemetry.deployRunFinished({ status: "passed", durationMs: 12_500, slot: "preview-3" });
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

  const completedArtifact = telemetry.artifactForTest();
  expect(() => TestTelemetryArtifact.parse(completedArtifact)).not.toThrow();
  expect(completedArtifact).toMatchObject({
    artifactSchemaVersion: 1,
    producer: "preview-e2e-orchestrator",
    ci: {
      headSha: "abcdef0123456789",
      pullRequestNumber: 42,
      workflowRunId: "123",
      workflowRunAttempt: "2",
    },
    context: { framework: "mixed", testKind: "e2e", lane: "preview" },
    expectedArtifactSources: [
      {
        producer: "playwright-telemetry-reporter",
        framework: "playwright",
        testKind: "e2e",
        lane: "playwright",
        workspace: "iterate-root",
      },
    ],
    run: { status: "passed", durationMs: 22_000 },
    deployment: {
      deploymentKind: "cloudflare-preview",
      status: "passed",
      durationMs: 12_500,
      previewSlot: "preview-3",
      lanes: [
        {
          app: "os",
          previewSlot: "preview-3",
          durationMs: 12_000,
          configDurationMs: 500,
          commandDurationMs: 4_000,
          readinessDurationMs: 7_500,
          workerName: "os-preview-3",
          workerVersion: "11111111-1111-4111-8111-111111111111",
        },
      ],
    },
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
  rmSync(artifactDirectory, { recursive: true });
});
