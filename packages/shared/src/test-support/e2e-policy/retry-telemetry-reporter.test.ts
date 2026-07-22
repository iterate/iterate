import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TestTelemetryArtifact } from "../ci-telemetry.ts";
import { RetryTelemetryReporter } from "./retry-telemetry-reporter.ts";

const originalTelemetryFile = process.env.TEST_TELEMETRY_ARTIFACT_FILE;
const originalArtifactDirectory = process.env.TEST_TELEMETRY_ARTIFACT_DIR;
const originalTelemetryKind = process.env.TEST_TELEMETRY_KIND;
const originalTelemetryLane = process.env.TEST_TELEMETRY_LANE;
const originalPackageName = process.env.npm_package_name;
const originalGithubWorkspace = process.env.GITHUB_WORKSPACE;

afterEach(() => {
  restoreEnv("TEST_TELEMETRY_ARTIFACT_FILE", originalTelemetryFile);
  restoreEnv("TEST_TELEMETRY_ARTIFACT_DIR", originalArtifactDirectory);
  restoreEnv("TEST_TELEMETRY_KIND", originalTelemetryKind);
  restoreEnv("TEST_TELEMETRY_LANE", originalTelemetryLane);
  restoreEnv("npm_package_name", originalPackageName);
  restoreEnv("GITHUB_WORKSPACE", originalGithubWorkspace);
  vi.restoreAllMocks();
});

it("records module timing when Vitest omits the queued callback", () => {
  delete process.env.TEST_TELEMETRY_ARTIFACT_FILE;
  delete process.env.TEST_TELEMETRY_ARTIFACT_DIR;
  const reporter = new RetryTelemetryReporter({ testKind: "e2e", lane: "vitest" });
  const testModule = {
    moduleId: "/repo/single-file.e2e.test.ts",
    children: { allTests: () => [] },
  };

  expect(() => {
    reporter.onTestModuleStart(testModule);
    reporter.onTestModuleEnd(testModule);
  }).not.toThrow();
});

it("writes its pessimistic sentinel only when the Vitest run starts", () => {
  delete process.env.TEST_TELEMETRY_ARTIFACT_FILE;
  const directory = mkdtempSync(join(tmpdir(), "vitest-telemetry-start-"));
  process.env.TEST_TELEMETRY_ARTIFACT_DIR = directory;

  const reporter = new RetryTelemetryReporter();
  expect(readdirSync(directory)).toHaveLength(0);

  reporter.onTestRunStart();
  expect(readdirSync(directory)).toHaveLength(1);
  rmSync(directory, { recursive: true });
});

