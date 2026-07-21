import { z } from "zod";

const POSTHOG_HOST = "https://eu.i.posthog.com";
export const PREVIEW_E2E_SCHEMA_VERSION = 2;

export type PreviewE2eError = { message: string; name?: string; stack?: string };
export type PreviewE2ePhase = { name: string; category?: string; durationMs: number };
export type PreviewE2eAttempt = {
  attemptIndex: number;
  state: string;
  durationMs: number;
  startedAt?: string;
  scheduleDelayMs?: number;
  workerIndex?: number;
  parallelIndex?: number;
  error?: PreviewE2eError;
  phases: PreviewE2ePhase[];
};
export type PreviewE2eTestRecord = {
  lane: string;
  name: string;
  moduleId: string;
  project?: string;
  state: string;
  durationMs: number;
  retryCount: number;
  passedAfterRetry: boolean;
  startedAt?: string;
  scheduleDelayMs?: number;
  beforeEachDurationMs?: number;
  afterEachDurationMs?: number;
  bodyDurationMs?: number;
  attempts: PreviewE2eAttempt[];
  phases: PreviewE2ePhase[];
  errors: PreviewE2eError[];
};
export type PreviewE2eModuleRecord = {
  lane: string;
  moduleId: string;
  environmentSetupDurationMs: number;
  prepareDurationMs: number;
  collectDurationMs: number;
  setupDurationMs: number;
  testAndHookDurationMs: number;
  importDurationMs: number;
  queuedAt?: string;
  collectedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  queueDurationMs?: number;
  executionWallDurationMs?: number;
};

type RunContext = {
  environment: NodeJS.ProcessEnv;
  headSha: string;
  operation: "test" | "run";
  pullRequestNumber: number;
  runUrl: string | null;
};

/** Schema-v2 event writer for complete preview e2e timing diagnostics. */
export class PreviewE2ePostHog {
  private readonly apiKey: string | null;
  private readonly common: Record<string, unknown>;
  private readonly distinctId: string;
  private readonly events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  private eventSequence = 0;

  constructor(context: RunContext) {
    const runId =
      context.environment.GITHUB_RUN_ID ??
      `local-${context.pullRequestNumber}-${context.headSha.slice(0, 12)}-${Date.now()}`;
    const runAttempt = context.environment.GITHUB_RUN_ATTEMPT ?? "1";
    this.distinctId = `preview-e2e:${runId}:${runAttempt}:${context.operation}`;
    this.common = {
      schema_version: PREVIEW_E2E_SCHEMA_VERSION,
      repository: context.environment.GITHUB_REPOSITORY ?? "iterate/iterate",
      pull_request_number: context.pullRequestNumber,
      head_sha: context.headSha,
      operation: context.operation,
      workflow_run_id: runId,
      workflow_run_attempt: runAttempt,
      workflow_run_url: context.runUrl,
      runner_name: context.environment.RUNNER_NAME,
      runner_os: context.environment.RUNNER_OS,
      $process_person_profile: false,
    };

    const rawConfig = context.environment.APP_CONFIG_POSTHOG?.trim();
    if (!rawConfig) {
      this.apiKey = null;
      console.log("[preview:posthog] APP_CONFIG_POSTHOG absent; event capture disabled");
      return;
    }
    const config = z.object({ apiKey: z.string().trim().min(1) }).parse(JSON.parse(rawConfig));
    this.apiKey = config.apiKey;
  }

  runStarted() {
    this.capture("preview e2e run started", { status: "running" });
  }

  appFinished(input: {
    app: string;
    slot?: string;
    status: "passed" | "failed";
    durationMs: number;
    exitCode: number | null;
    testCount: number;
    retryCount: number;
    collectionErrors: string[];
  }) {
    this.capture("preview e2e phase finished", {
      scope: "app",
      phase: "test",
      app: input.app,
      preview_slot: input.slot,
      status: input.status,
      duration_ms: input.durationMs,
      exit_code: input.exitCode,
      test_count: input.testCount,
      retry_count: input.retryCount,
      collection_errors: input.collectionErrors,
    });
  }

