import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RetryTelemetryReporter, type RetryTelemetryFile } from "./retry-telemetry-reporter.ts";

const originalTelemetryFile = process.env.E2E_RETRY_TELEMETRY_FILE;
const originalTelemetryEnabled = process.env.TEST_TELEMETRY_ENABLED;
const originalPostHog = process.env.APP_CONFIG_POSTHOG;
const originalPackageName = process.env.npm_package_name;
const originalGithubWorkspace = process.env.GITHUB_WORKSPACE;

afterEach(() => {
  if (originalTelemetryFile === undefined) delete process.env.E2E_RETRY_TELEMETRY_FILE;
  else process.env.E2E_RETRY_TELEMETRY_FILE = originalTelemetryFile;
  restoreEnv("TEST_TELEMETRY_ENABLED", originalTelemetryEnabled);
  restoreEnv("APP_CONFIG_POSTHOG", originalPostHog);
  restoreEnv("npm_package_name", originalPackageName);
  restoreEnv("GITHUB_WORKSPACE", originalGithubWorkspace);
  vi.restoreAllMocks();
});

it("records module timing when Vitest omits the queued callback", () => {
  const reporter = new RetryTelemetryReporter();
  const testModule = {
    moduleId: "/repo/single-file.e2e.test.ts",
    children: { allTests: () => [] },
  };

  expect(() => {
    reporter.onTestModuleStart(testModule);
    reporter.onTestModuleEnd(testModule);
  }).not.toThrow();
});

it("records the first failed attempt when a retry passes", async () => {
  const file = join(tmpdir(), `retry-telemetry-${process.pid}-${Date.now()}.json`);
  process.env.E2E_RETRY_TELEMETRY_FILE = file;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  const testCase = {
    fullName: "network > reconnects",
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
  const reporter = new RetryTelemetryReporter();
  reporter.onTestModuleQueued(testModule);
  reporter.onTestModuleCollected(testModule);
  reporter.onTestModuleStart(testModule);
  reporter.onTestModuleEnd(testModule);
  await reporter.onTestRunEnd([testModule]);

  const telemetry = JSON.parse(readFileSync(file, "utf8")) as RetryTelemetryFile;
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
      phases: [{ name: "probe eviction", durationMs: 20000 }],
      firstFailure: "Network connection lost",
    }),
  ]);
  expect(telemetry.retried).toEqual(telemetry.tests);
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

it("sends unit tests through the unified CI test event model", async () => {
  delete process.env.E2E_RETRY_TELEMETRY_FILE;
  process.env.TEST_TELEMETRY_ENABLED = "1";
  process.env.APP_CONFIG_POSTHOG = JSON.stringify({ apiKey: "phc_test" });
  process.env.npm_package_name = "@iterate/example";
  process.env.GITHUB_WORKSPACE = "/repo";
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

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

  expect(fetchMock).toHaveBeenCalledOnce();
  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
    batch: Array<{ event: string; properties: Record<string, unknown> }>;
  };
  expect(body.batch.map(({ event }) => event)).toEqual([
    "ci test finished",
    "ci test module finished",
    "ci test run finished",
  ]);
  expect(body.batch[0]?.properties).toEqual(
    expect.objectContaining({
      framework: "vitest",
      test_kind: "unit",
      workspace: "@iterate/example",
      test_module: "packages/example/math.test.ts",
    }),
  );
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
