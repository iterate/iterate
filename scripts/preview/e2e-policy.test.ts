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
  OS_TUI_LANE_TIMEOUT_SECS,
  PREVIEW_RUN_WATCHDOG_SECS,
  SPEC_ACTION_TIMEOUT_MS,
  SPEC_EXPECT_TIMEOUT_MS,
  SPEC_TEST_TIMEOUT_MS,
  TUI_TEST_TIMEOUT_MS,
} from "@iterate-com/shared/test-support/e2e-policy";
import { cloudflarePreviewApps, previewInternals } from "./preview.ts";

// Guards the e2e retry/timeout policy (docs/testing.md#retries-and-timeouts):
// the budget ladder stays ordered, files that cannot import the constants
// (shell) stay in sync, and no second retry layer sneaks back in.

const repoRoot = resolve(import.meta.dirname, "../..");

describe("budget ladder", () => {
  it("stays strictly ordered from one assertion through the whole preview run", () => {
    const ladder = [
      SPEC_ACTION_TIMEOUT_MS,
      SPEC_EXPECT_TIMEOUT_MS,
      TUI_TEST_TIMEOUT_MS,
      SPEC_TEST_TIMEOUT_MS,
      E2E_TEST_TIMEOUT_MS,
      OS_TUI_LANE_TIMEOUT_SECS * 1000,
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
      "apps/os/e2e/tui-test/tui-test.config.ts",
      "apps/os/e2e/vitest.config.ts",
      "apps/auth/e2e/vitest.config.ts",
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

  it("every retry-enabled Vitest preview lane reports absorbed retries", () => {
    const configs = [
      "apps/os/e2e/vitest.config.ts",
      "apps/auth/e2e/vitest.config.ts",
      "apps/semaphore/e2e/vitest.config.ts",
      "apps/streams-example-app/vitest.config.ts",
    ];
    for (const config of configs) {
      expect(readFileSync(resolve(repoRoot, config), "utf8"), config).toContain(
        "RetryTelemetryReporter",
      );
    }

    for (const app of ["auth", "semaphore"] as const) {
      const runtime = cloudflarePreviewApps[app];
      expect(runtime.previewTestCommandArgs.join(" "), app).toContain("E2E_RETRY_TELEMETRY_FILE");
      expect(runtime.collectRetryTelemetry, app).toBeTypeOf("function");
    }
  });

  it("the os preview lane wraps all four sub-lanes in plain watchdogs — no lane retry", () => {
    const script = cloudflarePreviewApps.os.previewTestCommandArgs.at(-1)!;
    expect(script).toContain(
      `timeout ${OS_TUI_LANE_TIMEOUT_SECS} pnpm exec tsx e2e/tui-test/run.ts`,
    );
    expect(script).toContain(
      `timeout ${OS_ONBOARDING_SMOKE_TIMEOUT_SECS} pnpm exec tsx e2e/vitest/onboarding-smoke.ts`,
    );
    expect(script).toContain(`timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm e2e`);
    expect(script).toContain(`timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm --dir ../.. spec`);
    // Exactly one invocation each: a second occurrence means a retry wrapper came back.
    expect(script.split("pnpm exec tsx e2e/tui-test/run.ts")).toHaveLength(2);
    expect(script.split("pnpm exec tsx e2e/vitest/onboarding-smoke.ts")).toHaveLength(2);
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

  it("bounds the onboarding smoke in a joined parallel lane", () => {
    const script = cloudflarePreviewApps.os.previewTestCommandArgs.at(-1)!;
    expect(script).toContain(
      `run_logged_lane smoke /tmp/os-preview-smoke.log timeout ${OS_ONBOARDING_SMOKE_TIMEOUT_SECS} pnpm exec tsx e2e/vitest/onboarding-smoke.ts & SMOKE_PID=$!`,
    );
    expect(script).toContain('SMOKE_OK=0; wait "$SMOKE_PID" || SMOKE_OK=$?');
    expect(script).toContain("cat /tmp/os-preview-smoke.log");
    expect(script).toContain('[ "$SMOKE_OK" -eq 0 ]');
  });
});

describe("watchdogs the shell can't import stay in sync", () => {
  it("flake-hunt-loop.sh defaults its run watchdog to PREVIEW_RUN_WATCHDOG_SECS", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/preview/flake-hunt-loop.sh"), "utf8");
    expect(source).toContain(
      `RUN_TIMEOUT_SECS="\${RUN_TIMEOUT_SECS:-${PREVIEW_RUN_WATCHDOG_SECS}}"`,
    );
  });

  it("makes marathon acceptance immutable, retry-clean, full-fleet, and sub-three-minute", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/preview/flake-hunt-loop.sh"), "utf8");
    expect(source).toContain('MAX_CLEAN_RUN_SECS="${MAX_CLEAN_RUN_SECS:-180}"');
    expect(source).toContain('EXPECTED_HEAD_SHA="${EXPECTED_HEAD_SHA:-$(git rev-parse HEAD)}"');
    expect(source).toContain("[preview] test for PR #$PR_NUMBER (head $EXPECTED_SHORT_SHA)");
    expect(source).toContain("run-ledger.tsv");
    expect(source).toContain("\\[retry-telemetry\\]|");
    for (const app of ["os", "semaphore", "auth", "streams-example-app", "dummy-petshop"]) {
      expect(source).toContain(app);
    }
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
