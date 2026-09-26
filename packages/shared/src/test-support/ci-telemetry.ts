import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const TEST_TELEMETRY_ARTIFACT_SCHEMA_VERSION = 3;
export const TEST_TELEMETRY_INCOMPLETE_ERROR_NAME = "TestTelemetryIncompleteError";
const Timestamp = z.iso.datetime({ offset: true });
const RunStatus = z.enum(["passed", "failed", "skipped", "timedout", "interrupted", "cancelled"]);

const TestTelemetryError = z.object({
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
});

const TestTelemetryContext = z.object({
  framework: z.enum(["vitest", "playwright"]),
  testKind: z.enum(["unit", "integration", "e2e"]),
  suite: z.string().min(1),
  workspace: z.string().optional(),
});

/** One test, after all its attempts: what the suite summary, the row budget, the flake records and
 *  Main OS e2e's failing rows read. */
const TestTelemetryRecord = z.object({
  fullName: z.string(),
  /** Bare title, shared with createFlake/createFailing records. */
  leafName: z.string().optional(),
  moduleId: z.string(),
  /** `failed` for a createFlake/createFailing registration (the runner's expected-fail mode). */
  expectedState: z.string().optional(),
  /** Playwright's verdict against `expectedState`; vitest has none. */
  outcome: z.string().optional(),
  tags: z.array(z.string()),
  retryCount: z.number().int().nonnegative(),
  passedAfterRetry: z.boolean(),
  /** The final attempt's state. */
  state: z.string().min(1),
  /** Every attempt together. */
  durationMs: z.number().nonnegative(),
  startedAt: Timestamp.optional(),
  errors: z.array(TestTelemetryError),
  /** The first failure, on one line and at most 300 characters. */
  firstFailure: z.string().optional(),
});

/**
 * Durable, runner-independent input to the CI telemetry finalizer
 * (scripts/ci/upload-test-telemetry.ts). Reporters only write this artifact and never perform
 * network I/O.
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
    depotJobUrl: z.string().optional(),
  }),
  context: TestTelemetryContext,
  run: z.object({
    status: RunStatus,
    startedAt: Timestamp,
    finishedAt: Timestamp,
    durationMs: z.number().nonnegative(),
    error: TestTelemetryError.optional(),
    // Errors no one test owns (an import, a suite hook, an unhandled rejection): failure evidence
    // too. Only the sentinel's TEST_TELEMETRY_INCOMPLETE_ERROR_NAME means the runner never finished.
    collectionErrors: z.array(z.string()),
  }),
  tests: z.array(TestTelemetryRecord),
});

export type TestTelemetryArtifact = z.infer<typeof TestTelemetryArtifact>;
export type TestTelemetryContext = z.infer<typeof TestTelemetryContext>;
export type TestTelemetryError = z.infer<typeof TestTelemetryError>;
export type TestTelemetryRecord = z.infer<typeof TestTelemetryRecord>;

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

/** Writes a validated artifact atomically into TEST_TELEMETRY_ARTIFACT_DIR (a relative one from
 *  GITHUB_WORKSPACE), so a killed runner cannot leave valid-looking partial JSON. Without the
 *  variable (a laptop) it writes nothing and returns null. */
export function writeTestTelemetryArtifact(
  artifact: TestTelemetryArtifact,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const outputFile = resolveTestTelemetryArtifactPath(artifact.artifactId, environment);
  if (!outputFile) return null;
  const validated = TestTelemetryArtifact.parse(artifact);
  mkdirSync(dirname(outputFile), { recursive: true });
  const temporaryFile = `${outputFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(validated, null, 2)}\n`);
  renameSync(temporaryFile, outputFile);
  return outputFile;
}

/**
 * Writes a pessimistic run-start sentinel that the completed artifact replaces.
 * If the process is killed before its reporter's end hook, the always-running
 * finalizer retains an explicit incomplete artifact instead of silently losing
 * the runner.
 */
export function writeTestTelemetryFailureSentinel(
  input: {
    artifactId: string;
    producer: string;
    startedAt: string;
    ci: TestTelemetryArtifact["ci"];
    context: TestTelemetryContext;
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
      run: {
        status: "failed",
        startedAt: input.startedAt,
        finishedAt: input.startedAt,
        durationMs: 0,
        error: { name: TEST_TELEMETRY_INCOMPLETE_ERROR_NAME, message },
        collectionErrors: [message],
      },
      tests: [],
    },
    environment,
  );
}

export function resolveTestTelemetryArtifactPath(
  artifactId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const directory = environment.TEST_TELEMETRY_ARTIFACT_DIR?.trim();
  if (!directory) return null;
  const path = join(directory, `${safeFilePart(artifactId)}.json`);
  const repositoryRoot = environment.GITHUB_WORKSPACE?.trim();
  return repositoryRoot ? resolve(repositoryRoot, path) : path;
}

export function testTelemetryArtifactId(...parts: Array<string | number | undefined>) {
  return parts.filter((part) => part !== undefined && part !== "").join(":");
}

export function testTelemetryContextFromEnvironment(
  framework: TestTelemetryContext["framework"],
  defaults: Omit<TestTelemetryContext, "framework">,
  environment: NodeJS.ProcessEnv = process.env,
): TestTelemetryContext {
  return TestTelemetryContext.parse({
    framework,
    testKind: environment.TEST_TELEMETRY_KIND || defaults.testKind,
    suite: environment.TEST_TELEMETRY_SUITE || defaults.suite,
    workspace: environment.TEST_TELEMETRY_WORKSPACE || defaults.workspace,
  });
}

export function ciTelemetrySourceFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  fallbackRunId = `local-${Date.now()}`,
): TestTelemetryArtifact["ci"] {
  const repository = environment.GITHUB_REPOSITORY || "iterate/iterate";
  const runId = environment.GITHUB_RUN_ID || fallbackRunId;
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
    workflowName: environment.GITHUB_WORKFLOW || undefined,
    workflowRunId: runId,
    workflowRunAttempt: environment.GITHUB_RUN_ATTEMPT || "1",
    ...(environment.GITHUB_SERVER_URL &&
      environment.GITHUB_REPOSITORY &&
      environment.GITHUB_RUN_ID && {
        workflowRunUrl: `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`,
      }),
    jobName: environment.GITHUB_JOB || undefined,
    depotJobUrl: environment.DEPOT_JOB_URL || undefined,
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
