import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import PlaywrightTelemetryReporter from "./playwright-telemetry-reporter.ts";

const originalArtifactDirectory = process.env.TEST_TELEMETRY_ARTIFACT_DIR;
const originalFlakeRecordDirectory = process.env.FLAKE_RECORD_DIR;
const originalTelemetryKind = process.env.TEST_TELEMETRY_KIND;
const originalTelemetryLane = process.env.TEST_TELEMETRY_LANE;

beforeEach(() => {
  delete process.env.TEST_TELEMETRY_KIND;
  delete process.env.TEST_TELEMETRY_LANE;
});

afterEach(() => {
  restoreEnv("TEST_TELEMETRY_ARTIFACT_DIR", originalArtifactDirectory);
  restoreEnv("FLAKE_RECORD_DIR", originalFlakeRecordDirectory);
  restoreEnv("TEST_TELEMETRY_KIND", originalTelemetryKind);
  restoreEnv("TEST_TELEMETRY_LANE", originalTelemetryLane);
});

it("records every Playwright attempt and nested step without uploading", async () => {
  const artifactDirectory = mkdtempSync(join(tmpdir(), "playwright-telemetry-"));
  process.env.TEST_TELEMETRY_ARTIFACT_DIR = artifactDirectory;
  const flakeRecordDirectory = mkdtempSync(join(tmpdir(), "flake-records-"));
  process.env.FLAKE_RECORD_DIR = flakeRecordDirectory;
  const firstResult = {
    retry: 0,
    status: "failed",
    duration: 500,
    startTime: new Date("2026-07-21T12:00:00Z"),
    workerIndex: 2,
    parallelIndex: 1,
    error: { message: "connection lost", stack: "stack" },
    errors: [{ message: "connection lost", stack: "stack" }],
    steps: [
      {
        title: "wait for greeting",
        titlePath: () => ["wait for greeting"],
        category: "test.step",
        duration: 450,
        steps: [],
      },
    ],
  } as unknown as TestResult;
  const secondResult = {
    ...firstResult,
    retry: 1,
    status: "passed",
    duration: 300,
    startTime: new Date("2026-07-21T12:00:01Z"),
    error: undefined,
    errors: [],
  } as unknown as TestResult;
  const test = {
    results: [firstResult, secondResult],
    titlePath: () => ["chromium", "greeting.spec.ts", "greets"],
    location: { file: "/repo/specs/greeting.spec.ts", line: 12, column: 3 },
    parent: { project: () => ({ name: "chromium" }) },
    outcome: () => "flaky",
    ok: () => true,
  } as unknown as TestCase;
  const reporter = new PlaywrightTelemetryReporter();
  reporter.onBegin(
    { rootDir: "/repo/specs" } as FullConfig,
    {
      allTests: () => [test],
    } as unknown as Suite,
  );
  await reporter.onEnd({
    status: "passed",
    startTime: new Date("2026-07-21T12:00:00Z"),
    duration: 1500,
  } as FullResult);

  const files = readdirSync(artifactDirectory);
  expect(files).toHaveLength(1);
  const artifact = JSON.parse(
    readFileSync(join(artifactDirectory, files[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact.context).toMatchObject({
    framework: "playwright",
    testKind: "e2e",
    lane: "playwright",
  });
  expect(artifact.tests[0]).toMatchObject({
    fullName: "chromium › greeting.spec.ts › greets",
    durationMs: 800,
    retryCount: 1,
    passedAfterRetry: true,
    state: "passed",
    outcome: "flaky",
  });
  expect(artifact.tests[0]?.attempts).toEqual([
    expect.objectContaining({ attemptIndex: 0, state: "failed" }),
    expect.objectContaining({ attemptIndex: 1, state: "passed" }),
  ]);
  expect(artifact.tests[0]?.attempts[0]?.phases).toEqual([
    expect.objectContaining({
      name: "wait for greeting",
      category: "test.step",
      durationMs: 450,
    }),
  ]);
  rmSync(artifactDirectory, { recursive: true });

  // The flaky (passed-after-retry) test also produced an unknown-flake
  // record — the test-health dashboard's adoption-funnel signal — while the
  // deterministic passer did not.
  const flakeRecords = readdirSync(flakeRecordDirectory).flatMap((file) =>
    readFileSync(join(flakeRecordDirectory, file), "utf8").trim().split("\n").map(JSON.parse),
  );
  expect(flakeRecords).toMatchObject([
    {
      name: "chromium › greeting.spec.ts › greets",
      kind: "unknown",
      outcome: "retried-pass",
    },
  ]);
});

it("keeps Playwright's raw result status separate from its expected outcome", async () => {
  const artifactDirectory = mkdtempSync(join(tmpdir(), "playwright-telemetry-expected-"));
  process.env.TEST_TELEMETRY_ARTIFACT_DIR = artifactDirectory;
  const failedAsExpected = {
    retry: 0,
    status: "failed",
    duration: 100,
    startTime: new Date("2026-07-21T12:00:00Z"),
    workerIndex: 0,
    parallelIndex: 0,
    errors: [{ message: "expected failure" }],
    steps: [],
  } as unknown as TestResult;
  const test = {
    results: [failedAsExpected],
    titlePath: () => ["expected failure"],
    location: { file: "/repo/specs/expected.spec.ts", line: 1, column: 1 },
    parent: { project: () => ({ name: "chromium" }) },
    outcome: () => "expected",
  } as unknown as TestCase;
  const reporter = new PlaywrightTelemetryReporter();
  reporter.onBegin(
    { rootDir: "/repo/specs" } as FullConfig,
    { allTests: () => [test] } as unknown as Suite,
  );
  await reporter.onEnd({
    status: "passed",
    startTime: new Date("2026-07-21T12:00:00Z"),
    duration: 100,
  } as FullResult);

  const artifact = JSON.parse(
    readFileSync(join(artifactDirectory, readdirSync(artifactDirectory)[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact.tests[0]).toMatchObject({ state: "failed", outcome: "expected" });
  rmSync(artifactDirectory, { recursive: true });
});

it("preserves timed-out runs and run-level Playwright errors", async () => {
  const artifactDirectory = mkdtempSync(join(tmpdir(), "playwright-telemetry-timeout-"));
  process.env.TEST_TELEMETRY_ARTIFACT_DIR = artifactDirectory;
  const reporter = new PlaywrightTelemetryReporter();
  reporter.onBegin(
    { rootDir: "/repo/specs" } as FullConfig,
    { allTests: () => [] } as unknown as Suite,
  );
  reporter.onError({ message: "worker stopped responding", stack: "stack" });
  await reporter.onEnd({
    status: "timedout",
    startTime: new Date("2026-07-21T12:00:00Z"),
    duration: 30_000,
  } as FullResult);

  const artifact = JSON.parse(
    readFileSync(join(artifactDirectory, readdirSync(artifactDirectory)[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact.run).toMatchObject({
    status: "timedout",
    error: { message: "worker stopped responding", stack: "stack" },
  });
  expect(artifact.lanes[0]).toMatchObject({
    status: "timedout",
    collectionErrors: ["worker stopped responding"],
  });
  rmSync(artifactDirectory, { recursive: true });
});

it("preserves interrupted attempts whose unfinished Playwright steps use negative durations", async () => {
  const artifactDirectory = mkdtempSync(join(tmpdir(), "playwright-telemetry-interrupted-"));
  process.env.TEST_TELEMETRY_ARTIFACT_DIR = artifactDirectory;
  const interruptedResult = {
    retry: 0,
    status: "interrupted",
    duration: -1,
    startTime: new Date("2026-07-21T12:00:00Z"),
    workerIndex: 0,
    parallelIndex: 0,
    errors: [],
    steps: [
      {
        titlePath: () => ["wait for worker"],
        category: "test.step",
        duration: -1,
        steps: [],
      },
    ],
  } as unknown as TestResult;
  const test = {
    results: [interruptedResult],
    titlePath: () => ["interrupted test"],
    location: { file: "/repo/specs/interrupted.spec.ts", line: 1, column: 1 },
    parent: { project: () => ({ name: "chromium" }) },
    outcome: () => "unexpected",
  } as unknown as TestCase;
  const reporter = new PlaywrightTelemetryReporter();
  reporter.onBegin(
    { rootDir: "/repo/specs" } as FullConfig,
    { allTests: () => [test] } as unknown as Suite,
  );
  await reporter.onEnd({
    status: "interrupted",
    startTime: new Date("2026-07-21T12:00:00Z"),
    duration: -1,
  } as FullResult);

  const artifact = JSON.parse(
    readFileSync(join(artifactDirectory, readdirSync(artifactDirectory)[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact.run).toMatchObject({ status: "interrupted", durationMs: 0 });
  expect(artifact.tests[0]?.attempts[0]).toMatchObject({
    state: "interrupted",
    durationMs: 0,
    phases: [
      {
        name: "wait for worker",
        durationMs: 0,
        error: {
          name: "PlaywrightIncompleteStepError",
          message: "Playwright step did not finish before runner shutdown",
        },
      },
    ],
  });
  rmSync(artifactDirectory, { recursive: true });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
