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
  PREVIEW_RUN_PROOF_BUDGET_SECS,
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

  it("every Vitest and Playwright e2e config writes the canonical telemetry artifact", () => {
    const vitestConfigs = [
      "apps/auth/e2e/vitest.config.ts",
      "apps/dummy-petshop/e2e/vitest.config.ts",
      "apps/mobile/vitest.e2e.config.ts",
      "apps/os/e2e/vitest.config.ts",
      "apps/semaphore/e2e/vitest.config.ts",
      "apps/streams-example-app/vitest.config.ts",
    ];
    for (const config of vitestConfigs) {
      const source = readFileSync(resolve(repoRoot, config), "utf8");
      expect(source, `${config} must install the canonical Vitest reporter`).toContain(
        "RetryTelemetryReporter",
      );
      expect(source, `${config} must identify itself as e2e`).toContain('testKind: "e2e"');
    }

    for (const config of [
      "playwright.config.ts",
      "apps/streams-example-app/playwright.config.ts",
      "apps/tanstack/playwright.config.ts",
    ]) {
      expect(
        readFileSync(resolve(repoRoot, config), "utf8"),
        `${config} must install the canonical Playwright reporter`,
      ).toContain("playwright-telemetry-reporter.ts");
    }
  });

  it("the TUI lane stays an explicit no-op skip, not a half-revived runner", () => {
    // The lane is deliberately disabled (TUI has known bugs and no users;
    // tui-test 0.0.4 has framework defects). Reviving it means rebuilding the
    // one-retry wrapper — this guard fails the moment someone puts test
    // execution back without that.
    const runner = readFileSync(resolve(repoRoot, "apps/os/e2e/tui-test/run.ts"), "utf8");
    expect(runner).toContain("SKIPPED");
    expect(runner).not.toContain("tui-test-bin");
    expect(runner).not.toContain("spawn");
  });

  it("the os preview lane wraps all four sub-lanes in plain watchdogs — no lane retry", () => {
    const script = cloudflarePreviewApps.os.previewTestCommandArgs.at(-1)!;
    expect(script).toContain(
      `timeout ${OS_ONBOARDING_SMOKE_TIMEOUT_SECS} pnpm exec tsx e2e/vitest/onboarding-smoke.ts`,
    );
    expect(script).toContain(
      `timeout ${OS_TUI_LANE_TIMEOUT_SECS} pnpm exec tsx e2e/tui-test/run.ts`,
    );
    expect(script).toContain(`timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm e2e`);
    expect(script).toContain(`timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm --dir ../.. spec`);
    // Exactly one invocation each: a second occurrence means a retry wrapper came back.
    expect(script.split("pnpm exec tsx e2e/tui-test/run.ts")).toHaveLength(2);
    expect(script.split("pnpm e2e --project node")).toHaveLength(2);
    expect(script.split("pnpm --dir ../.. spec")).toHaveLength(2);
    expect(script.split("pnpm exec tsx e2e/vitest/onboarding-smoke.ts")).toHaveLength(2);
  });

  it("the onboarding smoke gets one retry without a blind deployment-age delay", () => {
    const source = readFileSync(
      resolve(repoRoot, "apps/os/e2e/vitest/onboarding-smoke.ts"),
      "utf8",
    );
    expect(source).toContain("const ATTEMPTS = 2;");
    expect(source).not.toContain("preview-rollout");
    expect(source).not.toContain("waitForPreviewRolloutBeforeProjectCreation");
  });

  it("bounds the onboarding smoke as a joined background lane", () => {
    const script = cloudflarePreviewApps.os.previewTestCommandArgs.at(-1)!;
    expect(script).toContain(
      `run_logged_lane smoke /tmp/os-preview-smoke.log env TEST_TELEMETRY_LANE=onboarding-smoke TEST_TELEMETRY_WORKSPACE=iterate-root TEST_TELEMETRY_ARTIFACT_FILE=/tmp/os-preview-onboarding-smoke.json timeout ${OS_ONBOARDING_SMOKE_TIMEOUT_SECS} pnpm exec tsx e2e/vitest/onboarding-smoke.ts & SMOKE_PID=$!`,
    );
    expect(script).toContain('wait "$SMOKE_PID"');
  });
});

