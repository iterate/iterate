import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeTestTelemetryArtifact,
  type TestTelemetryArtifact,
} from "@iterate-com/shared/test-support/ci-telemetry";
import { expect, test } from "vitest";
import { unitTestWorkspaces } from "./test-telemetry-completeness.ts";
import { finalizeTestTelemetry } from "./upload-test-telemetry.ts";

const artifact: TestTelemetryArtifact = {
  artifactSchemaVersion: 2,
  artifactId: "preview:123:1",
  producer: "test-fixture",
  createdAt: "2026-07-21T10:00:12.000Z",
  ci: {
    repository: "iterate/iterate",
    headSha: "abcdef",
    branch: "feature",
    pullRequestNumber: 42,
    workflowName: "Preview",
    workflowRunId: "123",
    workflowRunAttempt: "1",
    workflowRunUrl: "https://example.test/runs/123",
    jobName: "preview",
    runnerProvider: "depot",
    depotJobUrl: "https://depot.test/jobs/1",
    executionContext: "ci",
  },
  context: { framework: "playwright", testKind: "e2e", suite: "preview" },
  run: {
    status: "passed",
    startedAt: "2026-07-21T10:00:00.000Z",
    finishedAt: "2026-07-21T10:00:12.000Z",
    durationMs: 12_000,
  },
  runners: [
    {
      context: { framework: "playwright", testKind: "e2e", suite: "preview", app: "os" },
      status: "passed",
      durationMs: 12_000,
      exitCode: 0,
      testCount: 1,
      retryCount: 1,
      collectionErrors: [],
    },
  ],
  tests: [
    {
      fullName: "feed resumes",
      moduleId: "specs/resume.spec.ts",
      tags: ["@recovery"],
      annotations: [{ type: "slow", description: "real liveness timeout" }],
      context: { framework: "playwright", suite: "playwright", app: "os", testProject: "os" },
      retryCount: 1,
      passedAfterRetry: true,
      state: "passed",
      durationMs: 10_000,
      attemptDetail: "complete",
      startedAt: "2026-07-21T10:00:01.000Z",
      startedAtSource: "runner",
      attempts: [
        {
          attemptIndex: 0,
          state: "failed",
          durationMs: 7_000,
          startedAt: "2026-07-21T10:00:01.000Z",
          startedAtSource: "runner",
          error: { message: "socket stalled" },
          phases: [
            {
              name: "probe eviction",
              category: "test.step",
              durationMs: 5_000,
              startedAt: "2026-07-21T10:00:01.000Z",
            },
          ],
        },
        {
          attemptIndex: 1,
          state: "passed",
          durationMs: 3_000,
          startedAt: "2026-07-21T10:00:09.000Z",
          startedAtSource: "runner",
          phases: [],
        },
      ],
      phases: [],
      errors: [{ message: "socket stalled" }],
      firstFailure: "socket stalled",
    },
  ],
  modules: [
    {
      moduleId: "specs/resume.spec.ts",
      environmentSetupDurationMs: 0,
      prepareDurationMs: 0,
      collectDurationMs: 0,
      setupDurationMs: 0,
      testAndHookDurationMs: 10_000,
      importDurationMs: 900,
      imports: [
        {
          moduleId: "specs/test-support/session.ts",
          selfDurationMs: 900,
          totalDurationMs: 1_200,
        },
      ],
    },
  ],
};

test("keeps the raw artifacts and writes a manifest of what they prove", async () => {
  using root = temporaryDirectory();
  writeTestTelemetryArtifact(
    { ...artifact, context: { ...artifact.context, workspace: "os" } },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root.path, "raw") },
  );

  const artifacts = await finalizeTestTelemetry({
    artifactRoot: root.path,
    expectedWorkspaces: ["os"],
  });

  expect(artifacts.map(({ artifactId }) => artifactId)).toEqual([artifact.artifactId]);
  expect(readManifest(root.path)).toMatchObject({
    artifactCount: 1,
    cancelled: false,
    expectedWorkspaces: ["os"],
    observedWorkspaces: ["os"],
    missingWorkspaces: [],
    incompleteArtifactIds: [],
    foreignArtifactIds: [],
    artifacts: [{ artifactId: artifact.artifactId, producer: "test-fixture", testCount: 1 }],
  });
});

test("a workspace that left no artifact fails the job after the manifest is written", async () => {
  using root = temporaryDirectory();
  writeTestTelemetryArtifact(
    { ...artifact, context: { ...artifact.context, workspace: "iterate-root" } },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root.path, "raw") },
  );

  await expect(
    finalizeTestTelemetry({ artifactRoot: root.path, expectedWorkspaces: ["os"] }),
  ).rejects.toThrow("Missing expected test telemetry workspaces: os");
  expect(readManifest(root.path)).toMatchObject({
    missingWorkspaces: ["os"],
    observedWorkspaces: ["iterate-root"],
  });
});

