import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeTestTelemetryArtifact,
  type TestTelemetryArtifact,
} from "@iterate-com/shared/test-support/ci-telemetry";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeTestTelemetry, testTelemetryEvents } from "./upload-test-telemetry.ts";

const { sendPostHogEventsMock } = vi.hoisted(() => ({ sendPostHogEventsMock: vi.fn() }));
vi.mock("./posthog-events.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./posthog-events.ts")>()),
  sendPostHogEvents: sendPostHogEventsMock,
}));

afterEach(() => {
  sendPostHogEventsMock.mockReset();
});

const artifact: TestTelemetryArtifact = {
  artifactSchemaVersion: 1,
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
  context: { framework: "mixed", testKind: "e2e", lane: "preview" },
  run: {
    status: "passed",
    startedAt: "2026-07-21T10:00:00.000Z",
    finishedAt: "2026-07-21T10:00:12.000Z",
    durationMs: 12_000,
  },
  lanes: [
    {
      context: { framework: "mixed", testKind: "e2e", lane: "preview", app: "os" },
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
      context: { framework: "playwright", lane: "playwright", app: "os", testProject: "web" },
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

it("transmogrifies one runner-independent artifact into the shared PostHog event family", () => {
  const events = testTelemetryEvents(artifact);
  expect(events.map(({ event }) => event)).toEqual([
    "ci test run started",
    "ci test lane finished",
    "ci test finished",
    "ci test attempt finished",
    "ci test phase finished",
    "ci test attempt finished",
    "ci test module finished",
    "ci test import finished",
    "ci test run finished",
  ]);
  expect(events[2]).toMatchObject({
    timestamp: "2026-07-21T10:00:12.000Z",
    properties: {
      framework: "playwright",
      test_kind: "e2e",
      duration_ms: 10_000,
      final_attempt_duration_ms: 3_000,
      retry_duration_ms: 7_000,
      retry_count: 1,
      passed_after_retry: true,
      artifact_id: "preview:123:1",
      test_id: "playwright:specs/resume.spec.ts:feed resumes:web",
    },
  });
  expect(events[4]?.properties).toMatchObject({
    attempt_index: 0,
    phase_name: "probe eviction",
    duration_ms: 5_000,
  });
  expect(events[7]?.properties).toMatchObject({
    imported_module: "specs/test-support/session.ts",
    self_duration_ms: 900,
    total_duration_ms: 1_200,
  });
});

it("normalizes retained preview deployment evidence without reporter network I/O", () => {
  const events = testTelemetryEvents({
    ...artifact,
    deployment: {
      deploymentKind: "cloudflare-preview",
      status: "passed",
      startedAt: "2026-07-21T09:58:00.000Z",
      finishedAt: "2026-07-21T10:00:00.000Z",
      durationMs: 120_000,
      previewSlot: "preview-3",
      lanes: [
        {
          app: "os",
          previewSlot: "preview-3",
          status: "passed",
          durationMs: 115_500,
          finishedAt: "2026-07-21T09:59:58.000Z",
          configDurationMs: 500,
          commandDurationMs: 42_900,
          readinessDurationMs: 72_100,
          workerName: "os-preview-3",
          workerVersion: "11111111-1111-4111-8111-111111111111",
        },
      ],
    },
  });
  const deploymentEvents = events.filter(({ event }) => event.startsWith("ci deploy "));

  expect(deploymentEvents.map(({ event }) => event)).toEqual([
    "ci deploy run started",
    "ci deploy lane finished",
    "ci deploy phase finished",
    "ci deploy phase finished",
    "ci deploy phase finished",
    "ci deploy run finished",
  ]);
  expect(deploymentEvents[1]).toMatchObject({
    timestamp: "2026-07-21T09:59:58.000Z",
    properties: {
      app: "os",
      command_duration_ms: 42_900,
      readiness_duration_ms: 72_100,
      worker_name: "os-preview-3",
      worker_version: "11111111-1111-4111-8111-111111111111",
    },
  });
});

it("keeps raw and normalized JSON for replay while dry-run skips delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-telemetry-finalizer-"));
  writeTestTelemetryArtifact(
    {
      ...artifact,
      deployment: {
        deploymentKind: "cloudflare-preview",
        status: "passed",
        startedAt: "2026-07-21T09:58:00.000Z",
        finishedAt: "2026-07-21T10:00:00.000Z",
        durationMs: 120_000,
        lanes: [],
      },
    },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root, "raw") },
  );

  const result = await finalizeTestTelemetry({ artifactRoot: root, dryRun: true });

  expect(result.artifacts).toHaveLength(1);
  const normalized = JSON.parse(
    readFileSync(join(root, "normalized", "posthog-events.json"), "utf8"),
  ) as { schemaVersion: number; events: unknown[] };
  expect(normalized.schemaVersion).toBe(2);
  expect(normalized.events).toHaveLength(12);
  expect(normalized.events.at(-1)).toMatchObject({
    event: "ci test telemetry finalized",
    properties: { status: "passed", telemetry_incomplete: false, runner_event_count: 9 },
  });
  rmSync(root, { recursive: true });
});

