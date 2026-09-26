import { relative } from "node:path";
import { appendFlakeRecord, unknownFlakeRecordFromTelemetry } from "../flake-record.ts";
import {
  TEST_TELEMETRY_ARTIFACT_SCHEMA_VERSION,
  ciTelemetrySourceFromEnvironment,
  normalizeTestTelemetryError,
  testTelemetryArtifactId,
  testTelemetryContextFromEnvironment,
  writeTestTelemetryArtifact,
  writeTestTelemetryFailureSentinel,
  type TestTelemetryArtifact,
  type TestTelemetryContext,
  type TestTelemetryRecord,
} from "../ci-telemetry.ts";
import { E2E_ROW_BUDGET_MS, E2E_ROW_WARN_MS } from "./budgets.ts";

interface ReportedTestCase {
  id?: string;
  fullName: string;
  name?: string;
  location?: { line: number; column: number };
  options?: { fails?: boolean; mode?: "run" | "only" | "skip" | "todo" };
  tags?: readonly string[];
  project?: { name: string };
  diagnostic():
    | { retryCount: number; flaky: boolean; duration: number; startTime?: number }
    | undefined;
  result(): { state: string; errors?: readonly unknown[] };
}

// Structural types keep this reporter compatible across workspace Vitest versions.
interface TracedTestCase extends ReportedTestCase {
  id: string;
  module: { moduleId: string };
  project: { name: string };
}

interface ReportedTestModule {
  moduleId: string;
  errors?(): unknown[];
  children: {
    allTests(): Iterable<ReportedTestCase>;
    allSuites?(): Iterable<{ errors(): unknown[] }>;
  };
}

/**
 * Vitest's built-in JSON reporter omits retry counts, so this reporter records every test with its
 * retries and first failure into CI's telemetry directory for the always-running finalizer
 * (docs/ci-test-telemetry.md), a flake record for each plain test that failed, and, with
 * CI_TRACE_ENABLED=1, each test's `@@ci-trace` lifecycle lines for the CI trace (docs/ci-traces.md).
 */
export class RetryTelemetryReporter {
  private readonly runStartedAtMs = Date.now();
  private readonly artifactId: string;
  private readonly ci: TestTelemetryArtifact["ci"];
  private readonly context: TestTelemetryContext;
  private readonly workspace: string;

  constructor(defaults: { testKind?: "unit" | "integration" | "e2e"; suite?: string } = {}) {
    this.workspace =
      process.env.TEST_TELEMETRY_WORKSPACE || process.env.npm_package_name || process.cwd();
    this.context = testTelemetryContextFromEnvironment("vitest", {
      testKind: defaults.testKind || "unit",
      suite: defaults.suite || "unit",
      workspace: this.workspace,
    });
    this.artifactId = testTelemetryArtifactId(
      "vitest",
      this.workspace,
      process.pid,
      this.runStartedAtMs,
    );
    this.ci = ciTelemetrySourceFromEnvironment(
      process.env,
      `local-vitest-${process.pid}-${this.runStartedAtMs}`,
    );
  }

  onTestRunStart(): void {
    writeTestTelemetryFailureSentinel({
      artifactId: this.artifactId,
      producer: "vitest-retry-telemetry-reporter",
      startedAt: new Date(this.runStartedAtMs).toISOString(),
      ci: this.ci,
      context: this.context,
    });
  }

  onTestCaseReady(test: TracedTestCase): void {
    if (process.env.CI_TRACE_ENABLED !== "1") return;
    const diagnostic = test.diagnostic();
    // Static skips have no execution timing. Fast tests may already be finished
    // when this callback arrives: always use runner timestamps, not receipt time.
    if (!diagnostic?.startTime) return;
    console.log(
      `\n@@ci-trace ${JSON.stringify({
        kind: "test-start",
        id: `${this.artifactId}/${test.id}`,
        framework: "vitest",
        time: diagnostic.startTime,
        title: test.fullName,
        file: relative(process.env.GITHUB_WORKSPACE || process.cwd(), test.module.moduleId),
        line: test.location?.line || 0,
        project: this.workspace + (test.project.name ? ` / ${test.project.name}` : ""),
        retry: 0,
      })}`,
    );
  }

  onTestCaseResult(test: TracedTestCase): void {
    if (process.env.CI_TRACE_ENABLED !== "1") return;
    const diagnostic = test.diagnostic();
    if (!diagnostic?.startTime) return;
    // Vitest reports once after all retries and already normalizes test.fails.
    // Do not publish error payloads or pretend these are per-attempt timings.
    console.log(
      `\n@@ci-trace ${JSON.stringify({
        kind: "test-end",
        id: `${this.artifactId}/${test.id}`,
        time: diagnostic.startTime + diagnostic.duration,
        status: test.result().state,
        expectedStatus: "passed",
        retryCount: diagnostic.retryCount,
      })}`,
    );
  }

