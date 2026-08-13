import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const TEST_TELEMETRY_ARTIFACT_SCHEMA_VERSION = 1;
export const TEST_TELEMETRY_INCOMPLETE_ERROR_NAME = "TestTelemetryIncompleteError";
const Timestamp = z.iso.datetime({ offset: true });
const RunStatus = z.enum(["passed", "failed", "skipped", "timedout", "interrupted", "cancelled"]);

const TestTelemetryError = z.object({
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
});

const TestTelemetryPhase = z.object({
  name: z.string(),
  durationMs: z.number().nonnegative(),
  category: z.string().optional(),
  startedAt: Timestamp.optional(),
  attachmentCount: z.number().int().nonnegative().optional(),
  sourceFile: z.string().optional(),
  sourceLine: z.number().int().optional(),
  sourceColumn: z.number().int().optional(),
  error: TestTelemetryError.optional(),
});

const AnnotationRecord = z.object({
  type: z.string().min(1),
  description: z.string().optional(),
});

const TestTelemetryContext = z.object({
  framework: z.enum(["vitest", "playwright", "node-test", "script", "mixed"]),
  testKind: z.enum(["unit", "integration", "e2e"]),
  lane: z.string().min(1),
  workspace: z.string().optional(),
  app: z.string().optional(),
  previewSlot: z.string().optional(),
  testProject: z.string().optional(),
});

/** A runner artifact that an orchestrator expects the finalizer to receive. */
const TestTelemetryArtifactSource = z.object({
  producer: z.string().min(1),
  framework: TestTelemetryContext.shape.framework,
  testKind: TestTelemetryContext.shape.testKind,
  lane: z.string().min(1),
  workspace: z.string().min(1),
});

const TestTelemetryAttempt = z.object({
  attemptIndex: z.number().int().nonnegative(),
  state: z.string().min(1),
  durationMs: z.number().nonnegative(),
  startedAt: Timestamp.optional(),
  startedAtSource: z.enum(["runner", "reporter-clock", "inferred"]).optional(),
  scheduleDelayMs: z.number().nonnegative().optional(),
  workerIndex: z.number().int().optional(),
  parallelIndex: z.number().int().optional(),
  attachmentCount: z.number().int().nonnegative().optional(),
  stdoutBytes: z.number().int().nonnegative().optional(),
  stderrBytes: z.number().int().nonnegative().optional(),
  error: TestTelemetryError.optional(),
  phases: z.array(TestTelemetryPhase),
});

const TestTelemetryRecord = z.object({
  fullName: z.string(),
  moduleId: z.string(),
  testNumber: z.number().int().optional(),
  testLine: z.number().int().optional(),
  testColumn: z.number().int().optional(),
  runnerTestId: z.string().optional(),
  expectedState: z.string().optional(),
  outcome: z.string().optional(),
  configuredTimeoutMs: z.number().nonnegative().optional(),
  repeatIndex: z.number().int().nonnegative().optional(),
  repeatCount: z.number().int().nonnegative().optional(),
  slow: z.boolean().optional(),
  heapBytes: z.number().int().nonnegative().optional(),
  tags: z.array(z.string()),
  annotations: z.array(AnnotationRecord),
  context: TestTelemetryContext.partial().optional(),
  retryCount: z.number().int().nonnegative(),
  passedAfterRetry: z.boolean(),
  state: z.string().min(1),
  durationMs: z.number().nonnegative(),
  startedAt: Timestamp.optional(),
  startedAtSource: z.enum(["runner", "reporter-clock", "inferred"]).optional(),
  attemptDetail: z.enum(["complete", "aggregate-only"]),
  scheduleDelayMs: z.number().nonnegative().optional(),
  beforeEachDurationMs: z.number().nonnegative().optional(),
  afterEachDurationMs: z.number().nonnegative().optional(),
  bodyDurationMs: z.number().nonnegative().optional(),
  attempts: z.array(TestTelemetryAttempt),
  phases: z.array(TestTelemetryPhase),
  errors: z.array(TestTelemetryError),
  firstFailure: z.string().optional(),
});

