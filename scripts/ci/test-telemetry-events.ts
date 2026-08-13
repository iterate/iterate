import { isAbsolute, relative, sep as pathSeparator } from "node:path";
import {
  type TestTelemetryArtifact,
  type TestTelemetryArtifactSource,
  type TestTelemetryContext,
} from "@iterate-com/shared/test-support/ci-telemetry";
import { systemEvent, type PostHogEvent } from "./posthog-events.ts";
import {
  countTestTelemetryArtifactSources,
  testTelemetryArtifactIncomplete,
  testTelemetryArtifactSourceLabel,
  type MissingArtifactSource,
} from "./test-telemetry-completeness.ts";

const MAX_DETAIL_EVENTS_PER_PARENT = 100;

export function testTelemetryEvents(artifact: TestTelemetryArtifact): PostHogEvent[] {
  const telemetryIncomplete = testTelemetryArtifactIncomplete(artifact);
  const distinctId = `ci-test:${artifact.ci.workflowRunId}:${artifact.ci.workflowRunAttempt}:${artifact.artifactId}`;
  const common = {
    artifact_schema_version: artifact.artifactSchemaVersion,
    artifact_id: artifact.artifactId,
    artifact_producer: artifact.producer,
    test_run_id: artifact.artifactId,
    ...ciProperties(artifact),
  };
  const event = (
    name: string,
    identity: string,
    context: TestTelemetryContext,
    properties: Record<string, unknown>,
    timestamp: string,
  ) =>
    systemEvent(
      name,
      `${distinctId}:${identity}`,
      distinctId,
      { ...common, ...contextProperties(context), ...properties },
      timestamp,
    );

  const events: PostHogEvent[] = [
    event(
      "ci test run started",
      "run-started",
      artifact.context,
      { status: "running" },
      artifact.run.startedAt,
    ),
    ...deploymentTelemetryEvents(artifact),
  ];
  for (const [laneIndex, lane] of artifact.lanes.entries()) {
    events.push(
      event(
        "ci test lane finished",
        `lane:${laneIndex}`,
        lane.context,
        {
          status: lane.status,
          duration_ms: lane.durationMs,
          exit_code: lane.exitCode,
          test_count: lane.testCount,
          retry_count: lane.retryCount,
          telemetry_incomplete: telemetryIncomplete,
          collection_error_count: lane.collectionErrors.length,
          collection_errors: lane.collectionErrors,
        },
        artifact.run.finishedAt,
      ),
    );
  }
  for (const [testIndex, test] of artifact.tests.entries()) {
    const context = mergeContext(artifact.context, test.context);
    const normalizedModuleId = normalizeModuleId(test.moduleId, artifact);
    const testIdentity = [
      context.framework,
      normalizedModuleId,
      test.fullName,
      context.testProject ?? "",
    ].join(":");
    const finalAttempt = test.attempts.at(-1);
    const selectedAttemptPhases = test.attempts.map((attempt) =>
      selectDetailedRecords(attempt.phases),
    );
    const selectedTestPhases = selectDetailedRecords(test.phases);
    const phaseCount =
      test.phases.length +
      test.attempts.reduce((total, attempt) => total + attempt.phases.length, 0);
    const phaseEventCount =
      selectedTestPhases.length +
      selectedAttemptPhases.reduce((total, phases) => total + phases.length, 0);
    events.push(
      event(
        "ci test finished",
        `test:${testIndex}`,
        context,
        {
          test_id: testIdentity,
          test_execution_id: `${artifact.artifactId}:test:${testIndex}`,
          test_name: test.fullName,
          test_module: normalizedModuleId,
          test_number: test.testNumber,
          test_line: test.testLine,
          test_column: test.testColumn,
          runner_test_id: test.runnerTestId,
          expected_state: test.expectedState,
          configured_timeout_ms: test.configuredTimeoutMs,
          repeat_index: test.repeatIndex,
          repeat_count: test.repeatCount,
          slow: test.slow,
          heap_bytes: test.heapBytes,
          tags: test.tags,
          annotation_types: test.annotations.map(({ type }) => type),
          test_state: test.state,
          test_outcome: test.outcome,
          failed: testFailed(test),
          duration_ms: test.durationMs,
          final_attempt_duration_ms: finalAttempt?.durationMs,
          retry_duration_ms:
            test.attempts.length > 0
              ? test.attempts.slice(0, -1).reduce((total, attempt) => total + attempt.durationMs, 0)
              : undefined,
          retry_count: test.retryCount,
          passed_after_retry: test.passedAfterRetry,
          schedule_delay_ms: test.scheduleDelayMs,
          before_each_duration_ms: test.beforeEachDurationMs,
          after_each_duration_ms: test.afterEachDurationMs,
          body_duration_ms: test.bodyDurationMs,
          attempt_detail: test.attemptDetail,
          attempt_timing_available: test.attempts.length > 0,
          phase_count: phaseCount,
          phase_event_count: phaseEventCount,
          phase_events_omitted: phaseCount - phaseEventCount,
          started_at_source: test.startedAtSource,
          error_count: test.errors.length,
          error_name: test.errors[0]?.name,
          error_message: test.errors[0]?.message.slice(0, 2_000),
        },
        testFinishedAt(test, artifact.run.finishedAt),
      ),
    );
    for (const [attemptArrayIndex, attempt] of test.attempts.entries()) {
      const selectedPhases = selectedAttemptPhases[attemptArrayIndex]!;
      events.push(
        event(
          "ci test attempt finished",
          `test:${testIndex}:attempt:${attempt.attemptIndex}`,
          context,
          {
            test_id: testIdentity,
            test_execution_id: `${artifact.artifactId}:test:${testIndex}`,
            test_name: test.fullName,
            test_module: normalizeModuleId(test.moduleId, artifact),
            attempt_index: attempt.attemptIndex,
            is_retry: attempt.attemptIndex > 0,
            test_state: attempt.state,
            duration_ms: attempt.durationMs,
            schedule_delay_ms: attempt.scheduleDelayMs,
            worker_index: attempt.workerIndex,
            parallel_index: attempt.parallelIndex,
            started_at_source: attempt.startedAtSource,
            attachment_count: attempt.attachmentCount,
            stdout_bytes: attempt.stdoutBytes,
            stderr_bytes: attempt.stderrBytes,
            phase_count: attempt.phases.length,
            phase_event_count: selectedPhases.length,
            phase_events_omitted: attempt.phases.length - selectedPhases.length,
            error_name: attempt.error?.name,
            error_message: attempt.error?.message.slice(0, 2_000),
          },
          finishedAt(attempt.startedAt, attempt.durationMs, artifact.run.finishedAt),
        ),
      );
      for (const { index: phaseIndex, value: phase } of selectedPhases) {
        events.push(
          phaseEvent({
            artifact,
            attemptIndex: attempt.attemptIndex,
            context,
            event,
            fallbackTimestamp: artifact.run.finishedAt,
            identity: `test:${testIndex}:attempt:${attempt.attemptIndex}:phase:${phaseIndex}`,
            phase,
            test,
            testIdentity,
            testIndex,
          }),
        );
      }
    }
    for (const { index: phaseIndex, value: phase } of selectedTestPhases) {
      events.push(
        phaseEvent({
          artifact,
          context,
          event,
          fallbackTimestamp: artifact.run.finishedAt,
          identity: `test:${testIndex}:phase:${phaseIndex}`,
          phase,
          test,
          testIdentity,
          testIndex,
        }),
      );
    }
  }
  for (const [moduleIndex, module] of artifact.modules.entries()) {
    const context = mergeContext(artifact.context, module.context);
    const selectedImports = selectDetailedRecords(
      module.imports.map((imported) => ({ ...imported, durationMs: imported.selfDurationMs })),
    );
    events.push(
      event(
        "ci test module finished",
        `module:${moduleIndex}`,
        context,
        {
          test_module: normalizeModuleId(module.moduleId, artifact),
          environment_setup_duration_ms: module.environmentSetupDurationMs,
          prepare_duration_ms: module.prepareDurationMs,
          collect_duration_ms: module.collectDurationMs,
          setup_duration_ms: module.setupDurationMs,
          test_and_hook_duration_ms: module.testAndHookDurationMs,
          import_duration_ms: module.importDurationMs,
          queued_at: module.queuedAt,
          collected_at: module.collectedAt,
          started_at: module.startedAt,
          finished_at: module.finishedAt,
          queue_duration_ms: module.queueDurationMs,
          execution_wall_duration_ms: module.executionWallDurationMs,
          import_count: module.imports.length,
          import_event_count: selectedImports.length,
          import_events_omitted: module.imports.length - selectedImports.length,
        },
        module.finishedAt ?? artifact.run.finishedAt,
      ),
    );
    for (const { index: importIndex, value: imported } of selectedImports) {
      events.push(
        event(
          "ci test import finished",
          `module:${moduleIndex}:import:${importIndex}`,
          context,
          {
            test_module: normalizeModuleId(module.moduleId, artifact),
            imported_module: normalizeModuleId(imported.moduleId, artifact),
            self_duration_ms: imported.selfDurationMs,
            total_duration_ms: imported.totalDurationMs,
          },
          module.finishedAt ?? artifact.run.finishedAt,
        ),
      );
    }
  }
  events.push(
    event(
      "ci test run finished",
      "run-finished",
      artifact.context,
      {
        status: artifact.run.status,
        duration_ms: artifact.run.durationMs,
        telemetry_incomplete: telemetryIncomplete,
        collection_error_count: artifact.lanes.reduce(
          (total, lane) => total + lane.collectionErrors.length,
          0,
        ),
        test_count: artifact.tests.length,
        failed_test_count: artifact.tests.filter(testFailed).length,
        skipped_test_count: artifact.tests.filter((test) =>
          ["skipped", "todo"].includes(test.state),
        ).length,
        retried_test_count: artifact.tests.filter((test) => test.retryCount > 0).length,
        module_count: artifact.modules.length,
        lane_count: artifact.lanes.length,
        error_name: artifact.run.error?.name,
        error_message: artifact.run.error?.message.slice(0, 2_000),
      },
      artifact.run.finishedAt,
    ),
  );
  return events;
}

