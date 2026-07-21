import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ciTelemetrySourceFromEnvironment,
  normalizeTestTelemetryError,
  resolveTestTelemetryArtifactPath,
  writeTestTelemetryArtifact,
  writeTestTelemetryFailureSentinel,
  type TestTelemetryArtifact,
} from "./ci-telemetry.ts";

it("normalizes arbitrary runner errors into one JSON-safe model", () => {
  expect(normalizeTestTelemetryError(new TypeError("boom"))).toMatchObject({
    name: "TypeError",
    message: "boom",
    stack: expect.any(String),
  });
  expect(normalizeTestTelemetryError({ code: "E_BROKEN" }, "runner failed")).toEqual({
    message: "runner failed",
  });
  expect(normalizeTestTelemetryError("process exited")).toEqual({ message: "process exited" });
});

it("writes an immediate file and a durable CI-directory copy from one artifact", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "ci-telemetry-contract-"));
  const artifact: TestTelemetryArtifact = {
    artifactSchemaVersion: 1,
    artifactId: "vitest:@iterate/example:123:456",
    producer: "test",
    createdAt: "2026-07-21T12:00:01Z",
    ci: {
      repository: "iterate/iterate",
      workflowRunId: "1",
      workflowRunAttempt: "1",
      runnerProvider: "local",
      executionContext: "local",
    },
    context: { framework: "vitest", testKind: "unit", lane: "unit" },
    run: {
      status: "passed",
      startedAt: "2026-07-21T12:00:00Z",
      finishedAt: "2026-07-21T12:00:01Z",
      durationMs: 1000,
    },
    lanes: [],
    tests: [],
    modules: [],
  };

  writeTestTelemetryArtifact(artifact, {
    GITHUB_WORKSPACE: repositoryRoot,
    TEST_TELEMETRY_ARTIFACT_FILE: "immediate.json",
    TEST_TELEMETRY_ARTIFACT_DIR: "test-results/ci-telemetry/raw",
  });

  const immediate = join(repositoryRoot, "immediate.json");
  const durable = resolveTestTelemetryArtifactPath("vitest:@iterate/example:123:456", {
    GITHUB_WORKSPACE: repositoryRoot,
    TEST_TELEMETRY_ARTIFACT_DIR: "test-results/ci-telemetry/raw",
  })!;
  expect(existsSync(immediate)).toBe(true);
  expect(existsSync(durable)).toBe(true);
  expect(readFileSync(durable, "utf8")).toBe(readFileSync(immediate, "utf8"));
  rmSync(repositoryRoot, { recursive: true });
});

it("leaves an explicit failure artifact when a runner never reaches its end hook", () => {
  const artifactDirectory = mkdtempSync(join(tmpdir(), "ci-telemetry-sentinel-"));
  writeTestTelemetryFailureSentinel(
    {
      artifactId: "vitest:sentinel",
      producer: "vitest-test",
      startedAt: "2026-07-21T12:00:00Z",
      ci: {
        repository: "iterate/iterate",
        workflowRunId: "1",
        workflowRunAttempt: "1",
        runnerProvider: "local",
        executionContext: "local",
      },
      context: { framework: "vitest", testKind: "unit", lane: "unit" },
    },
    { TEST_TELEMETRY_ARTIFACT_DIR: artifactDirectory },
  );

  const artifactPath = resolveTestTelemetryArtifactPath("vitest:sentinel", {
    TEST_TELEMETRY_ARTIFACT_DIR: artifactDirectory,
  })!;
  const written = JSON.parse(readFileSync(artifactPath, "utf8")) as TestTelemetryArtifact;
  expect(written.run).toMatchObject({
    status: "failed",
    error: { name: "TestTelemetryIncompleteError" },
  });
  expect(written.lanes[0]?.collectionErrors[0]).toContain("did not write its completed telemetry");
  rmSync(artifactDirectory, { recursive: true });
});

it("uses explicit preview identity and collision-resistant artifact filenames", () => {
  expect(
    ciTelemetrySourceFromEnvironment({
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: "workflow-dispatch-sha",
      TEST_TELEMETRY_HEAD_SHA: "pull-head-sha",
      TEST_TELEMETRY_BRANCH: "feature/test-telemetry",
      TEST_TELEMETRY_PULL_REQUEST_NUMBER: "42",
    }),
  ).toMatchObject({
    branch: "feature/test-telemetry",
    headSha: "pull-head-sha",
    pullRequestNumber: 42,
  });

  const environment = { TEST_TELEMETRY_ARTIFACT_DIR: "/tmp/telemetry" };
  expect(resolveTestTelemetryArtifactPath("runner:a:b", environment)).not.toBe(
    resolveTestTelemetryArtifactPath("runner:a-b", environment),
  );
});
