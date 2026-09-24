import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import type { TestTelemetryArtifact } from "../ci-telemetry.ts";
import { E2E_BUDGET_EXEMPTIONS } from "./budgets.ts";
import { RetryTelemetryReporter } from "./retry-telemetry-reporter.ts";

test("records module timing when Vitest omits the queued callback", () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_FILE", undefined);
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", undefined);
  const reporter = new RetryTelemetryReporter({ testKind: "e2e", suite: "vitest" });
  const testModule = {
    moduleId: "/repo/single-file.e2e.test.ts",
    children: { allTests: () => [] },
  };

  expect(() => {
    reporter.onTestModuleStart(testModule);
    reporter.onTestModuleEnd(testModule);
  }).not.toThrow();
});

test("writes its pessimistic sentinel only when the Vitest run starts", () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_FILE", undefined);
  const directory = mkdtempSync(join(tmpdir(), "vitest-telemetry-start-"));
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", directory);

  const reporter = new RetryTelemetryReporter();
  expect(readdirSync(directory)).toHaveLength(0);

  reporter.onTestRunStart();
  expect(readdirSync(directory)).toHaveLength(1);
  rmSync(directory, { recursive: true });
});

test("preserves an interrupted Vitest run instead of reporting a test failure", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_FILE", undefined);
  const directory = mkdtempSync(join(tmpdir(), "vitest-telemetry-interrupted-"));
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", directory);

  await new RetryTelemetryReporter().onTestRunEnd([], [], "interrupted");

  const artifact = JSON.parse(
    readFileSync(join(directory, readdirSync(directory)[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact).toMatchObject({
    run: { status: "interrupted" },
    runners: [expect.objectContaining({ status: "interrupted" })],
  });
  rmSync(directory, { recursive: true });
});

test("records the first failed attempt when a retry passes", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const file = join(tmpdir(), `retry-telemetry-${process.pid}-${Date.now()}.json`);
  // Scoped: the flaky fixture below writes an unknown-flake record, which
  // must land here and never in the CI run's real FLAKE_RECORD_DIR.
  const flakeRecordDir = mkdtempSync(join(tmpdir(), "retry-flake-records-"));
  vi.stubEnv("FLAKE_RECORD_DIR", flakeRecordDir);
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", undefined);
  vi.stubEnv("TEST_TELEMETRY_KIND", undefined);
  vi.stubEnv("TEST_TELEMETRY_SUITE", undefined);
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_FILE", file);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());

  const testCase = {
    id: "network-test-id",
    fullName: "network > reconnects",
    name: "reconnects",
    location: { line: 12, column: 4 },
    options: { mode: "run" as const, timeout: 30_000 },
    tags: ["network"],
    diagnostic: () => ({ retryCount: 1, flaky: true, duration: 1234.4, startTime: 2_000 }),
    result: () => ({
      state: "passed",
      errors: [{ message: "Network connection\n lost" }],
    }),
    annotations: () => [{ type: "note", message: "probe eviction" }],
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
  const reporter = new RetryTelemetryReporter({ testKind: "e2e", suite: "vitest" });
  reporter.onTestModuleQueued(testModule);
  reporter.onTestModuleCollected(testModule);
  reporter.onTestModuleStart(testModule);
  reporter.onTestModuleEnd(testModule);
  await reporter.onTestRunEnd([testModule]);

  // The retried-pass also produced an unknown-flake record, keyed on the
  // BARE test name (what a later createFlake wrap would record) with the
  // failed attempt's error as the sample.
  const flakeRecords = readdirSync(flakeRecordDir).flatMap((recordFile) =>
    readFileSync(join(flakeRecordDir, recordFile), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  expect(flakeRecords).toMatchObject([
    { name: "reconnects", kind: "unknown", outcome: "retried-pass" },
  ]);

  const telemetry = JSON.parse(readFileSync(file, "utf8")) as TestTelemetryArtifact;
  expect(telemetry).toMatchObject({
    tests: [
      expect.objectContaining({
        fullName: "network > reconnects",
        leafName: "reconnects",
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
        annotations: [{ type: "note", description: "probe eviction" }],
        phases: [],
        firstFailure: "Network connection lost",
      }),
    ],
    context: expect.objectContaining({ framework: "vitest", testKind: "e2e" }),
    runners: [expect.objectContaining({ status: "passed", testCount: 1, retryCount: 1 })],
    modules: [
      expect.objectContaining({
        moduleId: "/repo/network.e2e.test.ts",
        environmentSetupDurationMs: 1,
        prepareDurationMs: 2,
        collectDurationMs: 3,
        setupDurationMs: 4,
        testAndHookDurationMs: 1234,
        importDurationMs: 5,
      }),
    ],
  });
  expect(log).toHaveBeenCalledWith(
    "[retry-telemetry] 1 test(s) needed retries: network > reconnects (x1) — Network connection lost",
  );
  rmSync(file);
});

test("a plain test that failed every attempt leaves an unexpected-error flake record", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const directory = mkdtempSync(join(tmpdir(), "vitest-hard-failure-"));
  const flakeRecordDir = join(directory, "flake-records");
  vi.stubEnv("FLAKE_RECORD_DIR", flakeRecordDir);
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_FILE", join(directory, "telemetry.json"));
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  const testCase = (name: string, state: string, options?: { fails: boolean }) => ({
    fullName: `socket > ${name}`,
    name,
    ...(options && { options: { ...options, mode: "run" as const } }),
    diagnostic: () => ({ retryCount: 1, flaky: false, duration: 61_000, startTime: 2_000 }),
    result: () => ({ state, errors: [{ message: "socket closed before the stream opened" }] }),
  });
  const testModule = {
    moduleId: "/repo/socket.e2e.test.ts",
    children: {
      allTests: () => [
        testCase("opens", "failed"),
        // A createFailing pin that held: the runner's expected-fail mode, never an unknown flake.
        testCase("pinned", "passed", { fails: true }),
      ],
    },
  };

  await new RetryTelemetryReporter({ testKind: "e2e", suite: "vitest" }).onTestRunEnd(
    [testModule],
    [],
    "failed",
  );

  const records = readdirSync(flakeRecordDir).flatMap((file) =>
    readFileSync(join(flakeRecordDir, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  expect(records).toEqual([
    {
      name: "opens",
      kind: "unknown",
      outcome: "unexpected-error",
      durationMs: 61_000,
      at: new Date(2_000).toISOString(),
      error: "socket closed before the stream opened",
    },
  ]);
  rmSync(directory, { recursive: true });
});

test("writes unit tests without performing network I/O", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_FILE", undefined);
  const directory = mkdtempSync(join(tmpdir(), "vitest-telemetry-artifacts-"));
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", directory);
  vi.stubEnv("npm_package_name", "@iterate/example");
  vi.stubEnv("GITHUB_WORKSPACE", "/repo");
  const fetchMock = vi.spyOn(globalThis, "fetch");
  onTestFinished(() => fetchMock.mockRestore());

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

test("prints the e2e rows that ran past the row budget's warning, marking exempt rows", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const directory = mkdtempSync(join(tmpdir(), "vitest-row-budget-"));
  onTestFinished(() => rmSync(directory, { recursive: true }));
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_FILE", join(directory, "telemetry.json"));
  vi.stubEnv("TEST_TELEMETRY_ARTIFACT_DIR", undefined);
  vi.stubEnv("FLAKE_RECORD_DIR", undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  const row = (name: string, project: string, duration: number, tags: string[] = []) => ({
    fullName: name,
    name,
    tags,
    project: { name: project },
    diagnostic: () => ({ retryCount: 0, flaky: false, duration, startTime: 2_000 }),
    result: () => ({ state: "passed", errors: [] }),
  });
  const exempt = Object.keys(E2E_BUDGET_EXEMPTIONS)[0]!;
  const testModule = {
    moduleId: "/repo/residency.e2e.test.ts",
    children: {
      allTests: () => [
        row("a quick row", "e2e", 44_000),
        row(exempt, "e2e", 61_700),
        row("a quiet minute", "e2e", 181_400),
        row("a slow row", "e2e", 181_400, ["slow"]),
        row("a long unit row", "unit", 60_000),
      ],
    },
  };

  await new RetryTelemetryReporter({ testKind: "e2e", suite: "vitest" }).onTestRunEnd([testModule]);

  expect(log.mock.calls.flat().filter((line) => String(line).startsWith("[row-budget]"))).toEqual([
    "[row-budget] 2 e2e row(s) ran longer than 45 s; a row that runs on every PR finishes within 60 s at its p95:",
    "[row-budget] 181.4 s a quiet minute",
    `[row-budget] 61.7 s (exempt) ${exempt}`,
  ]);
});