describe("watchdogs the shell can't import stay in sync", () => {
  it("keeps the marathon's watchdog on the policy constant and its counting honest", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/preview/flake-hunt-loop.sh"), "utf8");
    expect(source).toContain(
      `RUN_TIMEOUT_SECS="\${RUN_TIMEOUT_SECS:-${PREVIEW_RUN_WATCHDOG_SECS}}"`,
    );
    expect(source).toContain(
      `MAX_RUN_DURATION_SECS="\${MAX_RUN_DURATION_SECS:-${PREVIEW_RUN_PROOF_BUDGET_SECS}}"`,
    );
    const retryGate = 'if [ "$retries" -gt 0 ]; then';
    const passRecord = 'record_result "$run" PASS';
    expect(source).toContain(retryGate);
    expect(source).toContain('record_result "$run" RETRIED');
    expect(source).toContain("streak rejected");
    expect(source.indexOf(retryGate)).toBeLessThan(source.indexOf(passRecord));
    // The harness only orchestrates the production preview workflow. It never
    // carries a second deploy/test implementation or a nested Depot runner.
    expect(source.match(/depot ci dispatch/g)).toHaveLength(1);
    expect(source).toContain("--workflow cloudflare-previews.yml");
    expect(source).toContain('--input "pull-request-number=$PR_NUMBER"');
    expect(source).toContain('depot ci logs "$attempt_id"');
    expect(source).toContain('depot ci run show "$run_id"');
    expect(source).toContain(
      "transport=$(grep -cF '[itx-initial-connection-retry] ' \"$log\" || true)",
    );
    expect(source).not.toContain("pnpm preview deploy");
    expect(source).not.toContain("pnpm preview test");
    expect(source).not.toContain("warmup-runs");
  });

  it("keeps the retry annotation parseable by the marathon's ledger", () => {
    // flake-hunt-loop.sh cannot import renderPreviewRetrySummary. Depot's
    // finite log export converts the raw workflow command to ##[notice] or
    // ##[warning], so pin both the exported form and the raw fallback. This
    // fixture comes from a real canonical Depot preview log; changing either
    // side must not silently zero the ledger's retry column again.
    const shell = readFileSync(resolve(repoRoot, "scripts/preview/flake-hunt-loop.sh"), "utf8");
    expect(shell).toContain("s/.*##\\[(notice|warning)\\][^:]+: ([0-9]+) retried:.*/\\2/p");
    expect(shell).toContain("s/.*title=Preview e2e retries::.*: ([0-9]+) retried:.*/\\1/p");

    const rendered = previewInternals.renderPreviewRetrySummary({
      retried: [
        { lane: "vitest", name: "a", retryCount: 1, passedAfterRetry: true },
        { lane: "specs", name: "b", retryCount: 1, passedAfterRetry: false },
      ],
    });
    const raw = `::notice title=Preview e2e retries::os: ${rendered}. The retry passed and does not fail this run.`;
    expect(raw.match(/.*title=Preview e2e retries::.*: (\d+) retried:.*/)?.[1]).toBe("2");
    const depotExport = `2026-07-22T07:24:00.175Z ##[warning]os: ${rendered}. The retry passed and does not fail this run.`;
    expect(depotExport.match(/.*##\[(?:notice|warning)\][^:]+: (\d+) retried:.*/)?.[1]).toBe("2");
  });

  it("keeps Playwright admin dials inside the observable pre-session retry boundary", () => {
    const helper = readFileSync(resolve(repoRoot, "specs/test-support/forged-session.ts"), "utf8");
    expect(helper).toContain("connectItxReady(");
    expect(helper).toContain("retryInitialConnection:");
    expect(helper).toContain('test.step("itx: initial connection retry"');
    expect(helper).toContain('type: "itx-initial-connection-retry"');
    expect(helper).toContain("[itx-initial-connection-retry] ");
    expect(helper).not.toContain("connectItx({");
  });
});

describe("preview retry-summary parsers", () => {
  it("counts Vitest results and retains retry evidence", async () => {
    const file = join(tmpdir(), `e2e-policy-test-vitest-${process.pid}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        artifactSchemaVersion: 1,
        artifactId: "vitest-test-fixture",
        producer: "test",
        createdAt: "2026-07-21T12:00:06Z",
        ci: {
          repository: "iterate/iterate",
          workflowRunId: "123",
          workflowRunAttempt: "1",
          runnerProvider: "local",
          executionContext: "local",
        },
        context: { framework: "vitest", testKind: "e2e", lane: "vitest" },
        run: {
          status: "passed",
          startedAt: "2026-07-21T12:00:00Z",
          finishedAt: "2026-07-21T12:00:06Z",
          durationMs: 6000,
        },
        lanes: [],
        tests: [
          {
            fullName: "sandbox > executes",
            moduleId: "/repo/apps/os/e2e/vitest/sandbox.test.ts",
            tags: [],
            annotations: [],
            retryCount: 1,
            passedAfterRetry: true,
            state: "passed",
            durationMs: 5200,
            attemptDetail: "aggregate-only",
            beforeEachDurationMs: 100,
            afterEachDurationMs: 50,
            bodyDurationMs: 5050,
            phases: [{ name: "sandbox boot", category: "runtime", durationMs: 4000 }],
            errors: [{ message: "Network connection lost" }],
            attempts: [],
            firstFailure: "Network connection lost",
          },
        ],
        modules: [
          {
            moduleId: "/repo/apps/os/e2e/vitest/sandbox.test.ts",
            environmentSetupDurationMs: 10,
            prepareDurationMs: 20,
            collectDurationMs: 30,
            setupDurationMs: 40,
            testAndHookDurationMs: 5200,
            importDurationMs: 25,
            imports: [],
          },
        ],
      }),
    );
    await expect(
      previewInternals.readCanonicalTestTelemetry(file, "vitest"),
    ).resolves.toMatchObject({
      testCount: 1,
      retried: [expect.objectContaining({ name: "sandbox > executes", retryCount: 1 })],
      collectionErrors: [],
    });
    rmSync(file);
  });

  it("counts nested Playwright results and retains retry evidence", async () => {
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
                          {
                            retry: 0,
                            status: "failed",
                            duration: 7000,
                            startTime: "2026-07-21T10:00:00.000Z",
                            steps: [
                              {
                                title: "evict transport",
                                category: "test.step",
                                duration: 5000,
                              },
                            ],
                            error: { message: "Network connection\n lost" },
                          },
                          { retry: 1, status: "passed", duration: 3000 },
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
    await expect(
      previewInternals.readPlaywrightTestTelemetry(file, "specs"),
    ).resolves.toMatchObject({
      testCount: 2,
      retried: [
        expect.objectContaining({
          name: "repl.spec.ts › REPL › runs a script",
          retryCount: 1,
          passedAfterRetry: true,
          firstFailure: "Network connection lost",
        }),
      ],
      collectionErrors: [],
    });
    rmSync(file);
  });

  it("renders a compact summary line", () => {
    expect(
      previewInternals.renderPreviewRetrySummary({
        retried: [
          {
            lane: "vitest",
            name: "a",
            retryCount: 1,
            passedAfterRetry: true,
            firstFailure: "Network connection lost",
          },
          { lane: "specs", name: "b", retryCount: 1, passedAfterRetry: false },
        ],
      }),
    ).toBe("2 retried: a (vitest x1) — Network connection lost · b (specs x1, still failed)");
    expect(previewInternals.renderPreviewRetrySummary({ retried: [] })).toBeNull();
  });

  it("keeps a command green when a test passes on retry", () => {
    expect(
      previewInternals.previewTestFailureMessage({
        result: { exitCode: 0 },
        retrySummary: {
          retried: [
            { lane: "vitest", name: "creates a project", retryCount: 1, passedAfterRetry: true },
          ],
        },
      }),
    ).toBeNull();

    expect(
      previewInternals.previewTestFailureMessage({
        result: { exitCode: 0 },
        retrySummary: { retried: [] },
      }),
    ).toBeNull();
  });
});