  testFinished(input: PreviewE2eTestRecord & { app: string; slot?: string }) {
    const common = {
      app: input.app,
      lane: input.lane,
      test_name: input.name,
      test_module: input.moduleId,
      test_project: input.project,
      preview_slot: input.slot,
    };
    this.capture("preview e2e test finished", {
      ...common,
      test_state: input.state,
      duration_ms: input.durationMs,
      final_attempt_duration_ms: input.attempts.at(-1)?.durationMs ?? input.durationMs,
      retry_duration_ms: input.attempts
        .slice(0, -1)
        .reduce((total, attempt) => total + attempt.durationMs, 0),
      retry_count: input.retryCount,
      passed_after_retry: input.passedAfterRetry,
      started_at: input.startedAt,
      schedule_delay_ms: input.scheduleDelayMs,
      before_each_duration_ms: input.beforeEachDurationMs,
      after_each_duration_ms: input.afterEachDurationMs,
      body_duration_ms: input.bodyDurationMs,
      attempt_timing_available: input.attempts.length > 0,
      error_count: input.errors.length,
    });
    for (const attempt of input.attempts) {
      this.capture("preview e2e test attempt finished", {
        ...common,
        attempt_index: attempt.attemptIndex,
        is_retry: attempt.attemptIndex > 0,
        test_state: attempt.state,
        duration_ms: attempt.durationMs,
        started_at: attempt.startedAt,
        worker_index: attempt.workerIndex,
        parallel_index: attempt.parallelIndex,
        error_name: attempt.error?.name,
        error_message: attempt.error ? truncate(attempt.error.message, 2_000) : undefined,
      });
      for (const phase of attempt.phases) this.phaseFinished(common, phase, attempt.attemptIndex);
    }
    for (const phase of input.phases) this.phaseFinished(common, phase);
  }

  moduleFinished(input: PreviewE2eModuleRecord & { app: string; slot?: string }) {
    this.capture("preview e2e module finished", {
      app: input.app,
      lane: input.lane,
      test_module: input.moduleId,
      preview_slot: input.slot,
      environment_setup_duration_ms: input.environmentSetupDurationMs,
      prepare_duration_ms: input.prepareDurationMs,
      collect_duration_ms: input.collectDurationMs,
      setup_duration_ms: input.setupDurationMs,
      test_and_hook_duration_ms: input.testAndHookDurationMs,
      import_duration_ms: input.importDurationMs,
      queued_at: input.queuedAt,
      collected_at: input.collectedAt,
      started_at: input.startedAt,
      finished_at: input.finishedAt,
      queue_duration_ms: input.queueDurationMs,
      execution_wall_duration_ms: input.executionWallDurationMs,
    });
  }

  runFinished(input: {
    status: "passed" | "failed" | "skipped";
    durationMs: number;
    error?: unknown;
  }) {
    const error = input.error ? normalizeError(input.error) : null;
    this.capture("preview e2e run finished", {
      status: input.status,
      duration_ms: input.durationMs,
      error_name: error?.name,
      error_message: error ? truncate(error.message, 2_000) : undefined,
    });
  }

  async shutdown() {
    if (!this.apiKey) return;
    for (let offset = 0; offset < this.events.length; offset += 100) {
      const batch = this.events.slice(offset, offset + 100);
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(`${POSTHOG_HOST}/batch/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ api_key: this.apiKey, batch }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            throw new Error(`PostHog batch returned ${response.status}: ${await response.text()}`);
          }
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      if (lastError) throw new Error("Preview e2e PostHog delivery failed", { cause: lastError });
    }
  }

  private phaseFinished(
    test: Record<string, unknown>,
    phase: PreviewE2ePhase,
    attemptIndex?: number,
  ) {
    this.capture("preview e2e test phase finished", {
      ...test,
      phase_name: phase.name,
      phase_category: phase.category,
      duration_ms: phase.durationMs,
      attempt_index: attemptIndex,
    });
  }

  private capture(event: string, properties: Record<string, unknown>) {
    if (!this.apiKey) return;
    this.eventSequence += 1;
    this.events.push({
      event,
      properties: {
        distinct_id: this.distinctId,
        ...this.common,
        ...properties,
        $insert_id: `${this.distinctId}:${this.eventSequence}`,
      },
    });
  }
}

export function normalizeError(error: unknown): PreviewE2eError {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const candidate = error as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message: typeof candidate.message === "string" ? candidate.message : String(error),
    ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    ...(typeof candidate.stack === "string" ? { stack: candidate.stack } : {}),
  };
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