function deploymentTelemetryEvents(artifact: TestTelemetryArtifact): PostHogEvent[] {
  const deployment = artifact.deployment;
  if (!deployment) return [];

  const distinctId = `ci-deploy:${artifact.ci.workflowRunId}:${artifact.ci.workflowRunAttempt}:${artifact.artifactId}`;
  const common = {
    artifact_schema_version: artifact.artifactSchemaVersion,
    artifact_id: artifact.artifactId,
    artifact_producer: artifact.producer,
    deployment_kind: deployment.deploymentKind,
    ...ciProperties(artifact),
  };
  const event = (
    name: string,
    identity: string,
    properties: Record<string, unknown>,
    timestamp: string,
  ) =>
    systemEvent(
      name,
      `${distinctId}:${identity}`,
      distinctId,
      { ...common, ...properties },
      timestamp,
    );

  const events: PostHogEvent[] = [
    event(
      "ci deploy run started",
      "run-started",
      {
        lane: "preview",
        preview_slot: deployment.previewSlot,
        status: "running",
      },
      deployment.startedAt,
    ),
  ];
  for (const [laneIndex, lane] of deployment.lanes.entries()) {
    const laneCommon = {
      scope: "app",
      app: lane.app,
      preview_slot: lane.previewSlot ?? deployment.previewSlot,
      status: lane.status,
      worker_name: lane.workerName,
      worker_version: lane.workerVersion,
    };
    events.push(
      event(
        "ci deploy lane finished",
        `lane:${laneIndex}`,
        {
          ...laneCommon,
          duration_ms: lane.durationMs,
          config_duration_ms: lane.configDurationMs,
          command_duration_ms: lane.commandDurationMs,
          readiness_duration_ms: lane.readinessDurationMs,
          reuse_proof_duration_ms: lane.reuseProofDurationMs,
        },
        lane.finishedAt ?? deployment.finishedAt,
      ),
    );
    for (const [phaseName, durationMs] of [
      ["config", lane.configDurationMs],
      ["command", lane.commandDurationMs],
      ["readiness", lane.readinessDurationMs],
      ["reuse proof", lane.reuseProofDurationMs],
    ] as const) {
      if (!Number.isFinite(durationMs)) continue;
      events.push(
        event(
          "ci deploy phase finished",
          `lane:${laneIndex}:phase:${phaseName}`,
          { ...laneCommon, phase_name: phaseName, duration_ms: durationMs },
          lane.finishedAt ?? deployment.finishedAt,
        ),
      );
    }
  }
  events.push(
    event(
      "ci deploy run finished",
      "run-finished",
      {
        lane: "preview",
        preview_slot: deployment.previewSlot,
        status: deployment.status,
        duration_ms: deployment.durationMs,
        error_name: deployment.error?.name,
        error_message: deployment.error?.message.slice(0, 2_000),
      },
      deployment.finishedAt,
    ),
  );
  return events;
}