const ModuleTelemetryRecord = z.object({
  moduleId: z.string(),
  context: TestTelemetryContext.partial().optional(),
  environmentSetupDurationMs: z.number().nonnegative(),
  prepareDurationMs: z.number().nonnegative(),
  collectDurationMs: z.number().nonnegative(),
  setupDurationMs: z.number().nonnegative(),
  testAndHookDurationMs: z.number().nonnegative(),
  importDurationMs: z.number().nonnegative(),
  imports: z.array(
    z.object({
      moduleId: z.string(),
      selfDurationMs: z.number().nonnegative(),
      totalDurationMs: z.number().nonnegative().optional(),
    }),
  ),
  queuedAt: Timestamp.optional(),
  collectedAt: Timestamp.optional(),
  startedAt: Timestamp.optional(),
  finishedAt: Timestamp.optional(),
  queueDurationMs: z.number().nonnegative().optional(),
  executionWallDurationMs: z.number().nonnegative().optional(),
});

const TestTelemetryLane = z.object({
  context: TestTelemetryContext,
  status: RunStatus,
  durationMs: z.number().nonnegative(),
  exitCode: z.number().int().nullable().optional(),
  testCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  // Runner/global errors that are not attributable to one test. These are
  // valid failure evidence; only the explicit run sentinel means collection
  // stopped before the reporter could write a complete artifact.
  collectionErrors: z.array(z.string()),
});

const DeploymentTelemetryLane = z.object({
  app: z.string().min(1),
  previewSlot: z.string().optional(),
  status: z.enum(["passed", "failed"]),
  durationMs: z.number().nonnegative(),
  finishedAt: Timestamp.optional(),
  configDurationMs: z.number().nonnegative().nullable().optional(),
  commandDurationMs: z.number().nonnegative().nullable().optional(),
  readinessDurationMs: z.number().nonnegative().nullable().optional(),
  reuseProofDurationMs: z.number().nonnegative().nullable().optional(),
  workerName: z.string().nullable().optional(),
  workerVersion: z.string().nullable().optional(),
});

const DeploymentTelemetry = z.object({
  deploymentKind: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  startedAt: Timestamp,
  finishedAt: Timestamp,
  durationMs: z.number().nonnegative(),
  previewSlot: z.string().optional(),
  error: TestTelemetryError.optional(),
  lanes: z.array(DeploymentTelemetryLane),
});

/**
 * Durable, runner-independent input to the CI telemetry finalizer. Reporters
 * only write this artifact; they never know about PostHog or network delivery.
 */
export const TestTelemetryArtifact = z.object({
  artifactSchemaVersion: z.literal(TEST_TELEMETRY_ARTIFACT_SCHEMA_VERSION),
  artifactId: z.string().min(1),
  producer: z.string().min(1),
  createdAt: Timestamp,
  ci: z.object({
    repository: z.string().min(1),
    headSha: z.string().optional(),
    branch: z.string().optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    workflowName: z.string().optional(),
    workflowRunId: z.string().min(1),
    workflowRunAttempt: z.string().min(1),
    workflowRunUrl: z.string().optional(),
    jobName: z.string().optional(),
    workspaceRoot: z.string().optional(),
    runnerProvider: z.enum(["depot", "github-actions", "local"]),
    depotJobUrl: z.string().optional(),
    executionContext: z.enum(["ci", "local"]),
  }),
  context: TestTelemetryContext,
  /**
   * Dynamic suites publish one entry per runner they start. The finalizer
   * compares source cardinality across every artifact, so a process that never
   * wrote even its pessimistic sentinel cannot silently disappear.
   */
  expectedArtifactSources: z.array(TestTelemetryArtifactSource).optional(),
  run: z.object({
    status: RunStatus,
    startedAt: Timestamp,
    finishedAt: Timestamp,
    durationMs: z.number().nonnegative(),
    error: TestTelemetryError.optional(),
  }),
  /** Optional deployment evidence recorded by an orchestration artifact. */
  deployment: DeploymentTelemetry.optional(),
  lanes: z.array(TestTelemetryLane),
  tests: z.array(TestTelemetryRecord),
  modules: z.array(ModuleTelemetryRecord),
});