// Depot runs a PR's workflow file from its merge ref and the Test job checks out its head, so a list
// of workspaces in test.yml is main's. PRs #2985, #2986 and #2991 predated @iterate-com/ci-reports
// (#2969): every test passed and the finalizer failed on the workspace their head does not have.
test("the Test job expects its checkout's test workspaces, not main's", async () => {
  using tree = temporaryDirectory();
  writeFileSync(join(tree.path, "pnpm-workspace.yaml"), "packages:\n  - apps/os\n  - apps/docs\n");
  for (const [directory, packageJson] of [
    ["apps/os", { name: "os", scripts: { test: "vitest run" } }],
    ["apps/docs", { name: "docs", scripts: { build: "vite build" } }],
  ] as const) {
    mkdirSync(join(tree.path, directory), { recursive: true });
    writeFileSync(join(tree.path, directory, "package.json"), JSON.stringify(packageJson));
  }
  using root = temporaryDirectory();
  writeTestTelemetryArtifact(
    { ...artifact, context: { ...artifact.context, workspace: "os" } },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root.path, "raw") },
  );

  expect(unitTestWorkspaces(tree.path)).toEqual(["os"]);
  await expect(
    finalizeTestTelemetry({
      artifactRoot: root.path,
      expectedWorkspaces: unitTestWorkspaces(tree.path),
    }),
  ).resolves.toHaveLength(1);
  await expect(
    finalizeTestTelemetry({
      artifactRoot: root.path,
      expectedWorkspaces: ["os", "@iterate-com/ci-reports"],
    }),
  ).rejects.toThrow("Missing expected test telemetry workspaces: @iterate-com/ci-reports");
});

test.each([
  { jobName: "playwright-1" },
  { repository: "iterate/another" },
  { workflowRunId: "122" },
  { workflowRunAttempt: "2" },
])("rejects an older runner artifact from another CI scope %j", async (foreignIdentity) => {
  using root = temporaryDirectory();
  writeTestTelemetryArtifact(artifact, { TEST_TELEMETRY_ARTIFACT_DIR: join(root.path, "raw") });
  writeTestTelemetryArtifact(
    {
      ...artifact,
      artifactId: "foreign-runner",
      ci: { ...artifact.ci, ...foreignIdentity },
      run: { ...artifact.run, finishedAt: "2026-07-21T09:00:00.000Z" },
    },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root.path, "raw") },
  );

  await expect(finalizeTestTelemetry({ artifactRoot: root.path })).rejects.toThrow(
    "Foreign test telemetry artifacts: foreign-runner",
  );
  expect(readManifest(root.path)).toMatchObject({ foreignArtifactIds: ["foreign-runner"] });
});

test("fails on a runner's unreplaced sentinel after retaining it", async () => {
  using root = temporaryDirectory();
  writeTestTelemetryArtifact(
    {
      ...artifact,
      run: {
        ...artifact.run,
        status: "failed",
        error: {
          name: "TestTelemetryIncompleteError",
          message: "reporter did not write its completed telemetry artifact",
        },
      },
      runners: [{ ...artifact.runners[0]!, status: "failed", collectionErrors: [] }],
      tests: [],
      modules: [],
    },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root.path, "raw") },
  );

  await expect(finalizeTestTelemetry({ artifactRoot: root.path })).rejects.toThrow(
    `Incomplete test telemetry artifacts: ${artifact.artifactId}`,
  );
  expect(readManifest(root.path)).toMatchObject({ incompleteArtifactIds: [artifact.artifactId] });
});

test("a runner that finished with an error is failure evidence, not incomplete evidence", async () => {
  using root = temporaryDirectory();
  writeTestTelemetryArtifact(
    {
      ...artifact,
      run: {
        ...artifact.run,
        status: "failed",
        error: { name: "Error", message: "worker stopped responding" },
      },
      runners: [
        {
          ...artifact.runners[0]!,
          status: "timedout",
          collectionErrors: ["worker stopped responding"],
        },
      ],
    },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root.path, "raw") },
  );

  await finalizeTestTelemetry({ artifactRoot: root.path });

  expect(readManifest(root.path)).toMatchObject({ incompleteArtifactIds: [] });
});

test.each([undefined, "unit", "preview"] as const)(
  "retains an empty cancelled manifest without inventing a %s suite result before reporters start",
  async (flakeSuites) => {
    using root = temporaryDirectory();
    const artifactRoot = join(root.path, "ci-telemetry");

    const artifacts = await finalizeTestTelemetry({ artifactRoot, cancelled: true, flakeSuites });

    expect(artifacts).toEqual([]);
    expect(readManifest(artifactRoot)).toMatchObject({ artifactCount: 0, cancelled: true });
    expect(existsSync(join(root.path, "flake-records"))).toBe(false);
  },
);

test("rejects duplicate artifact IDs instead of double-counting a retried upload", async () => {
  using root = temporaryDirectory();
  const rawDirectory = join(root.path, "raw");
  mkdirSync(join(rawDirectory, "second"), { recursive: true });
  writeFileSync(join(rawDirectory, "first.json"), JSON.stringify(artifact));
  writeFileSync(join(rawDirectory, "second", "duplicate.json"), JSON.stringify(artifact));

  await expect(finalizeTestTelemetry({ artifactRoot: root.path })).rejects.toThrow(
    `Duplicate test telemetry artifact IDs: ${artifact.artifactId}`,
  );
});

function readManifest(artifactRoot: string) {
  return JSON.parse(readFileSync(join(artifactRoot, "manifest.json"), "utf8")) as unknown;
}

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "test-telemetry-finalizer-"));
  return {
    path,
    [Symbol.dispose]() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