it("delivers complete evidence before rejecting a missing expected workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-telemetry-completeness-"));
  writeTestTelemetryArtifact(
    { ...artifact, context: { ...artifact.context, workspace: "iterate-root" } },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root, "raw") },
  );

  await expect(
    finalizeTestTelemetry({
      artifactRoot: root,
      expectedWorkspaces: ["@iterate-com/os"],
    }),
  ).rejects.toThrow("Missing expected test telemetry workspaces: @iterate-com/os");
  expect(sendPostHogEventsMock).toHaveBeenCalledOnce();
  const manifest = JSON.parse(readFileSync(join(root, "normalized", "manifest.json"), "utf8")) as {
    missingWorkspaces: string[];
    observedWorkspaces: string[];
  };
  expect(manifest.missingWorkspaces).toEqual(["@iterate-com/os"]);
  expect(manifest.observedWorkspaces).toEqual(["iterate-root"]);
  const deliveredEvents = sendPostHogEventsMock.mock.calls[0]![0] as Array<{
    event: string;
    properties: Record<string, unknown>;
  }>;
  expect(deliveredEvents.at(-1)).toMatchObject({
    event: "ci test telemetry finalized",
    properties: {
      failed: true,
      telemetry_incomplete: true,
      missing_workspace_count: 1,
      missing_workspaces: ["@iterate-com/os"],
    },
  });
  rmSync(root, { recursive: true });
});

it("requires exact expected runner sources with cardinality before passing", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-telemetry-runner-completeness-"));
  const expectedSource = {
    producer: "playwright-telemetry-reporter",
    framework: "playwright" as const,
    testKind: "e2e" as const,
    lane: "playwright",
    workspace: "iterate-root",
  };
  writeTestTelemetryArtifact(
    { ...artifact, expectedArtifactSources: [expectedSource, expectedSource] },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root, "raw") },
  );
  writeTestTelemetryArtifact(
    {
      ...artifact,
      artifactId: "preview:123:playwright",
      producer: expectedSource.producer,
      context: {
        framework: expectedSource.framework,
        testKind: expectedSource.testKind,
        lane: expectedSource.lane,
        workspace: expectedSource.workspace,
      },
    },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root, "raw") },
  );
  writeTestTelemetryArtifact(
    {
      ...artifact,
      artifactId: "preview:123:wrong-producer",
      producer: "lookalike-playwright-reporter",
      context: {
        framework: expectedSource.framework,
        testKind: expectedSource.testKind,
        lane: expectedSource.lane,
        workspace: expectedSource.workspace,
      },
    },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root, "raw") },
  );
  writeTestTelemetryArtifact(
    {
      ...artifact,
      artifactId: "preview:122:stale-playwright",
      producer: expectedSource.producer,
      ci: { ...artifact.ci, workflowRunId: "122" },
      context: {
        framework: expectedSource.framework,
        testKind: expectedSource.testKind,
        lane: expectedSource.lane,
        workspace: expectedSource.workspace,
      },
    },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root, "raw") },
  );

  await expect(finalizeTestTelemetry({ artifactRoot: root })).rejects.toThrow(
    "playwright-telemetry-reporter:playwright/e2e/playwright@iterate-root (expected 2, observed 1)",
  );
  expect(sendPostHogEventsMock).toHaveBeenCalledOnce();
  const manifest = JSON.parse(readFileSync(join(root, "normalized", "manifest.json"), "utf8")) as {
    expectedArtifactSources: unknown[];
    foreignArtifactIds: string[];
    missingArtifactSources: unknown[];
  };
  expect(manifest.expectedArtifactSources).toEqual([expectedSource, expectedSource]);
  expect(manifest.foreignArtifactIds).toEqual(["preview:122:stale-playwright"]);
  expect(manifest.missingArtifactSources).toEqual([
    {
      source: expectedSource,
      expectedCount: 2,
      observedCount: 1,
      missingCount: 1,
      ciScope: {
        repository: "iterate/iterate",
        workflowRunId: "123",
        workflowRunAttempt: "1",
        jobName: "preview",
      },
    },
  ]);
  const deliveredEvents = sendPostHogEventsMock.mock.calls[0]![0] as Array<{
    event: string;
    properties: Record<string, unknown>;
  }>;
  expect(deliveredEvents.at(-1)).toMatchObject({
    event: "ci test telemetry finalized",
    properties: {
      status: "failed",
      failed: true,
      expected_artifact_source_count: 2,
      observed_artifact_source_count: 2,
      matched_expected_artifact_source_count: 1,
      missing_artifact_source_count: 1,
      expected_artifact_sources: [
        "playwright-telemetry-reporter:playwright/e2e/playwright@iterate-root x2",
      ],
      missing_artifact_sources: [
        "playwright-telemetry-reporter:playwright/e2e/playwright@iterate-root [run 123/1 job preview] (expected 2, observed 1, missing 1)",
      ],
      foreign_artifact_count: 1,
      foreign_artifact_ids: ["preview:122:stale-playwright"],
    },
  });
  rmSync(root, { recursive: true });
});

