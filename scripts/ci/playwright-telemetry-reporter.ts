import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestStep,
} from "@playwright/test/reporter";
import {
  appendFlakeRecord,
  unknownFlakeRecordFromTelemetry,
} from "@iterate-com/shared/test-support/flake-record";
import {
  ciTelemetrySourceFromEnvironment,
  testTelemetryArtifactId,
  testTelemetryContextFromEnvironment,
  writeTestTelemetryArtifact,
  writeTestTelemetryFailureSentinel,
  type TestTelemetryError,
  type TestTelemetryArtifact,
  type TestTelemetryContext,
  type TestTelemetryPhase,
  type TestTelemetryRecord,
} from "@iterate-com/shared/test-support/ci-telemetry";

/**
 * Playwright reporter for the canonical runner-neutral artifact contract.
 * It records all attempts and nested steps, but performs no network I/O.
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
      process.env.TEST_TELEMETRY_WORKSPACE ?? process.env.npm_package_name ?? config.rootDir;
    this.context = testTelemetryContextFromEnvironment("playwright", {
      testKind: "e2e",
      lane: "playwright",
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
    const testCases = this.suite.allTests();
    const tests = testCases.map((test) => toTestRecord(test, result.startTime.getTime()));
    // A plain test that passed only after a retry is an unclassified flake:
    // record it for the test-health dashboard, error sample included, so it
    // can be adopted into createFlake (see shared flake-record.ts). The bare
    // test title keys the record so a later createFlake wrap keeps the row.
    for (const [index, telemetryRecord] of tests.entries()) {
      const unknownFlake = unknownFlakeRecordFromTelemetry({
        ...telemetryRecord,
        leafName: testCases[index]?.title,
      });
      if (unknownFlake) await appendFlakeRecord(unknownFlake);
    }
    const durationMs = nonnegativeDuration(result.duration);
    const finishedAtMs = result.startTime.getTime() + durationMs;
    const status: TestTelemetryArtifact["run"]["status"] = result.status;
    writeTestTelemetryArtifact({
      artifactSchemaVersion: 1,
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
      },
      lanes: [
        {
          context: this.context,
          status,
          durationMs,
          testCount: tests.length,
          retryCount: tests.reduce((total, test) => total + test.retryCount, 0),
          collectionErrors: this.globalErrors.map((error) => error.message),
        },
      ],
      tests,
      modules: [],
    });
  }

  printsToStdio() {
    return false;
  }
}

function toTestRecord(test: TestCase, runStartedAtMs: number): TestTelemetryRecord {
  const attempts = test.results.map((result, index) => {
    const error = firstResultError(result.errors, result.error);
    const previous = test.results[index - 1];
    const scheduleReferenceMs = previous
      ? previous.startTime.getTime() + nonnegativeDuration(previous.duration)
      : runStartedAtMs;
    return {
      attemptIndex: result.retry,
      state: result.status,
      durationMs: nonnegativeDuration(result.duration),
      startedAt: result.startTime.toISOString(),
      startedAtSource: "runner" as const,
      scheduleDelayMs: Math.max(0, result.startTime.getTime() - scheduleReferenceMs),
      workerIndex: result.workerIndex,
      parallelIndex: result.parallelIndex,
      attachmentCount: result.attachments?.length ?? 0,
      stdoutBytes: outputSize(result.stdout ?? []),
      stderrBytes: outputSize(result.stderr ?? []),
      ...(error && { error }),
      phases: flattenSteps(result.steps),
    };
  });
  const finalAttempt = attempts.at(-1);
  const errors = test.results.flatMap((result) =>
    result.errors.length > 0
      ? result.errors.map(normalizePlaywrightError)
      : result.error
        ? [normalizePlaywrightError(result.error)]
        : [],
  );
  const retryCount = Math.max(0, ...attempts.map((attempt) => attempt.attemptIndex));
  const firstStartedAt = attempts[0]?.startedAt;
  const testProject = test.parent.project()?.name;
  return {
    fullName: test.titlePath().filter(Boolean).join(" › "),
    moduleId: test.location.file,
    testLine: test.location.line,
    testColumn: test.location.column,
    runnerTestId: test.id,
    expectedState: test.expectedStatus,
    configuredTimeoutMs: test.timeout,
    repeatIndex: test.repeatEachIndex,
    tags: test.tags ?? [],
    annotations: (test.annotations ?? []).map(({ type, description }) => ({
      type,
      ...(description && { description }),
    })),
    ...(testProject && { context: { testProject } }),
    retryCount,
    passedAfterRetry: test.outcome() === "flaky",
    state: finalAttempt?.state ?? "skipped",
    outcome: test.outcome(),
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
    attemptDetail: "complete",
    ...(firstStartedAt && { startedAt: firstStartedAt }),
    ...(firstStartedAt && { startedAtSource: "runner" as const }),
    ...(attempts[0] && { scheduleDelayMs: attempts[0].scheduleDelayMs }),
    attempts,
    phases: [],
    errors,
    ...(errors[0] && { firstFailure: errors[0].message.slice(0, 300) }),
  };
}

function flattenSteps(steps: readonly TestStep[]): TestTelemetryPhase[] {
  return steps.flatMap((step) => {
    const unfinished = step.duration < 0;
    return [
      {
        name: step.titlePath().filter(Boolean).join(" › "),
        category: step.category,
        durationMs: nonnegativeDuration(step.duration),
        ...(step.startTime && { startedAt: step.startTime.toISOString() }),
        attachmentCount: step.attachments?.length ?? 0,
        ...(step.location && {
          sourceFile: step.location.file,
          sourceLine: step.location.line,
          sourceColumn: step.location.column,
        }),
        ...(step.error
          ? { error: normalizePlaywrightError(step.error) }
          : unfinished
            ? {
                error: {
                  name: "PlaywrightIncompleteStepError",
                  message: "Playwright step did not finish before runner shutdown",
                },
              }
            : {}),
      },
      ...flattenSteps(step.steps),
    ];
  });
}

/** Playwright uses -1 for work that was still active when a run was interrupted. */
function nonnegativeDuration(durationMs: number) {
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
}

function outputSize(chunks: Array<string | Buffer>) {
  return chunks.reduce(
    (total, chunk) => total + (typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length),
    0,
  );
}

function firstResultError(errors: readonly TestError[], error: TestError | undefined) {
  const first = errors[0] ?? error;
  return first ? normalizePlaywrightError(first) : undefined;
}

function normalizePlaywrightError(error: TestError): TestTelemetryError {
  return {
    message: error.message ?? error.value ?? "Unknown Playwright error",
    ...(error.stack && { stack: error.stack }),
  };
}