/** One job-grain event makes wholly missing runner evidence queryable. */
export function testTelemetryFinalizerEvent(input: {
  artifactCount: number;
  cancelled: boolean;
  expectedArtifactSources: readonly TestTelemetryArtifactSource[];
  expectedWorkspaces: readonly string[];
  foreignArtifactIds: readonly string[];
  incompleteArtifactIds: readonly string[];
  missingArtifactSources: readonly MissingArtifactSource[];
  missingWorkspaces: readonly string[];
  observedArtifactSourceCount: number;
  observedWorkspaceCount: number;
  primaryArtifact: TestTelemetryArtifact;
  runnerEventCount: number;
}): PostHogEvent {
  const { ci } = input.primaryArtifact;
  const identity = [
    "ci-test-finalizer",
    ci.repository,
    ci.workflowRunId,
    ci.workflowRunAttempt,
    ci.jobName ?? "job",
  ].join(":");
  const incomplete =
    input.incompleteArtifactIds.length > 0 ||
    input.foreignArtifactIds.length > 0 ||
    input.missingArtifactSources.length > 0 ||
    input.missingWorkspaces.length > 0;
  const status = input.cancelled ? "cancelled" : incomplete ? "failed" : "passed";
  const testKinds = new Set(
    input.expectedArtifactSources.length > 0
      ? input.expectedArtifactSources.map(({ testKind }) => testKind)
      : [input.primaryArtifact.context.testKind],
  );
  const timestamp = input.primaryArtifact.run.finishedAt;
  const missingArtifactSourceCount = input.missingArtifactSources.reduce(
    (total, { missingCount }) => total + missingCount,
    0,
  );

  return systemEvent(
    "ci test telemetry finalized",
    identity,
    identity,
    {
      ...ciProperties(input.primaryArtifact),
      framework: "mixed",
      test_kind: testKinds.size === 1 ? [...testKinds][0] : "mixed",
      lane: "telemetry-finalizer",
      status,
      failed: !input.cancelled && incomplete,
      telemetry_incomplete: incomplete,
      artifact_count: input.artifactCount,
      runner_event_count: input.runnerEventCount,
      expected_workspace_count: input.expectedWorkspaces.length,
      observed_workspace_count: input.observedWorkspaceCount,
      missing_workspace_count: input.missingWorkspaces.length,
      missing_workspaces: input.missingWorkspaces,
      expected_artifact_source_count: input.expectedArtifactSources.length,
      observed_artifact_source_count: input.observedArtifactSourceCount,
      matched_expected_artifact_source_count:
        input.expectedArtifactSources.length - missingArtifactSourceCount,
      missing_artifact_source_count: missingArtifactSourceCount,
      expected_artifact_sources: countedArtifactSourceLabels(input.expectedArtifactSources),
      missing_artifact_sources: input.missingArtifactSources.map(
        ({ source, expectedCount, observedCount, missingCount, ciScope }) =>
          `${testTelemetryArtifactSourceLabel(source)} [run ${ciScope.workflowRunId}/${ciScope.workflowRunAttempt}${ciScope.jobName ? ` job ${ciScope.jobName}` : ""}] (expected ${expectedCount}, observed ${observedCount}, missing ${missingCount})`,
      ),
      incomplete_artifact_count: input.incompleteArtifactIds.length,
      incomplete_artifact_ids: input.incompleteArtifactIds,
      foreign_artifact_count: input.foreignArtifactIds.length,
      foreign_artifact_ids: input.foreignArtifactIds,
    },
    timestamp,
  );
}