it("fails on an incomplete runner artifact after retaining its normalized evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-telemetry-incomplete-"));
  const incompleteArtifact: TestTelemetryArtifact = {
    ...artifact,
    run: {
      ...artifact.run,
      status: "failed",
      error: {
        name: "TestTelemetryIncompleteError",
        message: "reporter did not write its completed telemetry artifact",
      },
    },
    lanes: [{ ...artifact.lanes[0]!, status: "failed", collectionErrors: [] }],
    tests: [],
    modules: [],
  };
  writeTestTelemetryArtifact(incompleteArtifact, {
    TEST_TELEMETRY_ARTIFACT_DIR: join(root, "raw"),
  });

  await expect(finalizeTestTelemetry({ artifactRoot: root, dryRun: true })).rejects.toThrow(
    `Incomplete test telemetry artifacts: ${artifact.artifactId}`,
  );
  const manifest = JSON.parse(readFileSync(join(root, "normalized", "manifest.json"), "utf8")) as {
    incompleteArtifactIds: string[];
  };
  expect(manifest.incompleteArtifactIds).toEqual([artifact.artifactId]);
  const normalized = JSON.parse(
    readFileSync(join(root, "normalized", "posthog-events.json"), "utf8"),
  ) as { events: Array<{ event: string; properties: Record<string, unknown> }> };
  expect(normalized.events.at(-1)).toMatchObject({
    event: "ci test telemetry finalized",
    properties: { telemetry_incomplete: true, incomplete_artifact_count: 1 },
  });
  rmSync(root, { recursive: true });
});

it("delivers completed runner errors without misclassifying their evidence as incomplete", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-telemetry-runner-error-"));
  writeTestTelemetryArtifact(
    {
      ...artifact,
      run: {
        ...artifact.run,
        status: "failed",
        error: { name: "Error", message: "worker stopped responding" },
      },
      lanes: [
        {
          ...artifact.lanes[0]!,
          status: "timedout",
          collectionErrors: ["worker stopped responding"],
        },
      ],
    },
    { TEST_TELEMETRY_ARTIFACT_DIR: join(root, "raw") },
  );

  const result = await finalizeTestTelemetry({ artifactRoot: root });

  expect(sendPostHogEventsMock).toHaveBeenCalledOnce();
  expect(
    result.events.find((event) => event.event === "ci test lane finished")?.properties,
  ).toMatchObject({ telemetry_incomplete: false, collection_error_count: 1 });
  expect(
    result.events.find((event) => event.event === "ci test run finished")?.properties,
  ).toMatchObject({
    telemetry_incomplete: false,
    collection_error_count: 1,
  });
  expect(result.events.at(-1)).toMatchObject({
    event: "ci test telemetry finalized",
    properties: { status: "passed", telemetry_incomplete: false },
  });
  const manifest = JSON.parse(readFileSync(join(root, "normalized", "manifest.json"), "utf8")) as {
    incompleteArtifactIds: string[];
  };
  expect(manifest.incompleteArtifactIds).toEqual([]);
  rmSync(root, { recursive: true });
});

it("retains an explicit empty manifest when cancellation happens before a reporter starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-telemetry-cancelled-"));

  const result = await finalizeTestTelemetry({ artifactRoot: root, cancelled: true });

  expect(result).toEqual({ artifacts: [], events: [] });
  expect(sendPostHogEventsMock).not.toHaveBeenCalled();
  const manifest = JSON.parse(readFileSync(join(root, "normalized", "manifest.json"), "utf8")) as {
    artifactCount: number;
    cancelled: boolean;
  };
  expect(manifest).toMatchObject({ artifactCount: 0, cancelled: true });
  rmSync(root, { recursive: true });
});

it("rejects duplicate artifact IDs instead of double-counting a retried upload", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-telemetry-duplicates-"));
  const rawDirectory = join(root, "raw");
  mkdirSync(join(rawDirectory, "second"), { recursive: true });
  writeFileSync(join(rawDirectory, "first.json"), JSON.stringify(artifact));
  writeFileSync(join(rawDirectory, "second", "duplicate.json"), JSON.stringify(artifact));

  await expect(finalizeTestTelemetry({ artifactRoot: root, dryRun: true })).rejects.toThrow(
    `Duplicate test telemetry artifact IDs: ${artifact.artifactId}`,
  );
  rmSync(root, { recursive: true });
});

