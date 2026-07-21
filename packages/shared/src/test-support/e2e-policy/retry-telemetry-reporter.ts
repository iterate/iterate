import { writeFileSync } from "node:fs";
import { relative } from "node:path";

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

  async onTestRunEnd(testModules: ReadonlyArray<ReportedTestModule>): Promise<void> {
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
      if (process.env.TEST_TELEMETRY_ENABLED === "1") {
        await captureVitestTelemetry({ modules, tests });
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
      // CI must never go green after silently losing the telemetry used to
      // explain its own failures and latency. Local runs remain best-effort.
      if (process.env.TEST_TELEMETRY_ENABLED === "1") throw error;
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

async function captureVitestTelemetry(input: {
  tests: TestTelemetryRecord[];
  modules: ModuleTelemetryRecord[];
}) {
  const rawConfig = process.env.APP_CONFIG_POSTHOG?.trim();
  if (!rawConfig) throw new Error("APP_CONFIG_POSTHOG is required when TEST_TELEMETRY_ENABLED=1");
  const parsed = JSON.parse(rawConfig) as { apiKey?: unknown; host?: unknown };
  if (typeof parsed.apiKey !== "string" || parsed.apiKey.length === 0) {
    throw new Error("APP_CONFIG_POSTHOG.apiKey is required when TEST_TELEMETRY_ENABLED=1");
  }
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  const workspace =
    process.env.TEST_TELEMETRY_WORKSPACE ?? process.env.npm_package_name ?? process.cwd();
  const normalizeModuleId = (moduleId: string) => {
    const repositoryRoot = process.env.GITHUB_WORKSPACE;
    if (!repositoryRoot || !moduleId.startsWith(repositoryRoot)) return moduleId;
    return relative(repositoryRoot, moduleId);
  };
  const distinctId = `ci-test:${runId}:${runAttempt}:${workspace}:${process.pid}`;
  const common = {
    schema_version: 2,
    framework: "vitest",
    test_kind: process.env.TEST_TELEMETRY_KIND ?? "unit",
    lane: process.env.TEST_TELEMETRY_LANE ?? "unit",
    workspace,
    repository: process.env.GITHUB_REPOSITORY ?? "iterate/iterate",
    head_sha: process.env.GITHUB_SHA,
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
    workflow_name: process.env.GITHUB_WORKFLOW,
    workflow_run_id: runId,
    workflow_run_attempt: runAttempt,
    pull_request_number: pullRequestNumber(process.env.GITHUB_REF),
    workflow_run_url:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
    runner_provider: process.env.DEPOT_JOB_URL ? "depot" : "github-actions",
    execution_context: process.env.GITHUB_RUN_ID ? "ci" : "local",
    depot_job_url: process.env.DEPOT_JOB_URL,
    $process_person_profile: false,
  };
  let sequence = 0;
  const event = (name: string, properties: Record<string, unknown>) => ({
    event: name,
    properties: {
      distinct_id: distinctId,
      ...common,
      ...properties,
      $insert_id: `${distinctId}:${++sequence}`,
    },
  });
  const batch = [
    ...input.tests.map((test) =>
      event("ci test finished", {
        test_name: test.fullName,
        test_module: normalizeModuleId(test.moduleId),
        test_state: test.state,
        duration_ms: test.durationMs,
        retry_count: test.retryCount,
        passed_after_retry: test.passedAfterRetry,
        schedule_delay_ms: test.scheduleDelayMs,
        before_each_duration_ms: test.beforeEachDurationMs,
        after_each_duration_ms: test.afterEachDurationMs,
        body_duration_ms: test.bodyDurationMs,
        error_count: test.errors.length,
        error_name: test.errors[0]?.name,
        error_message: test.errors[0]?.message.slice(0, 2_000),
      }),
    ),
    ...input.tests.flatMap((test) =>
      test.phases.map((phase) =>
        event("ci test phase finished", {
          test_name: test.fullName,
          test_module: normalizeModuleId(test.moduleId),
          phase_name: phase.name,
          phase_category: phase.category,
          duration_ms: phase.durationMs,
        }),
      ),
    ),
    ...input.modules.map((module) =>
      event("ci test module finished", {
        test_module: normalizeModuleId(module.moduleId),
        environment_setup_duration_ms: module.environmentSetupDurationMs,
        prepare_duration_ms: module.prepareDurationMs,
        collect_duration_ms: module.collectDurationMs,
        setup_duration_ms: module.setupDurationMs,
        test_and_hook_duration_ms: module.testAndHookDurationMs,
        import_duration_ms: module.importDurationMs,
        queue_duration_ms: module.queueDurationMs,
        execution_wall_duration_ms: module.executionWallDurationMs,
      }),
    ),
    event("ci test run finished", {
      status: input.tests.some((test) => test.state === "failed") ? "failed" : "passed",
      test_count: input.tests.length,
      failed_test_count: input.tests.filter((test) => test.state === "failed").length,
      retried_test_count: input.tests.filter((test) => test.retryCount > 0).length,
      module_count: input.modules.length,
    }),
  ];
  const host = typeof parsed.host === "string" ? parsed.host : "https://eu.i.posthog.com";
  for (let offset = 0; offset < batch.length; offset += 100) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${host.replace(/\/$/, "")}/batch/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: parsed.apiKey,
            batch: batch.slice(offset, offset + 100),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new Error(
            `PostHog test telemetry returned ${response.status}: ${await response.text()}`,
          );
        }
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (lastError) throw new Error("PostHog test telemetry delivery failed", { cause: lastError });
  }
}

function pullRequestNumber(githubRef: string | undefined): number | undefined {
  const match = githubRef?.match(/^refs\/pull\/(\d+)\/(?:merge|head)$/u);
  return match ? Number(match[1]) : undefined;
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