export type TestTelemetryArtifact = z.infer<typeof TestTelemetryArtifact>;
export type TestTelemetryContext = z.infer<typeof TestTelemetryContext>;
export type TestTelemetryArtifactSource = z.infer<typeof TestTelemetryArtifactSource>;
export type TestTelemetryError = z.infer<typeof TestTelemetryError>;
export type TestTelemetryPhase = z.infer<typeof TestTelemetryPhase>;
export type TestTelemetryAttempt = z.infer<typeof TestTelemetryAttempt>;
export type TestTelemetryRecord = z.infer<typeof TestTelemetryRecord>;
export type ModuleTelemetryRecord = z.infer<typeof ModuleTelemetryRecord>;
export type TestTelemetryLane = z.infer<typeof TestTelemetryLane>;
export type DeploymentTelemetry = z.infer<typeof DeploymentTelemetry>;
export type DeploymentTelemetryLane = z.infer<typeof DeploymentTelemetryLane>;

/** Convert an arbitrary runner/orchestrator failure into the shared JSON-safe shape. */
export function normalizeTestTelemetryError(
  error: unknown,
  fallbackMessage = "Unknown test telemetry error",
): TestTelemetryError {
  if (typeof error !== "object" || !error) return { message: String(error) };
  const candidate = error as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message: typeof candidate.message === "string" ? candidate.message : fallbackMessage,
    ...(typeof candidate.name === "string" && { name: candidate.name }),
    ...(typeof candidate.stack === "string" && { stack: candidate.stack }),
  };
}

/** Writes a validated artifact atomically so a killed runner cannot leave valid-looking partial JSON. */
export function writeTestTelemetryArtifact(
  artifact: TestTelemetryArtifact,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const outputFiles = resolveTestTelemetryArtifactPaths(artifact.artifactId, environment);
  if (outputFiles.length === 0) return null;
  const validated = TestTelemetryArtifact.parse(artifact);
  const contents = `${JSON.stringify(validated, null, 2)}\n`;
  for (const outputFile of outputFiles) {
    mkdirSync(dirname(outputFile), { recursive: true });
    const temporaryFile = `${outputFile}.${process.pid}.tmp`;
    writeFileSync(temporaryFile, contents);
    renameSync(temporaryFile, outputFile);
  }
  return outputFiles[0]!;
}

/**
 * Writes a pessimistic run-start sentinel that the completed artifact replaces.
 * If the process is killed before its reporter's end hook, the always-running
 * finalizer retains an explicit incomplete artifact instead of silently losing
 * the runner from failure-rate and duration analysis.
 */
export function writeTestTelemetryFailureSentinel(
  input: {
    artifactId: string;
    producer: string;
    startedAt: string;
    ci: TestTelemetryArtifact["ci"];
    context: TestTelemetryContext;
    expectedArtifactSources?: readonly TestTelemetryArtifactSource[];
  },
  environment: NodeJS.ProcessEnv = process.env,
) {
  const message = `${input.producer} started but did not write its completed telemetry artifact`;
  return writeTestTelemetryArtifact(
    {
      artifactSchemaVersion: TEST_TELEMETRY_ARTIFACT_SCHEMA_VERSION,
      artifactId: input.artifactId,
      producer: input.producer,
      createdAt: input.startedAt,
      ci: input.ci,
      context: input.context,
      ...(!input.expectedArtifactSources
        ? {}
        : { expectedArtifactSources: [...input.expectedArtifactSources] }),
      run: {
        status: "failed",
        startedAt: input.startedAt,
        finishedAt: input.startedAt,
        durationMs: 0,
        error: { name: TEST_TELEMETRY_INCOMPLETE_ERROR_NAME, message },
      },
      lanes: [
        {
          context: input.context,
          status: "failed",
          durationMs: 0,
          testCount: 0,
          retryCount: 0,
          collectionErrors: [message],
        },
      ],
      tests: [],
      modules: [],
    },
    environment,
  );
}

export function resolveTestTelemetryArtifactPath(
  artifactId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveTestTelemetryArtifactPaths(artifactId, environment)[0] ?? null;
}

/**
 * A named file lets an orchestrator read a runner immediately; the directory
 * copy is the durable input consumed later by CI's finalizer.
 */
