import {
  ciTelemetrySourceFromEnvironment,
  testTelemetryArtifactId,
  testTelemetryContextFromEnvironment,
  writeTestTelemetryArtifact,
  type TestTelemetryError,
  type TestTelemetryPhase,
} from "@iterate-com/shared/test-support/ci-telemetry";

export const PREVIEW_PROJECT_PREWARM_OPERATION_DEADLINE_MS = 70_000;

const producer = "preview-project-prewarm";

/**
 * Record the optimization as a complete, observable, non-gating logical test.
 * The outer preview shell also uses this after its watchdog kills the worker,
 * so a killed prewarm never leaves a pessimistic failure sentinel behind.
 */
export function writePreviewProjectPrewarmTelemetry(
  input: {
    annotations?: Array<{ type: string; description?: string }>;
    error?: TestTelemetryError;
    exitCode?: number;
    moduleId: string;
    phases?: TestTelemetryPhase[];
    runStartedAt: number;
    state: "failed" | "passed" | "timedout";
  },
  environment: NodeJS.ProcessEnv = process.env,
) {
  const finishedAtMs = Date.now();
  const durationMs = finishedAtMs - input.runStartedAt;
  const startedAt = new Date(input.runStartedAt).toISOString();
  const finishedAt = new Date(finishedAtMs).toISOString();
  const workspace =
    environment.TEST_TELEMETRY_WORKSPACE ?? environment.npm_package_name ?? "iterate-root";
  const context = testTelemetryContextFromEnvironment(
    "script",
    {
      testKind: "e2e",
      lane: "project-prewarm",
      workspace,
      app: "os",
    },
    environment,
  );
  const ci = ciTelemetrySourceFromEnvironment(
    environment,
    `local-preview-project-prewarm-${process.pid}-${input.runStartedAt}`,
  );
  const artifactId = testTelemetryArtifactId(producer, process.pid, input.runStartedAt);
  const phases = input.phases ?? [];
  const attempt = {
    attemptIndex: 0,
    state: input.state,
    durationMs,
    startedAt,
    startedAtSource: "reporter-clock" as const,
    ...(input.error ? { error: input.error } : {}),
    phases,
  };
  const outputFile = writeTestTelemetryArtifact(
    {
      artifactSchemaVersion: 1,
      artifactId,
      producer,
      createdAt: finishedAt,
      ci,
      context,
      // This is a startup optimization, not a product test. Preserve its raw
      // state and error on the logical test while keeping the run/lane green.
      run: {
        status: "passed",
        startedAt,
        finishedAt,
        durationMs,
      },
      lanes: [
        {
          context,
          status: "passed",
          durationMs,
          exitCode: input.exitCode ?? 0,
          testCount: 1,
          retryCount: 0,
          collectionErrors: [],
        },
      ],
      tests: [
        {
          fullName: "preview project prewarm > creates one fully-ready project",
          moduleId: input.moduleId,
          expectedState: input.state,
          outcome: "expected",
          configuredTimeoutMs: PREVIEW_PROJECT_PREWARM_OPERATION_DEADLINE_MS,
          tags: [],
          annotations: input.annotations ?? [],
          retryCount: 0,
          passedAfterRetry: false,
          state: input.state,
          durationMs,
          startedAt,
          startedAtSource: "reporter-clock",
          attemptDetail: "complete",
          beforeEachDurationMs: 0,
          afterEachDurationMs: 0,
          bodyDurationMs: durationMs,
          attempts: [attempt],
          phases,
          errors: input.error ? [input.error] : [],
          ...(input.error ? { firstFailure: input.error.message.slice(0, 300) } : {}),
        },
      ],
      modules: [
        {
          moduleId: input.moduleId,
          environmentSetupDurationMs: 0,
          prepareDurationMs: 0,
          collectDurationMs: 0,
          setupDurationMs: 0,
          testAndHookDurationMs: durationMs,
          importDurationMs: 0,
          imports: [],
          startedAt,
          finishedAt,
          executionWallDurationMs: durationMs,
        },
      ],
    },
    environment,
  );
  if (!outputFile) {
    throw new Error("Preview project prewarm requires a telemetry artifact output path.");
  }
  return { durationMs, outputFile };
}