it("marks an unfinished runner sentinel as incomplete", () => {
  const events = testTelemetryEvents({
    ...artifact,
    run: {
      ...artifact.run,
      status: "failed",
      error: {
        name: "TestTelemetryIncompleteError",
        message: "reporter did not write its completed telemetry artifact",
      },
    },
    lanes: [
      {
        ...artifact.lanes[0]!,
        status: "failed",
        collectionErrors: ["reporter did not finish"],
      },
    ],
    tests: [],
    modules: [],
  });

  expect(events.find((event) => event.event === "ci test lane finished")?.properties).toMatchObject(
    { telemetry_incomplete: true, collection_error_count: 1 },
  );
  expect(events.at(-1)?.properties).toMatchObject({
    telemetry_incomplete: true,
    collection_error_count: 1,
  });
});

it("classifies Playwright failures by outcome, including timeouts and expected failures", () => {
  const events = testTelemetryEvents({
    ...artifact,
    tests: [
      {
        ...artifact.tests[0]!,
        fullName: "times out unexpectedly",
        state: "timedOut",
        outcome: "unexpected",
        retryCount: 0,
        passedAfterRetry: false,
        attempts: [],
      },
      {
        ...artifact.tests[0]!,
        fullName: "fails as expected",
        state: "failed",
        outcome: "expected",
        retryCount: 0,
        passedAfterRetry: false,
        attempts: [],
      },
    ],
  });

  expect(
    events
      .filter((event) => event.event === "ci test finished")
      .map((event) => event.properties.failed),
  ).toEqual([true, false]);
  expect(events.at(-1)?.properties.failed_test_count).toBe(1);
});

it("keeps exhaustive raw detail but bounds normalized phase and import fan-out", () => {
  const manyPhases = Array.from({ length: 101 }, (_, index) => ({
    name: `phase ${index}`,
    durationMs: index,
  }));
  const manyImports = Array.from({ length: 101 }, (_, index) => ({
    moduleId: `dependency-${index}.ts`,
    selfDurationMs: index,
  }));
  const events = testTelemetryEvents({
    ...artifact,
    tests: [
      {
        ...artifact.tests[0]!,
        attempts: [{ ...artifact.tests[0]!.attempts[0]!, phases: manyPhases }],
      },
    ],
    modules: [{ ...artifact.modules[0]!, imports: manyImports }],
  });

  expect(events.filter((event) => event.event === "ci test phase finished")).toHaveLength(100);
  expect(
    events.find((event) => event.event === "ci test attempt finished")?.properties,
  ).toMatchObject({ phase_count: 101, phase_event_count: 100, phase_events_omitted: 1 });
  expect(events.filter((event) => event.event === "ci test import finished")).toHaveLength(100);
  expect(
    events.find((event) => event.event === "ci test module finished")?.properties,
  ).toMatchObject({ import_count: 101, import_event_count: 100, import_events_omitted: 1 });
});

it("normalizes source paths with the artifact's original workspace when replayed elsewhere", () => {
  const originalWorkspace = "/depot/workspace/iterate";
  const replayArtifact: TestTelemetryArtifact = {
    ...artifact,
    ci: { ...artifact.ci, workspaceRoot: originalWorkspace },
    tests: [
      {
        ...artifact.tests[0]!,
        moduleId: `${originalWorkspace}/specs/resume.spec.ts`,
        attempts: [
          {
            ...artifact.tests[0]!.attempts[0]!,
            phases: [
              {
                ...artifact.tests[0]!.attempts[0]!.phases[0]!,
                sourceFile: `${originalWorkspace}/specs/resume.spec.ts`,
              },
            ],
          },
        ],
      },
    ],
    modules: [
      {
        ...artifact.modules[0]!,
        moduleId: `${originalWorkspace}/specs/resume.spec.ts`,
        imports: [
          {
            ...artifact.modules[0]!.imports[0]!,
            moduleId: `${originalWorkspace}/specs/test-support/session.ts`,
          },
        ],
      },
    ],
  };

  const events = testTelemetryEvents(replayArtifact);
  expect(events.find((event) => event.event === "ci test finished")?.properties.test_module).toBe(
    "specs/resume.spec.ts",
  );
  expect(events.find((event) => event.event === "ci test finished")?.properties.test_id).toBe(
    "playwright:specs/resume.spec.ts:feed resumes:web",
  );
  expect(
    events.find((event) => event.event === "ci test phase finished")?.properties.source_file,
  ).toBe("specs/resume.spec.ts");
  expect(
    events.find((event) => event.event === "ci test import finished")?.properties.imported_module,
  ).toBe("specs/test-support/session.ts");
});
