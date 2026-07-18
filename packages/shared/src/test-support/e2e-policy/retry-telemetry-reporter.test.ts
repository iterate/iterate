import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { type RetryTelemetryFile, RetryTelemetryReporter } from "./retry-telemetry-reporter.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("records and prints the failed-attempt error retained after a passing retry", () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "retry-telemetry-reporter-"));
  const outputFile = join(tempDirectory, "retries.json");
  vi.stubEnv("E2E_RETRY_TELEMETRY_FILE", outputFile);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  try {
    const reporter = new RetryTelemetryReporter();
    reporter.onTestRunEnd([
      {
        moduleId: "/repo/example.e2e.test.ts",
        children: {
          allTests: () => [
            {
              fullName: "eventually passes",
              diagnostic: () => ({ retryCount: 1, flaky: true, duration: 1_234.4 }),
              result: () => ({
                state: "passed",
                errors: [
                  {
                    name: "AssertionError",
                    message: "expected first attempt\n to pass",
                    stack: "AssertionError: expected first attempt to pass\n  at example.ts:12:3",
                  },
                ],
              }),
            },
          ],
        },
      },
    ]);

    const telemetry = JSON.parse(readFileSync(outputFile, "utf8")) as RetryTelemetryFile;
    expect(telemetry.retried).toEqual([
      {
        fullName: "eventually passes",
        moduleId: "/repo/example.e2e.test.ts",
        retryCount: 1,
        passedAfterRetry: true,
        state: "passed",
        durationMs: 1_234,
        errors: [
          {
            name: "AssertionError",
            message: "expected first attempt\n to pass",
            stack: "AssertionError: expected first attempt to pass\n  at example.ts:12:3",
          },
        ],
      },
    ]);
    expect(log).toHaveBeenCalledWith(
      "[retry-telemetry] 1 test(s) needed retries: eventually passes (x1; first failure: expected first attempt to pass)",
    );
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
