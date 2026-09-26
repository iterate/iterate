import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
} from "@playwright/test/reporter";
import {
  appendFlakeRecord,
  unknownFlakeRecordFromTelemetry,
} from "@iterate-com/shared/test-support/flake-record";
import {
  TEST_TELEMETRY_ARTIFACT_SCHEMA_VERSION,
  ciTelemetrySourceFromEnvironment,
  testTelemetryArtifactId,
  testTelemetryContextFromEnvironment,
  writeTestTelemetryArtifact,
  writeTestTelemetryFailureSentinel,
  type TestTelemetryError,
  type TestTelemetryArtifact,
  type TestTelemetryContext,
  type TestTelemetryRecord,
} from "@iterate-com/shared/test-support/ci-telemetry";

/**
 * The browser specs' telemetry (docs/ci-test-telemetry.md): every test after its attempts, and a
 * flake record for each plain test that failed. It performs no network I/O; the CI trace's
 * `@@ci-trace` lines are ./tracing/tracing.ts's.
 */
export default class PlaywrightTelemetryReporter implements Reporter {
  private artifactId: string | null = null;
  private ci: TestTelemetryArtifact["ci"] | null = null;
  private config: FullConfig | null = null;
  private context: TestTelemetryContext | null = null;
  private suite: Suite | null = null;
  private readonly globalErrors: TestTelemetryError[] = [];

  onBegin(config: FullConfig, suite: Suite) {
    this.config = config;
    this.suite = suite;
    const startedAtMs = Date.now();
    const workspace =
      process.env.TEST_TELEMETRY_WORKSPACE || process.env.npm_package_name || config.rootDir;
    this.context = testTelemetryContextFromEnvironment("playwright", {
      testKind: "e2e",
      suite: "playwright",
      workspace,
    });
    this.artifactId = testTelemetryArtifactId("playwright", workspace, process.pid, startedAtMs);
    this.ci = ciTelemetrySourceFromEnvironment(process.env, `local-${this.artifactId}`);
    writeTestTelemetryFailureSentinel({
      artifactId: this.artifactId,
      producer: "playwright-telemetry-reporter",
      startedAt: new Date(startedAtMs).toISOString(),
      ci: this.ci,
      context: this.context,
    });
  }

  onError(error: TestError) {
    this.globalErrors.push(normalizePlaywrightError(error));
  }

  async onEnd(result: FullResult) {
    if (!this.config || !this.suite || !this.artifactId || !this.ci || !this.context)
      throw new Error("Playwright telemetry ended before it began");
    const tests = this.suite.allTests().map(toTestRecord);
    // A plain test that failed, whether a retry then passed or not, is an
    // unclassified flake: record it for the test-health dashboard, error
    // sample included, so it can be adopted into createFlake (see shared
    // flake-record.ts). The bare test title keys the record so a later
    // createFlake wrap keeps the row.
    for (const telemetryRecord of tests) {
      const unknownFlake = unknownFlakeRecordFromTelemetry(telemetryRecord);
      if (unknownFlake) await appendFlakeRecord(unknownFlake);
    }
    const durationMs = nonnegativeDuration(result.duration);
    const finishedAtMs = result.startTime.getTime() + durationMs;
    const status: TestTelemetryArtifact["run"]["status"] = result.status;
    writeTestTelemetryArtifact({
      artifactSchemaVersion: TEST_TELEMETRY_ARTIFACT_SCHEMA_VERSION,
      artifactId: this.artifactId,
      producer: "playwright-telemetry-reporter",
      createdAt: new Date(finishedAtMs).toISOString(),
      ci: this.ci,
      context: this.context,
      run: {
        status,
        startedAt: result.startTime.toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs,
        ...(this.globalErrors[0] && { error: this.globalErrors[0] }),
        collectionErrors: this.globalErrors.map((error) => error.message),
      },
      tests,
    });
  }

  printsToStdio() {
    return false;
  }
}

function toTestRecord(test: TestCase): TestTelemetryRecord {
  const errors = test.results.flatMap((result) =>
    (result.errors.length > 0 ? result.errors : result.error ? [result.error] : []).map(
      normalizePlaywrightError,
    ),
  );
  return {
    fullName: test.titlePath().filter(Boolean).join(" › "),
    leafName: test.title,
    moduleId: test.location.file,
    expectedState: test.expectedStatus,
    tags: test.tags || [],
    retryCount: Math.max(0, ...test.results.map((result) => result.retry)),
    passedAfterRetry: test.outcome() === "flaky",
    state: test.results.at(-1)?.status ?? "skipped",
    outcome: test.outcome(),
    durationMs: test.results.reduce(
      (total, result) => total + nonnegativeDuration(result.duration),
      0,
    ),
    ...(test.results[0] && { startedAt: test.results[0].startTime.toISOString() }),
    errors,
    ...(errors[0] && { firstFailure: errors[0].message.slice(0, 300) }),
  };
}

/** Playwright uses -1 for work that was still active when a run was interrupted. */
function nonnegativeDuration(durationMs: number) {
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
}

function normalizePlaywrightError(error: TestError): TestTelemetryError {
  return {
    message: error.message || error.value || "Unknown Playwright error",
    stack: error.stack,
  };
}
