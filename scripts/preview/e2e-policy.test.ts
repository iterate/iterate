import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  E2E_CI_RETRIES,
  E2E_HEAVY_TEST_TIMEOUT_MS,
  E2E_TEST_TIMEOUT_MS,
  OS_ONBOARDING_SMOKE_TIMEOUT_SECS,
  OS_PREVIEW_LANE_TIMEOUT_SECS,
  PREVIEW_RUN_WATCHDOG_SECS,
  SPEC_ACTION_TIMEOUT_MS,
  SPEC_EXPECT_TIMEOUT_MS,
  SPEC_TEST_TIMEOUT_MS,
} from "@iterate-com/shared/test-support/e2e-policy";
import { cloudflarePreviewApps, previewInternals } from "./preview.ts";

// Guards the e2e retry/timeout policy (docs/testing.md#retries-and-timeouts):
// the budget ladder stays ordered, files that cannot import the constants
// (shell) stay in sync, and no second retry layer sneaks back in.

const repoRoot = resolve(import.meta.dirname, "../..");

describe("budget ladder", () => {
  it("stays strictly ordered: action < expect < spec < e2e test < heavy test < lane < run", () => {
    const ladder = [
      SPEC_ACTION_TIMEOUT_MS,
      SPEC_EXPECT_TIMEOUT_MS,
      SPEC_TEST_TIMEOUT_MS,
      E2E_TEST_TIMEOUT_MS,
      E2E_HEAVY_TEST_TIMEOUT_MS,
      OS_PREVIEW_LANE_TIMEOUT_SECS * 1000,
      PREVIEW_RUN_WATCHDOG_SECS * 1000,
    ];
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]).toBeGreaterThan(ladder[i - 1]!);
    }
  });

  it("no inline per-test timeout under apps/os/e2e exceeds the heavy-test ceiling", () => {
    // Case-sensitive `timeout:` matches vitest's per-test `{ timeout: N }`
    // options without matching config-level testTimeout/hookTimeout.
    const offenders: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(path);
        } else if (entry.name.endsWith(".ts")) {
          for (const match of readFileSync(path, "utf8").matchAll(/timeout:\s*([\d_]+)/g)) {
            const value = Number(match[1]!.replaceAll("_", ""));
            if (value > E2E_HEAVY_TEST_TIMEOUT_MS) {
              offenders.push(`${path}: timeout ${value}`);
            }
          }
        }
      }
    };
    visit(resolve(repoRoot, "apps/os/e2e"));
    // The root Playwright specs are part of the same preview lane; a spec
    // that overrides its timeout above the heavy ceiling becomes the lane's
    // worst-case tail (2x with its retry) — agent-chat sat at 480s until
    // 2026-07-09.
    visit(resolve(repoRoot, "specs"));
    expect(offenders).toEqual([]);
  });
});

describe("retries live in exactly one layer", () => {
  it("every e2e config takes its CI retry count from E2E_CI_RETRIES (which is 1)", () => {
    expect(E2E_CI_RETRIES).toBe(1);
    const configs = [
      "playwright.config.ts",
      "apps/os/e2e/vitest.config.ts",
      "apps/semaphore/e2e/vitest.config.ts",
      "apps/streams-example-app/vitest.config.ts",
      "apps/streams-example-app/playwright.config.ts",
    ];
    for (const config of configs) {
      const source = readFileSync(resolve(repoRoot, config), "utf8");
      expect(source, `${config} must import the policy retry count`).toContain("E2E_CI_RETRIES");
      expect(source, `${config} must not hardcode a CI retry count`).not.toMatch(
        /retr(?:y|ies):\s*(?:process\.env\.CI|ci)\s*\?\s*\d/,
      );
    }
  });

  it("the os preview lane wraps both sub-lanes in plain watchdogs — no lane-level retry", () => {
    const script = cloudflarePreviewApps.os.previewTestCommandArgs.at(-1)!;
    expect(script).toContain(`timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm e2e`);
    expect(script).toContain(`timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm --dir ../.. spec`);
    // Exactly one invocation each: a second occurrence means a retry wrapper came back.
    expect(script.split("pnpm e2e --project node")).toHaveLength(2);
    expect(script.split("pnpm --dir ../.. spec")).toHaveLength(2);
  });

  it("the onboarding smoke gets one retry, like every other test", () => {
    const source = readFileSync(
      resolve(repoRoot, "apps/os/e2e/vitest/onboarding-smoke.ts"),
      "utf8",
    );
    expect(source).toContain("const ATTEMPTS = 2;");
  });

  it("bounds the onboarding smoke and streams its progress before the suites start", () => {
    const script = cloudflarePreviewApps.os.previewTestCommandArgs.at(-1)!;
    expect(script).toContain(
      `timeout ${OS_ONBOARDING_SMOKE_TIMEOUT_SECS} pnpm exec tsx e2e/vitest/onboarding-smoke.ts 2>&1 | tee /tmp/os-preview-smoke.log`,
    );
  });
});

