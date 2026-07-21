import {
  ciTelemetrySourceFromEnvironment,
  normalizeTestTelemetryError,
  testTelemetryArtifactId,
  writeTestTelemetryArtifact,
  writeTestTelemetryFailureSentinel,
  type TestTelemetryArtifact,
  type TestTelemetryLane,
} from "@iterate-com/shared/test-support/ci-telemetry";

type RunContext = {
  branch?: string;
  environment: NodeJS.ProcessEnv;
  headSha: string;
  operation: "test" | "run";
  pullRequestNumber: number;
  runUrl: string | null;
};

/**
 * Records orchestration-level lane and run timing. Runner reporters write
 * test/module artifacts independently; the finalizer joins all artifacts.
 */
export class PreviewE2eTelemetryArtifact {
  private readonly artifactId: string;
  private readonly ci: TestTelemetryArtifact["ci"];
  private readonly context = {
    framework: "mixed" as const,
    testKind: "e2e" as const,
    lane: "preview",
  };
  private readonly environment: NodeJS.ProcessEnv;
  private readonly lanes: TestTelemetryLane[] = [];
  private runResult: TestTelemetryArtifact["run"] | null = null;
  private startedAtMs = Date.now();

  constructor(context: RunContext) {
    this.environment = context.environment;
    const ci = ciTelemetrySourceFromEnvironment(
      context.environment,
      `local-preview-${context.pullRequestNumber}-${context.headSha.slice(0, 12)}-${this.startedAtMs}`,
    );
    this.ci = {
      ...ci,
      ...(context.branch ? { branch: context.branch } : {}),
      headSha: context.headSha,
      pullRequestNumber: context.pullRequestNumber,
      ...(context.runUrl ? { workflowRunUrl: context.runUrl } : {}),
    };
    this.artifactId = testTelemetryArtifactId(
      "preview",
      ci.workflowRunId,
      ci.workflowRunAttempt,
      context.operation,
      process.pid,
      this.startedAtMs,
    );
    writeTestTelemetryFailureSentinel(
      {
        artifactId: this.artifactId,
        producer: "preview-e2e-orchestrator",
        startedAt: new Date(this.startedAtMs).toISOString(),
        ci: this.ci,
        context: this.context,
      },
      this.environment,
    );
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
    this.lanes.push({
      context: {
        framework: "mixed",
        testKind: "e2e",
        lane: "preview",
        app: input.app,
        ...(input.slot ? { previewSlot: input.slot } : {}),
      },
      status: input.status,
      durationMs: input.durationMs,
      exitCode: input.exitCode,
      testCount: input.testCount,
      retryCount: input.retryCount,
      collectionErrors: input.collectionErrors,
    });
  }

  runFinished(input: {
    status: "passed" | "failed" | "skipped";
    durationMs: number;
    error?: unknown;
  }) {
    const finishedAt = new Date().toISOString();
    this.runResult = {
      status: input.status,
      startedAt: new Date(this.startedAtMs).toISOString(),
      finishedAt,
      durationMs: input.durationMs,
      ...(input.error ? { error: normalizeTestTelemetryError(input.error) } : {}),
    };
  }

  async shutdown() {
    const outputFile = writeTestTelemetryArtifact(this.artifact(), this.environment);
    if (outputFile) console.log(`[preview:telemetry] wrote ${outputFile}`);
  }

  artifactForTest() {
    return this.artifact();
  }

  private artifact(): TestTelemetryArtifact {
    if (!this.runResult) throw new Error("Preview telemetry run finished without a result");
    return {
      artifactSchemaVersion: 1,
      artifactId: this.artifactId,
      producer: "preview-e2e-orchestrator",
      createdAt: this.runResult.finishedAt,
      ci: this.ci,
      context: this.context,
      run: this.runResult,
      lanes: this.lanes,
      tests: [],
      modules: [],
    };
  }
}