function countedArtifactSourceLabels(sources: readonly TestTelemetryArtifactSource[]) {
  return [...countTestTelemetryArtifactSources(sources).values()].map(({ count, source }) =>
    count === 1
      ? testTelemetryArtifactSourceLabel(source)
      : `${testTelemetryArtifactSourceLabel(source)} x${count}`,
  );
}

function ciProperties(artifact: TestTelemetryArtifact) {
  const { ci } = artifact;
  return {
    repository: ci.repository,
    head_sha: ci.headSha,
    branch: ci.branch,
    pull_request_number: ci.pullRequestNumber,
    workflow_name: ci.workflowName,
    workflow_run_id: ci.workflowRunId,
    workflow_run_attempt: ci.workflowRunAttempt,
    workflow_run_url: ci.workflowRunUrl,
    job_name: ci.jobName,
    runner_provider: ci.runnerProvider,
    depot_job_url: ci.depotJobUrl,
    execution_context: ci.executionContext,
  };
}

function testFailed(test: TestTelemetryArtifact["tests"][number]) {
  if (test.outcome) return test.outcome === "unexpected";
  return ["failed", "timedout"].includes(test.state.toLowerCase());
}

type EventFactory = (
  name: string,
  identity: string,
  context: TestTelemetryContext,
  properties: Record<string, unknown>,
  timestamp: string,
) => PostHogEvent;