it("preserves an interrupted Vitest run instead of reporting a test failure", async () => {
  delete process.env.TEST_TELEMETRY_ARTIFACT_FILE;
  const directory = mkdtempSync(join(tmpdir(), "vitest-telemetry-interrupted-"));
  process.env.TEST_TELEMETRY_ARTIFACT_DIR = directory;

  await new RetryTelemetryReporter().onTestRunEnd([], [], "interrupted");

  const artifact = JSON.parse(
    readFileSync(join(directory, readdirSync(directory)[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact.run.status).toBe("interrupted");
  expect(artifact.lanes).toEqual([expect.objectContaining({ status: "interrupted" })]);
  rmSync(directory, { recursive: true });
});

it("records the first failed attempt when a retry passes", async () => {
  const file = join(tmpdir(), `retry-telemetry-${process.pid}-${Date.now()}.json`);
  delete process.env.TEST_TELEMETRY_ARTIFACT_DIR;
  delete process.env.TEST_TELEMETRY_KIND;
  delete process.env.TEST_TELEMETRY_LANE;
  process.env.TEST_TELEMETRY_ARTIFACT_FILE = file;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  const testCase = {
    id: "network-test-id",
    fullName: "network > reconnects",
    location: { line: 12, column: 4 },
    options: { mode: "run" as const, timeout: 30_000 },
    tags: ["network"],
    diagnostic: () => ({ retryCount: 1, flaky: true, duration: 1234.4, startTime: 2_000 }),
    result: () => ({
      state: "passed",
      errors: [{ message: "Network connection\n lost" }],
    }),
    annotations: () => [
      { type: "e2e-phase", message: '{"name":"probe eviction","durationMs":20000}' },
    ],
  };
  const testModule = {
    moduleId: "/repo/network.e2e.test.ts",
    children: { allTests: () => [testCase] },
    diagnostic: () => ({
      environmentSetupDuration: 1,
      prepareDuration: 2,
      collectDuration: 3,
      setupDuration: 4,
      duration: 1234.4,
      importDurations: { "/repo/dependency.ts": { selfTime: 5 } },
    }),
  };
  const reporter = new RetryTelemetryReporter({ testKind: "e2e", lane: "vitest" });
  reporter.onTestModuleQueued(testModule);
  reporter.onTestModuleCollected(testModule);
  reporter.onTestModuleStart(testModule);
  reporter.onTestModuleEnd(testModule);
  await reporter.onTestRunEnd([testModule]);

  const telemetry = JSON.parse(readFileSync(file, "utf8")) as TestTelemetryArtifact;
  expect(telemetry.tests).toEqual([
    expect.objectContaining({
      fullName: "network > reconnects",
      moduleId: "/repo/network.e2e.test.ts",
      retryCount: 1,
      passedAfterRetry: true,
      state: "passed",
      durationMs: 1234,
      beforeEachDurationMs: 0,
      afterEachDurationMs: 0,
      bodyDurationMs: 1234,
      runnerTestId: "network-test-id",
      testLine: 12,
      testColumn: 4,
      expectedState: "passed",
      configuredTimeoutMs: 30_000,
      tags: ["network"],
      annotations: [
        {
          type: "e2e-phase",
          description: '{"name":"probe eviction","durationMs":20000}',
        },
      ],
      phases: [{ name: "probe eviction", durationMs: 20000 }],
      firstFailure: "Network connection lost",
    }),
  ]);
  expect(telemetry.context).toEqual(
    expect.objectContaining({ framework: "vitest", testKind: "e2e" }),
  );
  expect(telemetry.lanes).toEqual([
    expect.objectContaining({ status: "passed", testCount: 1, retryCount: 1 }),
  ]);
  expect(telemetry.modules).toEqual([
    expect.objectContaining({
      moduleId: "/repo/network.e2e.test.ts",
      environmentSetupDurationMs: 1,
      prepareDurationMs: 2,
      collectDurationMs: 3,
      setupDurationMs: 4,
      testAndHookDurationMs: 1234,
      importDurationMs: 5,
    }),
  ]);
  expect(log).toHaveBeenCalledWith(
    "[retry-telemetry] 1 test(s) needed retries: network > reconnects (x1) — Network connection lost",
  );
  rmSync(file);
});

it("writes unit tests without performing network I/O", async () => {
  delete process.env.TEST_TELEMETRY_ARTIFACT_FILE;
  const directory = mkdtempSync(join(tmpdir(), "vitest-telemetry-artifacts-"));
  process.env.TEST_TELEMETRY_ARTIFACT_DIR = directory;
  process.env.npm_package_name = "@iterate/example";
  process.env.GITHUB_WORKSPACE = "/repo";
  const fetchMock = vi.spyOn(globalThis, "fetch");

  const testCase = {
    fullName: "math > adds",
    diagnostic: () => ({ retryCount: 0, flaky: false, duration: 12 }),
    result: () => ({ state: "passed", errors: [] }),
  };
  const testModule = {
    moduleId: "/repo/packages/example/math.test.ts",
    children: { allTests: () => [testCase] },
    diagnostic: () => ({
      environmentSetupDuration: 1,
      prepareDuration: 2,
      collectDuration: 3,
      setupDuration: 4,
      duration: 12,
      importDurations: {},
    }),
  };

  await new RetryTelemetryReporter().onTestRunEnd([testModule]);

  expect(fetchMock).not.toHaveBeenCalled();
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  const artifact = JSON.parse(
    readFileSync(join(directory, files[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact).toMatchObject({
    producer: "vitest-retry-telemetry-reporter",
    context: { framework: "vitest", testKind: "unit", workspace: "@iterate/example" },
    tests: [expect.objectContaining({ fullName: "math > adds", durationMs: 12 })],
  });
  rmSync(directory, { recursive: true });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
