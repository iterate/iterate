import { writeFileSync } from "node:fs";

/** A JSON-safe diagnostic retained from a test attempt. */
export interface TestTelemetryError {
  message: string;
  name?: string;
  stack?: string;
}

/** A named operation recorded by a test through a Vitest `e2e-phase` annotation. */
export interface TestTelemetryPhase {
  name: string;
  durationMs: number;
  category?: string;
}

/** One final Vitest test result, including timing that explains its wall time. */
export interface TestTelemetryRecord {
  fullName: string;
  moduleId: string;
  retryCount: number;
  passedAfterRetry: boolean;
  state: string;
  durationMs: number;
  startedAtMs?: number;
  scheduleDelayMs?: number;
  beforeEachDurationMs: number;
  afterEachDurationMs: number;
  bodyDurationMs: number;
  phases: TestTelemetryPhase[];
  errors: TestTelemetryError[];
  /** Backward-compatible compact first failure for retry summaries. */
  firstFailure?: string;
}

/** Per-file Vitest startup/import/test timing. */
export interface ModuleTelemetryRecord {
  moduleId: string;
  environmentSetupDurationMs: number;
  prepareDurationMs: number;
  collectDurationMs: number;
  setupDurationMs: number;
  testAndHookDurationMs: number;
  importDurationMs: number;
  queuedAtMs?: number;
  collectedAtMs?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  queueDurationMs?: number;
  executionWallDurationMs?: number;
}

/** A test that needed at least one retry. */
export type RetriedTestRecord = TestTelemetryRecord;

/** Shape written to `$E2E_RETRY_TELEMETRY_FILE` (the historical env name). */
export interface RetryTelemetryFile {
  /** Every final result. Green, non-retried tests are required for latency analysis. */
  tests: TestTelemetryRecord[];
  modules: ModuleTelemetryRecord[];
  /** Convenience index used by the existing PR retry summary. */
  retried: RetriedTestRecord[];
}

interface ReportedTestCase {
  fullName: string;
  diagnostic():
    | { retryCount: number; flaky: boolean; duration: number; startTime?: number }
    | undefined;
  result(): { state: string; errors?: readonly unknown[] };
  annotations?(): ReadonlyArray<{ type: string; message: string }>;
}

interface ReportedTestModule {
  moduleId: string;
  children: { allTests(): Iterable<ReportedTestCase> };
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

/**
 * Vitest's built-in JSON reporter omits retry counts and the timing split we
 * need to diagnose slow e2e. This reporter therefore records every test,
 * test hooks, explicit phases, and module startup/import time. The old env
 * variable name is retained because every preview lane already supplies it.
 */
export class RetryTelemetryReporter {
  private readonly hookStarts = new WeakMap<object, Partial<Record<string, number>>>();
  private readonly hookDurations = new WeakMap<object, HookDurations>();
  private readonly moduleTimes = new WeakMap<
    object,
    { queuedAtMs?: number; collectedAtMs?: number; startedAtMs?: number; finishedAtMs?: number }
  >();

  onTestModuleQueued(testModule: ReportedTestModule): void {
    this.moduleTimes.set(testModule, { queuedAtMs: Date.now() });
  }

  onTestModuleCollected(testModule: ReportedTestModule): void {
    this.moduleTimes.get(testModule)!.collectedAtMs = Date.now();
  }

  onTestModuleStart(testModule: ReportedTestModule): void {
    this.moduleTimes.get(testModule)!.startedAtMs = Date.now();
  }

  onTestModuleEnd(testModule: ReportedTestModule): void {
    this.moduleTimes.get(testModule)!.finishedAtMs = Date.now();
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

  onTestRunEnd(testModules: ReadonlyArray<ReportedTestModule>): void {
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
            ...roundedOptionalTime("queuedAtMs", moduleTimes?.queuedAtMs),
            ...roundedOptionalTime("collectedAtMs", moduleTimes?.collectedAtMs),
            ...roundedOptionalTime("startedAtMs", moduleTimes?.startedAtMs),
            ...roundedOptionalTime("finishedAtMs", moduleTimes?.finishedAtMs),
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
          const hooks = this.hookDurations.get(test) ?? { beforeEach: 0, afterEach: 0 };
          const durationMs = Math.round(diagnostic?.duration ?? 0);
          const errors = (result.errors ?? []).map(toTestTelemetryError);
          const firstFailure = compactRetryFailure(errors[0]);
          tests.push({
            fullName: test.fullName,
            moduleId: testModule.moduleId,
            retryCount: diagnostic?.retryCount ?? 0,
            passedAfterRetry: diagnostic?.flaky ?? false,
            state: result.state,
            durationMs,
            ...(diagnostic?.startTime === undefined
              ? {}
              : { startedAtMs: Math.round(diagnostic.startTime) }),
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
            phases: parseTelemetryPhases(test.annotations?.() ?? []),
            errors,
            ...(firstFailure ? { firstFailure } : {}),
          });
        }
      }
      const retried = tests.filter((test) => test.retryCount > 0);

      const outputFile = process.env.E2E_RETRY_TELEMETRY_FILE;
      if (outputFile) {
        const payload: RetryTelemetryFile = { tests, modules, retried };
        writeFileSync(outputFile, JSON.stringify(payload, null, 2));
      }
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
    }
  }
}

function roundedOptionalTime<Key extends string>(key: Key, value: number | undefined) {
  return value === undefined ? {} : ({ [key]: Math.round(value) } as Record<Key, number>);
}

function parseTelemetryPhases(
  annotations: ReadonlyArray<{ type: string; message: string }>,
): TestTelemetryPhase[] {
  return annotations.flatMap((annotation) => {
    if (annotation.type !== "e2e-phase") return [];
    try {
      const parsed = JSON.parse(annotation.message) as Record<string, unknown>;
      if (typeof parsed.name !== "string" || typeof parsed.durationMs !== "number") return [];
      return [
        {
          name: parsed.name,
          durationMs: Math.round(parsed.durationMs),
          ...(typeof parsed.category === "string" ? { category: parsed.category } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
}

function toTestTelemetryError(error: unknown): TestTelemetryError {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const candidate = error as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message:
      typeof candidate.message === "string" ? candidate.message : "Unknown test-attempt error",
    ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    ...(typeof candidate.stack === "string" ? { stack: candidate.stack } : {}),
  };
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
