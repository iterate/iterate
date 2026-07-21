import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RetryTelemetryReporter, type RetryTelemetryFile } from "./retry-telemetry-reporter.ts";

const originalTelemetryFile = process.env.E2E_RETRY_TELEMETRY_FILE;

afterEach(() => {
  if (originalTelemetryFile === undefined) delete process.env.E2E_RETRY_TELEMETRY_FILE;
  else process.env.E2E_RETRY_TELEMETRY_FILE = originalTelemetryFile;
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

it("records the first failed attempt when a retry passes", () => {
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
  reporter.onTestRunEnd([testModule]);

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
