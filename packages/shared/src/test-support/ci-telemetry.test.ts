import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  ciTelemetrySourceFromEnvironment,
  normalizeTestTelemetryError,
  resolveTestTelemetryArtifactPath,
  writeTestTelemetryArtifact,
  writeTestTelemetryFailureSentinel,
  type TestTelemetryArtifact,
} from "./ci-telemetry.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

test("normalizes arbitrary runner errors into one JSON-safe model", () => {
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

test("writes the artifact into the CI directory, relative to the repository root", () => {
  using repository = temporaryDirectory();
  const artifact: TestTelemetryArtifact = {
    artifactSchemaVersion: 3,
    artifactId: "vitest:@iterate/example:123:456",
    producer: "test",
    createdAt: "2026-07-21T12:00:01Z",
    ci: { repository: "iterate/iterate", workflowRunId: "1", workflowRunAttempt: "1" },
    context: { framework: "vitest", testKind: "unit", suite: "unit" },
    run: {
      status: "passed",
      startedAt: "2026-07-21T12:00:00Z",
      finishedAt: "2026-07-21T12:00:01Z",
      durationMs: 1000,
      collectionErrors: [],
    },
    tests: [],
  };
  const environment = {
    GITHUB_WORKSPACE: repository.path,
    TEST_TELEMETRY_ARTIFACT_DIR: "test-results/ci-telemetry/raw",
  };

  const written = writeTestTelemetryArtifact(artifact, environment);

  expect(written).toBe(resolveTestTelemetryArtifactPath(artifact.artifactId, environment));
  expect(written).toMatch(new RegExp(`^${repository.path}/test-results/ci-telemetry/raw/`, "u"));
  expect(JSON.parse(readFileSync(written!, "utf8"))).toEqual(artifact);
  expect(writeTestTelemetryArtifact(artifact, {})).toBeNull();
});

test("leaves an explicit failure artifact when a runner never reaches its end hook", () => {
  using artifactDirectory = temporaryDirectory();
  writeTestTelemetryFailureSentinel(
    {
      artifactId: "vitest:sentinel",
      producer: "vitest-test",
      startedAt: "2026-07-21T12:00:00Z",
      ci: { repository: "iterate/iterate", workflowRunId: "1", workflowRunAttempt: "1" },
      context: { framework: "vitest", testKind: "unit", suite: "unit" },
    },
    { TEST_TELEMETRY_ARTIFACT_DIR: artifactDirectory.path },
  );

  const artifactPath = resolveTestTelemetryArtifactPath("vitest:sentinel", {
    TEST_TELEMETRY_ARTIFACT_DIR: artifactDirectory.path,
  })!;
  const written = JSON.parse(readFileSync(artifactPath, "utf8")) as TestTelemetryArtifact;
  expect(written.run).toMatchObject({
    status: "failed",
    error: { name: "TestTelemetryIncompleteError" },
    collectionErrors: [expect.stringContaining("did not write its completed telemetry")],
  });
});

test("uses explicit preview identity and collision-resistant artifact filenames", () => {
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
