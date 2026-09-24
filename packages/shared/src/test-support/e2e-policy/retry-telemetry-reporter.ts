import { relative } from "node:path";
import { appendFlakeRecord, unknownFlakeRecordFromTelemetry } from "../flake-record.ts";
import {
  ciTelemetrySourceFromEnvironment,
  normalizeTestTelemetryError,
  testTelemetryArtifactId,
  testTelemetryContextFromEnvironment,
  writeTestTelemetryArtifact,
  writeTestTelemetryFailureSentinel,
  type TestTelemetryArtifact,
  type TestTelemetryContext,
  type ModuleTelemetryRecord,
  type TestTelemetryRecord,
} from "../ci-telemetry.ts";

interface ReportedTestCase {
  id?: string;
  fullName: string;
  name?: string;
  location?: { line: number; column: number };
  options?: {
    fails?: boolean;
    mode?: "run" | "only" | "skip" | "todo";
    timeout?: number;
  };
  tags?: readonly string[];
  diagnostic():
    | {
        retryCount: number;
        flaky: boolean;
        duration: number;
        startTime?: number;
        repeatCount?: number;
        slow?: boolean;
        heap?: number;
      }
    | undefined;
  result(): { state: string; errors?: readonly unknown[] };
  annotations?(): ReadonlyArray<{ type: string; message: string }>;
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
  diagnostic?(): {
    environmentSetupDuration: number;
    prepareDuration: number;
    collectDuration: number;
    setupDuration: number;
    duration: number;
    importDurations: Record<string, { selfTime: number; totalTime?: number }>;
  };
}

type ReportedHookContext = {
  name: "beforeEach" | "afterEach" | "beforeAll" | "afterAll";
  entity: object;
};

type HookDurations = { beforeEach: number; afterEach: number };
type ReporterDefaults = { testKind?: "unit" | "integration" | "e2e"; lane?: string };

/**
 * Vitest's built-in JSON reporter omits retry counts and the timing split we
 * need to diagnose slow e2e. This reporter therefore records every test,
 * test hooks, and module startup/import time. A named file
 * lets preview render its retry summary immediately; CI's artifact directory
 * retains the same record for the always-running finalizer.
 */
export class RetryTelemetryReporter {
  private readonly runStartedAtMs = Date.now();
  private readonly artifactId: string;
  private readonly ci: TestTelemetryArtifact["ci"];
  private readonly context: TestTelemetryContext;
  private readonly defaults: ReporterDefaults;
  private readonly hookStarts = new WeakMap<object, Partial<Record<string, number>>>();
  private readonly hookDurations = new WeakMap<object, HookDurations>();
  private readonly moduleTimes = new WeakMap<
    object,
    { queuedAtMs?: number; collectedAtMs?: number; startedAtMs?: number; finishedAtMs?: number }
  >();
  private readonly workspace: string;

