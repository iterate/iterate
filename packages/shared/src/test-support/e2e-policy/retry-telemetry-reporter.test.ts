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

it("records the first failed attempt when a retry passes", () => {
  const file = join(tmpdir(), `retry-telemetry-${process.pid}-${Date.now()}.json`);
  process.env.E2E_RETRY_TELEMETRY_FILE = file;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  new RetryTelemetryReporter().onTestRunEnd([
    {
      moduleId: "/repo/network.e2e.test.ts",
      children: {
        allTests: () => [
          {
            fullName: "network > reconnects",
            diagnostic: () => ({ retryCount: 1, flaky: true, duration: 1234.4 }),
            result: () => ({
              state: "passed",
              errors: [{ message: "Network connection\n lost" }],
            }),
          },
        ],
      },
    },
  ]);

  const telemetry = JSON.parse(readFileSync(file, "utf8")) as RetryTelemetryFile;
  expect(telemetry.retried).toEqual([
    {
      fullName: "network > reconnects",
      moduleId: "/repo/network.e2e.test.ts",
      retryCount: 1,
      passedAfterRetry: true,
      state: "passed",
      durationMs: 1234,
      firstFailure: "Network connection lost",
    },
  ]);
  expect(log).toHaveBeenCalledWith(
    "[retry-telemetry] 1 test(s) needed retries: network > reconnects (x1) — Network connection lost",
  );
  rmSync(file);
});
