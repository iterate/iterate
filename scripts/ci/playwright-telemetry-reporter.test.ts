import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { expect, test, vi } from "vitest";
import type { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import PlaywrightTelemetryReporter from "./playwright-telemetry-reporter.ts";

test("records each test after its attempts, and a flake record for a retried pass, without uploading", async () => {
  isolateTelemetryEnvironment();
  using artifactDirectory = temporaryDirectory();
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", artifactDirectory.path);
  using flakeRecordDirectory = temporaryDirectory();
  vi.stubEnv("FLAKE_RECORD_DIR", flakeRecordDirectory.path);
  const firstResult = {
    retry: 0,
    status: "failed",
    duration: 500,
    startTime: new Date("2026-07-21T12:00:00Z"),
    error: { message: "connection lost", stack: "stack" },
    errors: [{ message: "connection lost", stack: "stack" }],
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
    title: "greets",
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

  const files = readdirSync(artifactDirectory.path);
  expect(files).toHaveLength(1);
  const artifact = JSON.parse(
    readFileSync(join(artifactDirectory.path, files[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact.context).toMatchObject({
    framework: "playwright",
    testKind: "e2e",
    suite: "playwright",
  });
  expect(artifact.tests[0]).toMatchObject({
    fullName: "chromium › greeting.spec.ts › greets",
    leafName: "greets",
    moduleId: "/repo/specs/greeting.spec.ts",
    durationMs: 800,
    retryCount: 1,
    passedAfterRetry: true,
    state: "passed",
    outcome: "flaky",
    startedAt: "2026-07-21T12:00:00.000Z",
    errors: [{ message: "connection lost", stack: "stack" }],
    firstFailure: "connection lost",
  });

  // The flaky (passed-after-retry) test also produced an unknown-flake
  // record — the test-health dashboard's adoption-funnel signal — while the
  // deterministic passer did not.
  const flakeRecords = readdirSync(flakeRecordDirectory.path).flatMap((file) =>
    readFileSync(join(flakeRecordDirectory.path, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  // Keyed on the bare title — the same name a later createFlake wrap would
  // record — not the project/file-prefixed fullName.
  expect(flakeRecords).toMatchObject([
    { name: "greets", kind: "unknown", outcome: "retried-pass" },
  ]);
});

test("keeps Playwright's raw result status separate from its expected outcome", async () => {
  isolateTelemetryEnvironment();
  using artifactDirectory = temporaryDirectory();
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", artifactDirectory.path);
  const failedAsExpected = {
    retry: 0,
    status: "failed",
    duration: 100,
    startTime: new Date("2026-07-21T12:00:00Z"),
    errors: [{ message: "expected failure" }],
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
    readFileSync(join(artifactDirectory.path, readdirSync(artifactDirectory.path)[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact.tests[0]).toMatchObject({ state: "failed", outcome: "expected" });
});

test("a plain spec that failed every attempt leaves an unexpected-error flake record", async () => {
  isolateTelemetryEnvironment();
  using artifactDirectory = temporaryDirectory();
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", artifactDirectory.path);
  using flakeRecordDirectory = temporaryDirectory();
  vi.stubEnv("FLAKE_RECORD_DIR", flakeRecordDirectory.path);
  const attempt = (retry: number) =>
    ({
      retry,
      status: "failed",
      duration: 400,
      startTime: new Date(`2026-07-21T12:00:0${retry}Z`),
      errors: [{ message: `attempt ${retry}: locator('chat') not visible` }],
    }) as unknown as TestResult;
  const test = {
    results: [attempt(0), attempt(1)],
    title: "chat opens",
    titlePath: () => ["chromium", "chat.spec.ts", "chat opens"],
    location: { file: "/repo/specs/chat.spec.ts", line: 3, column: 1 },
    parent: { project: () => ({ name: "chromium" }) },
    expectedStatus: "passed",
    outcome: () => "unexpected",
  } as unknown as TestCase;
  const reporter = new PlaywrightTelemetryReporter();
  reporter.onBegin(
    { rootDir: "/repo/specs" } as FullConfig,
    { allTests: () => [test] } as unknown as Suite,
  );
  await reporter.onEnd({
    status: "failed",
    startTime: new Date("2026-07-21T12:00:00Z"),
    duration: 800,
  } as FullResult);

  const flakeRecords = readdirSync(flakeRecordDirectory.path).flatMap((file) =>
    readFileSync(join(flakeRecordDirectory.path, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  // The first attempt's error: the one a retry would have absorbed.
  expect(flakeRecords).toEqual([
    {
      name: "chat opens",
      kind: "unknown",
      outcome: "unexpected-error",
      durationMs: 800,
      at: "2026-07-21T12:00:00.000Z",
      error: "attempt 0: locator('chat') not visible",
    },
  ]);
});

test("preserves timed-out runs and run-level Playwright errors", async () => {
  isolateTelemetryEnvironment();
  using artifactDirectory = temporaryDirectory();
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", artifactDirectory.path);
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
    readFileSync(join(artifactDirectory.path, readdirSync(artifactDirectory.path)[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact.run).toMatchObject({
    status: "timedout",
    error: { message: "worker stopped responding", stack: "stack" },
    collectionErrors: ["worker stopped responding"],
  });
});

test("an interrupted attempt's negative duration is recorded as zero", async () => {
  isolateTelemetryEnvironment();
  using artifactDirectory = temporaryDirectory();
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", artifactDirectory.path);
  const interruptedResult = {
    retry: 0,
    status: "interrupted",
    duration: -1,
    startTime: new Date("2026-07-21T12:00:00Z"),
    errors: [],
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
    readFileSync(join(artifactDirectory.path, readdirSync(artifactDirectory.path)[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact.run).toMatchObject({ status: "interrupted", durationMs: 0 });
  expect(artifact.tests[0]).toMatchObject({ state: "interrupted", durationMs: 0 });
});

/** Each test starts from a clean telemetry environment, and every variable it stubs is restored
 *  when it finishes. Never let a CI run's real record dir catch this file's synthetic flakes. */
function isolateTelemetryEnvironment() {
  vi.stubEnv("TEST_TELEMETRY_KIND", undefined);
  vi.stubEnv("TEST_TELEMETRY_SUITE", undefined);
  vi.stubEnv("FLAKE_RECORD_DIR", undefined);
}