function phaseEvent(input: {
  artifact: TestTelemetryArtifact;
  attemptIndex?: number;
  context: TestTelemetryContext;
  event: EventFactory;
  fallbackTimestamp: string;
  identity: string;
  phase: TestTelemetryArtifact["tests"][number]["phases"][number];
  test: TestTelemetryArtifact["tests"][number];
  testIdentity: string;
  testIndex: number;
}) {
  return input.event(
    "ci test phase finished",
    input.identity,
    input.context,
    {
      test_id: input.testIdentity,
      test_execution_id: `${input.artifact.artifactId}:test:${input.testIndex}`,
      test_name: input.test.fullName,
      test_module: normalizeModuleId(input.test.moduleId, input.artifact),
      attempt_index: input.attemptIndex,
      phase_name: input.phase.name,
      phase_category: input.phase.category,
      duration_ms: input.phase.durationMs,
      attachment_count: input.phase.attachmentCount,
      source_file: !input.phase.sourceFile
        ? undefined
        : normalizeModuleId(input.phase.sourceFile, input.artifact),
      source_line: input.phase.sourceLine,
      source_column: input.phase.sourceColumn,
      error_name: input.phase.error?.name,
      error_message: input.phase.error?.message.slice(0, 2_000),
    },
    finishedAt(input.phase.startedAt, input.phase.durationMs, input.fallbackTimestamp),
  );
}

function contextProperties(context: TestTelemetryContext) {
  return {
    framework: context.framework,
    test_kind: context.testKind,
    lane: context.lane,
    workspace: context.workspace,
    app: context.app,
    preview_slot: context.previewSlot,
    test_project: context.testProject,
  };
}

function mergeContext(
  defaults: TestTelemetryContext,
  overrides: Partial<TestTelemetryContext> | undefined,
): TestTelemetryContext {
  return { ...defaults, ...overrides };
}

function normalizeModuleId(moduleId: string, artifact: TestTelemetryArtifact) {
  const repositoryRoot = artifact.ci.workspaceRoot;
  if (!repositoryRoot || !isAbsolute(moduleId)) return moduleId;
  const candidate = relative(repositoryRoot, moduleId);
  return candidate !== ".." && !candidate.startsWith(`..${pathSeparator}`) && !isAbsolute(candidate)
    ? candidate || "."
    : moduleId;
}

function finishedAt(startedAt: string | undefined, durationMs: number, fallback: string) {
  if (!startedAt) return fallback;
  const timestamp = Date.parse(startedAt) + durationMs;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function testFinishedAt(test: TestTelemetryArtifact["tests"][number], fallback: string): string {
  const finalAttempt = test.attempts.at(-1);
  return finalAttempt
    ? finishedAt(finalAttempt.startedAt, finalAttempt.durationMs, fallback)
    : finishedAt(test.startedAt, test.durationMs, fallback);
}

/** Keep raw artifacts exhaustive while bounding PostHog fan-out to the most diagnostic details. */
function selectDetailedRecords<
  RecordType extends { durationMs: number; category?: string; error?: unknown },
>(records: readonly RecordType[]) {
  return records
    .map((value, index) => ({ index, value }))
    .sort(
      (left, right) =>
        Number(!!right.value.error) - Number(!!left.value.error) ||
        Number(right.value.category === "test.step") -
          Number(left.value.category === "test.step") ||
        right.value.durationMs - left.value.durationMs ||
        left.index - right.index,
    )
    .slice(0, MAX_DETAIL_EVENTS_PER_PARENT)
    .sort((left, right) => left.index - right.index);
}