  async onTestRunEnd(
    testModules: ReadonlyArray<ReportedTestModule>,
    unhandledErrors: readonly unknown[] = [],
    reason?: "passed" | "interrupted" | "failed",
  ): Promise<void> {
    try {
      const tests: TestTelemetryRecord[] = [];
      const overBudget: { name: string; durationMs: number }[] = [];
      for (const testModule of testModules) {
        for (const test of testModule.children.allTests()) {
          const diagnostic = test.diagnostic();
          const result = test.result();
          const durationMs = Math.round(diagnostic?.duration ?? 0);
          const errors = (result.errors || []).map((error) =>
            normalizeTestTelemetryError(error, "Unknown test-attempt error"),
          );
          if (
            test.project?.name === "e2e" &&
            durationMs > E2E_ROW_WARN_MS &&
            !test.tags?.includes("slow")
          )
            overBudget.push({ name: test.name || test.fullName, durationMs });
          tests.push({
            fullName: test.fullName,
            leafName: test.name,
            moduleId: testModule.moduleId,
            ...(test.options && {
              expectedState:
                test.options.mode === "skip" || test.options.mode === "todo"
                  ? test.options.mode
                  : test.options.fails
                    ? "failed"
                    : "passed",
            }),
            tags: [...(test.tags || [])],
            retryCount: diagnostic?.retryCount ?? 0,
            passedAfterRetry: diagnostic?.flaky ?? false,
            state: result.state,
            durationMs,
            ...(diagnostic?.startTime !== undefined && {
              startedAt: new Date(diagnostic.startTime).toISOString(),
            }),
            errors,
            firstFailure: compactRetryFailure(errors[0]),
          });
        }
      }
      // A plain test that failed, whether a retry then passed or not, is an
      // unclassified flake: record it for the test-health dashboard, error
      // sample included, so it can be adopted into createFlake (see
      // flake-record.ts). The bare test name keys the record so a later
      // createFlake wrap keeps the same row.
      for (const telemetryRecord of tests) {
        const unknownFlake = unknownFlakeRecordFromTelemetry(telemetryRecord);
        if (unknownFlake) await appendFlakeRecord(unknownFlake);
      }
      const retried = tests.filter((test) => test.retryCount > 0);
      // Vitest keeps import and suite-hook errors on the module/suite, not
      // in unhandledErrors or the individual test results. Without these a
      // failed file beside a passing file looks like complete clean coverage.
      const runErrors = [
        ...unhandledErrors,
        ...testModules.flatMap((module) => [
          ...(module.errors?.() || []),
          ...Array.from(module.children.allSuites?.() || []).flatMap((suite) => suite.errors()),
        ]),
      ].map((error) => normalizeTestTelemetryError(error, "Unknown Vitest run error"));

      const finishedAtMs = Date.now();
      const status =
        reason === "interrupted"
          ? "interrupted"
          : reason === "failed" ||
              runErrors.length > 0 ||
              tests.some((test) => test.state === "failed")
            ? "failed"
            : "passed";
      writeTestTelemetryArtifact({
        artifactSchemaVersion: TEST_TELEMETRY_ARTIFACT_SCHEMA_VERSION,
        artifactId: this.artifactId,
        producer: "vitest-retry-telemetry-reporter",
        createdAt: new Date(finishedAtMs).toISOString(),
        ci: this.ci,
        context: this.context,
        run: {
          status,
          startedAt: new Date(this.runStartedAtMs).toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: Math.max(0, finishedAtMs - this.runStartedAtMs),
          ...(runErrors[0] && { error: runErrors[0] }),
          collectionErrors: runErrors.map((error) => error.message),
        },
        tests,
      });
      if (retried.length > 0) {
        const details = retried
          .map(
            (record) =>
              `${record.fullName} (x${record.retryCount}${record.passedAfterRetry ? "" : ", still failed"})${record.firstFailure ? ` — ${record.firstFailure}` : ""}`,
          )
          .join("; ");
        console.log(`[retry-telemetry] ${retried.length} test(s) needed retries: ${details}`);
      }
      if (overBudget.length > 0) {
        // The run lasts as long as its slowest row (docs/testing.md#the-row-budget).
        console.log(
          `[row-budget] ${overBudget.length} e2e row(s) ran longer than ${E2E_ROW_WARN_MS / 1000} s; a row that runs on every PR finishes within ${E2E_ROW_BUDGET_MS / 1000} s at its p95:`,
        );
        for (const row of overBudget.toSorted((a, b) => b.durationMs - a.durationMs))
          console.log(`[row-budget] ${(row.durationMs / 1000).toFixed(1)} s ${row.name}`);
      }
    } catch (error) {
      console.error("[retry-telemetry] failed to record test telemetry:", error);
      // Artifact mode is an explicit CI observability contract. A green run
      // must not silently omit the file consumed by the finalizer.
      if (process.env.TEST_TELEMETRY_ARTIFACT_DIR) throw error;
    }
  }
}

export default RetryTelemetryReporter;

/** Keep retry evidence useful in one-line logs, annotations, and PR tables. */
export function compactRetryFailure(error: unknown): string | undefined {
  let value: unknown = error;
  if (typeof error === "object" && error) {
    const record = error as Record<string, unknown>;
    value = record.message ?? record.stack ?? record.name;
  }
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return undefined;
  return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact;
}