  constructor(defaults: ReporterDefaults = {}) {
    this.defaults = defaults;
    this.workspace =
      process.env.TEST_TELEMETRY_WORKSPACE ?? process.env.npm_package_name ?? process.cwd();
    this.context = testTelemetryContextFromEnvironment("vitest", {
      testKind: this.defaults.testKind ?? "unit",
      lane: this.defaults.lane ?? "unit",
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

  onTestModuleQueued(testModule: ReportedTestModule): void {
    this.moduleTimes.set(testModule, { queuedAtMs: Date.now() });
  }

  onTestModuleCollected(testModule: ReportedTestModule): void {
    this.moduleTime(testModule).collectedAtMs = Date.now();
  }

  onTestModuleStart(testModule: ReportedTestModule): void {
    this.moduleTime(testModule).startedAtMs = Date.now();
  }

  onTestModuleEnd(testModule: ReportedTestModule): void {
    this.moduleTime(testModule).finishedAtMs = Date.now();
  }

  onHookStart(hook: ReportedHookContext): void {
    if (hook.name !== "beforeEach" && hook.name !== "afterEach") return;
    const starts = this.hookStarts.get(hook.entity) ?? {};
    starts[hook.name] = performance.now();
    this.hookStarts.set(hook.entity, starts);
  }

  onHookEnd(hook: ReportedHookContext): void {
    if (hook.name !== "beforeEach" && hook.name !== "afterEach") return;
    const startedAt = this.hookStarts.get(hook.entity)?.[hook.name];
    if (startedAt === undefined) return;
    const durations = this.hookDurations.get(hook.entity) ?? { beforeEach: 0, afterEach: 0 };
    durations[hook.name] += performance.now() - startedAt;
    this.hookDurations.set(hook.entity, durations);
  }

  async onTestRunEnd(
    testModules: ReadonlyArray<ReportedTestModule>,
    unhandledErrors: readonly unknown[] = [],
    reason?: "passed" | "interrupted" | "failed",
  ): Promise<void> {
    try {
      const tests: TestTelemetryRecord[] = [];
      const modules: ModuleTelemetryRecord[] = [];
      for (const testModule of testModules) {
        const moduleDiagnostic = testModule.diagnostic?.();
        const moduleTimes = this.moduleTimes.get(testModule);
        if (moduleDiagnostic) {
          modules.push({
            moduleId: testModule.moduleId,
            environmentSetupDurationMs: Math.round(moduleDiagnostic.environmentSetupDuration),
            prepareDurationMs: Math.round(moduleDiagnostic.prepareDuration),
            collectDurationMs: Math.round(moduleDiagnostic.collectDuration),
            setupDurationMs: Math.round(moduleDiagnostic.setupDuration),
            testAndHookDurationMs: Math.round(moduleDiagnostic.duration),
            importDurationMs: Math.round(
              Object.values(moduleDiagnostic.importDurations).reduce(
                (total, duration) => total + duration.selfTime,
                0,
              ),
            ),
            imports: Object.entries(moduleDiagnostic.importDurations).map(
              ([moduleId, duration]) => ({
                moduleId,
                selfDurationMs: Math.round(duration.selfTime),
                ...(duration.totalTime === undefined
                  ? {}
                  : { totalDurationMs: Math.round(duration.totalTime) }),
              }),
            ),
            ...optionalIsoTime("queuedAt", moduleTimes?.queuedAtMs),
            ...optionalIsoTime("collectedAt", moduleTimes?.collectedAtMs),
            ...optionalIsoTime("startedAt", moduleTimes?.startedAtMs),
            ...optionalIsoTime("finishedAt", moduleTimes?.finishedAtMs),
            ...(moduleTimes?.queuedAtMs === undefined || moduleTimes.startedAtMs === undefined
              ? {}
              : { queueDurationMs: Math.max(0, moduleTimes.startedAtMs - moduleTimes.queuedAtMs) }),
            ...(moduleTimes?.startedAtMs === undefined || moduleTimes.finishedAtMs === undefined
              ? {}
              : {
                  executionWallDurationMs: Math.max(
                    0,
                    moduleTimes.finishedAtMs - moduleTimes.startedAtMs,
                  ),
                }),
          });
        }
        for (const test of testModule.children.allTests()) {
          const diagnostic = test.diagnostic();
          const result = test.result();
          const annotations = test.annotations?.() ?? [];
          const hooks = this.hookDurations.get(test) ?? { beforeEach: 0, afterEach: 0 };
          const durationMs = Math.round(diagnostic?.duration ?? 0);
          const errors = (result.errors ?? []).map((error) =>
            normalizeTestTelemetryError(error, "Unknown test-attempt error"),
          );
          const firstFailure = compactRetryFailure(errors[0]);
          tests.push({
            fullName: test.fullName,
            leafName: test.name,
            moduleId: testModule.moduleId,
            ...(test.location && {
              testLine: test.location.line,
              testColumn: test.location.column,
            }),
            ...(test.id && { runnerTestId: test.id }),
            ...(test.options && {
              expectedState:
                test.options.mode === "skip" || test.options.mode === "todo"
                  ? test.options.mode
                  : test.options.fails
                    ? "failed"
                    : "passed",
            }),
            ...(test.options?.timeout === undefined
              ? {}
              : { configuredTimeoutMs: test.options.timeout }),
            tags: [...(test.tags ?? [])],
            annotations: annotations.map(({ type, message }) => ({
              type,
              ...(message && { description: message }),
            })),
            ...(diagnostic?.repeatCount === undefined
              ? {}
              : { repeatCount: diagnostic.repeatCount }),
            ...(diagnostic?.slow === undefined ? {} : { slow: diagnostic.slow }),
            ...(diagnostic?.heap === undefined ? {} : { heapBytes: diagnostic.heap }),
            retryCount: diagnostic?.retryCount ?? 0,
            passedAfterRetry: diagnostic?.flaky ?? false,
            state: result.state,
            durationMs,
            attemptDetail: "aggregate-only",
            ...(diagnostic?.startTime === undefined
              ? {}
              : {
                  startedAt: new Date(diagnostic.startTime).toISOString(),
                  startedAtSource: "runner",
                }),
            ...(diagnostic?.startTime === undefined || moduleTimes?.startedAtMs === undefined
              ? {}
              : {
                  scheduleDelayMs: Math.max(
                    0,
                    Math.round(diagnostic.startTime - moduleTimes.startedAtMs),
                  ),
                }),
            beforeEachDurationMs: Math.round(hooks.beforeEach),
            afterEachDurationMs: Math.round(hooks.afterEach),
            bodyDurationMs: Math.max(
              0,
              Math.round(durationMs - hooks.beforeEach - hooks.afterEach),
            ),
            attempts: [],
            phases: [],
            errors,
            ...(firstFailure && { firstFailure }),
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
        artifactSchemaVersion: 1,
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
        },
        lanes: [
          {
            context: this.context,
            status,
            durationMs: Math.max(0, finishedAtMs - this.runStartedAtMs),
            testCount: tests.length,
            retryCount: tests.reduce((total, test) => total + test.retryCount, 0),
            collectionErrors: runErrors.map((error) => error.message),
          },
        ],
        tests,
        modules,
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
    } catch (error) {
      console.error("[retry-telemetry] failed to record test telemetry:", error);
      // Artifact mode is an explicit CI observability contract. A green run
      // must not silently omit the file consumed by the finalizer.
      if (process.env.TEST_TELEMETRY_ARTIFACT_DIR || process.env.TEST_TELEMETRY_ARTIFACT_FILE)
        throw error;
    }
  }

  private moduleTime(testModule: object) {
    const existing = this.moduleTimes.get(testModule);
    if (existing) return existing;
    const created: {
      queuedAtMs?: number;
      collectedAtMs?: number;
      startedAtMs?: number;
      finishedAtMs?: number;
    } = {};
    this.moduleTimes.set(testModule, created);
    return created;
  }
}

export default RetryTelemetryReporter;

function optionalIsoTime<Key extends string>(key: Key, value: number | undefined) {
  return value === undefined
    ? {}
    : ({ [key]: new Date(value).toISOString() } as Record<Key, string>);
}

/** Keep retry evidence useful in one-line logs, annotations, and PR tables. */
export function compactRetryFailure(error: unknown): string | undefined {
  let value: unknown = error;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    value = record.message ?? record.stack ?? record.name;
  }
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return undefined;
  return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact;
}