describe("watchdogs the shell can't import stay in sync", () => {
  it("flake-hunt-loop.sh defaults its run watchdog to PREVIEW_RUN_WATCHDOG_SECS", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/preview/flake-hunt-loop.sh"), "utf8");
    expect(source).toContain(
      `RUN_TIMEOUT_SECS="\${RUN_TIMEOUT_SECS:-${PREVIEW_RUN_WATCHDOG_SECS}}"`,
    );
  });
});

describe("Durable Object deployment barriers", () => {
  it("holds the OS and streams lanes on their exact Worker versions", () => {
    expect(cloudflarePreviewApps.os.previewReadyWorkerVersion).toEqual({ stableForMs: 10_000 });
    expect(cloudflarePreviewApps["streams-example-app"].previewReadyWorkerVersion).toEqual({
      stableForMs: 10_000,
    });
  });

  it("makes the streams playground health route identify its deployed Worker version", () => {
    const generatedConfig = readFileSync(
      resolve(repoRoot, "apps/streams-example-app/scripts/generate-wrangler-config.ts"),
      "utf8",
    );
    const worker = readFileSync(
      resolve(repoRoot, "apps/streams-example-app/src/worker.ts"),
      "utf8",
    );

    expect(generatedConfig).toContain('version_metadata: { binding: "CF_VERSION_METADATA" }');
    expect(worker).toContain('const workerVersionHeader = "x-iterate-worker-version"');
    expect(worker).toContain("workerEnv.CF_VERSION_METADATA?.id");
  });
});

describe("retry telemetry parsers", () => {
  it("reads the vitest RetryTelemetryReporter file", async () => {
    const file = join(tmpdir(), `e2e-policy-test-vitest-${process.pid}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        retried: [
          {
            fullName: "sandbox > executes",
            moduleId: "/repo/apps/os/e2e/vitest/sandbox.test.ts",
            retryCount: 1,
            passedAfterRetry: true,
            state: "passed",
            durationMs: 5200,
          },
        ],
      }),
    );
    await expect(previewInternals.readVitestRetryTelemetry(file)).resolves.toEqual([
      { lane: "vitest", name: "sandbox > executes", retryCount: 1, passedAfterRetry: true },
    ]);
    rmSync(file);
  });

  it("reads Playwright's JSON report, including nested suites", async () => {
    const file = join(tmpdir(), `e2e-policy-test-pw-${process.pid}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        suites: [
          {
            title: "repl.spec.ts",
            suites: [
              {
                title: "REPL",
                specs: [
                  {
                    title: "runs a script",
                    tests: [
                      {
                        status: "flaky",
                        results: [
                          { retry: 0, status: "failed" },
                          { retry: 1, status: "passed" },
                        ],
                      },
                    ],
                  },
                  {
                    title: "never retried",
                    tests: [{ status: "expected", results: [{ retry: 0, status: "passed" }] }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    await expect(previewInternals.readPlaywrightRetryTelemetry(file)).resolves.toEqual([
      { lane: "specs", name: "runs a script", retryCount: 1, passedAfterRetry: true },
    ]);
    rmSync(file);
  });

  it("renders a compact summary line", () => {
    expect(
      previewInternals.renderPreviewRetrySummary({
        retried: [
          { lane: "vitest", name: "a", retryCount: 1, passedAfterRetry: true },
          { lane: "specs", name: "b", retryCount: 1, passedAfterRetry: false },
        ],
      }),
    ).toBe("2 retried: a (vitest x1) · b (specs x1, still failed)");
    expect(previewInternals.renderPreviewRetrySummary({ retried: [] })).toBeNull();
  });
});