export function resolveTestTelemetryArtifactPaths(
  artifactId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicit = environment.TEST_TELEMETRY_ARTIFACT_FILE?.trim();
  const directory = environment.TEST_TELEMETRY_ARTIFACT_DIR?.trim();
  const repositoryRoot = environment.GITHUB_WORKSPACE?.trim();
  const fromRepositoryRoot = (path: string) =>
    repositoryRoot ? resolve(repositoryRoot, path) : path;
  return [
    ...(explicit ? [fromRepositoryRoot(explicit)] : []),
    ...(directory ? [fromRepositoryRoot(join(directory, `${safeFilePart(artifactId)}.json`))] : []),
  ].filter((path, index, paths) => paths.indexOf(path) === index);
}

export function testTelemetryArtifactId(...parts: Array<string | number | undefined>) {
  return parts.filter((part) => part || part === 0).join(":");
}

export function testTelemetryContextFromEnvironment(
  framework: TestTelemetryContext["framework"],
  defaults: Pick<TestTelemetryContext, "testKind" | "lane"> &
    Partial<Omit<TestTelemetryContext, "framework" | "testKind" | "lane">>,
  environment: NodeJS.ProcessEnv = process.env,
): TestTelemetryContext {
  return TestTelemetryContext.parse({
    framework,
    testKind: environment.TEST_TELEMETRY_KIND ?? defaults.testKind,
    lane: environment.TEST_TELEMETRY_LANE ?? defaults.lane,
    workspace: environment.TEST_TELEMETRY_WORKSPACE ?? defaults.workspace,
    app: environment.TEST_TELEMETRY_APP ?? defaults.app,
    previewSlot: environment.TEST_TELEMETRY_PREVIEW_SLOT ?? defaults.previewSlot,
    testProject: environment.TEST_TELEMETRY_PROJECT ?? defaults.testProject,
  });
}

export function ciTelemetrySourceFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  fallbackRunId = `local-${Date.now()}`,
): TestTelemetryArtifact["ci"] {
  const repository = environment.GITHUB_REPOSITORY ?? "iterate/iterate";
  const runId = environment.GITHUB_RUN_ID ?? fallbackRunId;
  return {
    repository,
    ...((environment.TEST_TELEMETRY_HEAD_SHA || environment.GITHUB_SHA) && {
      headSha: environment.TEST_TELEMETRY_HEAD_SHA || environment.GITHUB_SHA,
    }),
    ...((environment.TEST_TELEMETRY_BRANCH ||
      environment.GITHUB_HEAD_REF ||
      environment.GITHUB_REF_NAME) && {
      branch:
        environment.TEST_TELEMETRY_BRANCH ||
        environment.GITHUB_HEAD_REF ||
        environment.GITHUB_REF_NAME,
    }),
    ...optionalPullRequestNumber(
      environment.TEST_TELEMETRY_PULL_REQUEST_NUMBER,
      environment.GITHUB_REF,
    ),
    ...(environment.GITHUB_WORKFLOW && { workflowName: environment.GITHUB_WORKFLOW }),
    workflowRunId: runId,
    workflowRunAttempt: environment.GITHUB_RUN_ATTEMPT ?? "1",
    ...(environment.GITHUB_SERVER_URL &&
      environment.GITHUB_REPOSITORY &&
      environment.GITHUB_RUN_ID && {
        workflowRunUrl: `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`,
      }),
    ...(environment.GITHUB_JOB && { jobName: environment.GITHUB_JOB }),
    workspaceRoot: environment.GITHUB_WORKSPACE ?? process.cwd(),
    runnerProvider: environment.DEPOT_JOB_URL
      ? "depot"
      : environment.GITHUB_RUN_ID
        ? "github-actions"
        : "local",
    ...(environment.DEPOT_JOB_URL && { depotJobUrl: environment.DEPOT_JOB_URL }),
    executionContext: environment.GITHUB_RUN_ID ? "ci" : "local",
  };
}

function safeFilePart(value: string) {
  const readable = value
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 120);
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${readable || "artifact"}-${digest}`;
}

function optionalPullRequestNumber(explicit: string | undefined, githubRef: string | undefined) {
  if (explicit) {
    const parsed = Number(explicit);
    if (!Number.isInteger(parsed) || parsed <= 0)
      throw new Error(`Invalid TEST_TELEMETRY_PULL_REQUEST_NUMBER: ${explicit}`);
    return { pullRequestNumber: parsed };
  }
  const match = githubRef?.match(/^refs\/pull\/(\d+)\/(?:merge|head)$/u);
  return match ? { pullRequestNumber: Number(match[1]) } : {};
}
