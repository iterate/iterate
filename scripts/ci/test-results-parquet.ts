import { relative } from "node:path";
import { parquetWriteBuffer, type BasicType } from "hyparquet-writer";
import { z } from "zod";
import type { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import type { FlakeRecord } from "./flake-dashboard/contract.ts";

/**
 * One row per test, for the test evidence folder's `tables/tests.parquet`
 * (docs/test-evidence.md#tables). `scripts/ci/test-evidence.ts write` builds it from what the job
 * already keeps: the runners' raw telemetry artifacts (the finalizer, upload-test-telemetry.ts, has
 * checked them) and the createFlake/createFailing record lines. A test's own flake records ride on
 * its row.
 */
export function testResultsTable(input: {
  job: ReturnType<typeof ciJobAttempt>;
  artifacts: readonly TestTelemetryArtifact[];
  flakeRecords: readonly FlakeRecord[];
}) {
  const { job } = input;
  const tests = input.artifacts.flatMap((artifact) =>
    artifact.tests.map((test) => {
      const flakeRecords: FlakeRecord[] = [];
      return { artifact, test, flakeRecords };
    }),
  );
  // createFlake/createFailing record their bare title (`args[0]`, flake-record.ts) and register the
  // test in the runner's expected-fail mode, so a record names exactly one `expectedState: "failed"`
  // test. Kind "unknown" records restate a plain test's retries and failure, already on its row.
  for (const record of input.flakeRecords) {
    if (record.kind === "unknown") continue;
    const matches = tests.filter(
      ({ test }) =>
        test.expectedState === "failed" && (test.leafName || test.fullName) === record.name,
    );
    if (matches.length !== 1) {
      throw new Error(
        `The ${record.kind} record "${record.name}" names ${matches.length} expected-fail tests in this job attempt, not 1`,
      );
    }
    matches[0]!.flakeRecords.push(record);
  }

  const rows = tests.map(({ artifact, test, flakeRecords }) => {
    const kinds = new Set(flakeRecords.map((record) => record.kind));
    if (kinds.size > 1) throw new Error(`"${test.fullName}" has both flake and failing records`);
    return {
      test_run_id: job.testRunId,
      repository: job.repository,
      workflow_name: job.workflowName,
      workflow_run_id: job.workflowRunId,
      workflow_run_attempt: job.workflowRunAttempt,
      job_name: job.jobName,
      job_attempt_id: job.jobAttemptId,
      depot_job_url: job.depotJobUrl,
      head_sha: job.headSha,
      branch: job.branch,
      pull_request_number: job.pullRequestNumber ?? null,
      producer: artifact.producer,
      framework: artifact.context.framework,
      test_kind: artifact.context.testKind,
      workspace: artifact.context.workspace || null,
      test_project: test.context?.testProject || artifact.context.testProject || null,
      module_path: relative(job.workspaceRoot, test.moduleId),
      full_name: test.fullName,
      leaf_name: test.leafName || null,
      test_line: test.testLine ?? null,
      state: test.state,
      expected_state: test.expectedState || null,
      outcome: test.outcome || null,
      retry_count: test.retryCount,
      passed_after_retry: test.passedAfterRetry,
      started_at: test.startedAt ? new Date(test.startedAt) : null,
      duration_ms: test.durationMs,
      configured_timeout_ms: test.configuredTimeoutMs ?? null,
      first_failure: test.firstFailure || null,
      errors: test.errors.length > 0 ? test.errors : null,
      // Playwright's attempts carry every step as a phase, kilobytes per test; the attempt's own
      // state, timing and error are what cross-run questions ask about.
      attempts:
        test.attempts.length > 0
          ? test.attempts.map((attempt) => ({
              attemptIndex: attempt.attemptIndex,
              state: attempt.state,
              durationMs: attempt.durationMs,
              startedAt: attempt.startedAt,
              error: attempt.error?.message,
            }))
          : null,
      tags: test.tags.length > 0 ? test.tags : null,
      flake_kind: flakeRecords[0]?.kind ?? null,
      flake_pattern: flakeRecords[0]?.pattern ?? null,
      flake_outcomes: flakeRecords.length > 0 ? flakeRecords.map((record) => record.outcome) : null,
    };
  });
  return rows;
}

type TestResultRow = ReturnType<typeof testResultsTable>[number];

/**
 * Every column's Parquet type, in file order. A `JSON` column takes the value itself; the writer
 * serializes it. Typed columns, rather than hyparquet-writer's guess from the data, keep a file whose
 * values are all null or all whole numbers on the same schema as every other file:
 * https://github.com/hyparam/hyparquet-writer#column-types
 */
const columnTypes: Record<keyof TestResultRow, BasicType> = {
  test_run_id: "STRING",
  repository: "STRING",
  workflow_name: "STRING",
  workflow_run_id: "STRING",
  workflow_run_attempt: "STRING",
  job_name: "STRING",
  job_attempt_id: "STRING",
  depot_job_url: "STRING",
  head_sha: "STRING",
  branch: "STRING",
  pull_request_number: "INT32",
  producer: "STRING",
  framework: "STRING",
  test_kind: "STRING",
  workspace: "STRING",
  test_project: "STRING",
  module_path: "STRING",
  full_name: "STRING",
  leaf_name: "STRING",
  test_line: "INT32",
  state: "STRING",
  expected_state: "STRING",
  outcome: "STRING",
  retry_count: "INT32",
  passed_after_retry: "BOOLEAN",
  started_at: "TIMESTAMP",
  duration_ms: "DOUBLE",
  configured_timeout_ms: "DOUBLE",
  first_failure: "STRING",
  errors: "JSON",
  attempts: "JSON",
  tags: "JSON",
  flake_kind: "STRING",
  flake_pattern: "STRING",
  flake_outcomes: "JSON",
};

export function testResultsParquet(rows: readonly TestResultRow[]) {
  return new Uint8Array(
    parquetWriteBuffer({
      columnData: Object.entries(columnTypes).map(([name, type]) => ({
        name,
        type,
        // Object.entries widens keys to string; columnTypes is keyed by exactly the row's fields.
        data: rows.map((row) => row[name as keyof TestResultRow]),
      })),
    }),
  );
}

/**
 * The CI job attempt every artifact belongs to: the rows' and the manifest's identity. A test run is
 * one job attempt, so an artifact from another attempt (a stale file, a retry's leftovers) or
 * telemetry with no Depot job (a local run) is refused rather than mislabelled.
 */
export function ciJobAttempt(artifacts: readonly TestTelemetryArtifact[]) {
  const [first] = artifacts;
  if (!first)
    throw new Error("No test telemetry artifacts: a job attempt with no runner has no rows");
  const job = CiJob.parse(first.ci);
  for (const artifact of artifacts) {
    const other = CiJob.parse(artifact.ci);
    if (other.workflowRunId !== job.workflowRunId || other.depotJobUrl !== job.depotJobUrl) {
      throw new Error(
        `${artifact.artifactId} belongs to ${other.depotJobUrl}, not this job attempt (${job.depotJobUrl})`,
      );
    }
  }
  const jobAttemptId = new URL(job.depotJobUrl).searchParams.get("attempt");
  if (!jobAttemptId) throw new Error(`DEPOT_JOB_URL names no job attempt: ${job.depotJobUrl}`);
  return { ...job, jobAttemptId, testRunId: `testrun_${jobAttemptId}` };
}

/** The fields a row and the manifest need, which a local run's telemetry may not have. */
const CiJob = z.object({
  repository: z.string(),
  workflowName: z.string().min(1),
  workflowRunId: z.string(),
  workflowRunAttempt: z.string(),
  jobName: z.string().min(1),
  depotJobUrl: z.url(),
  workspaceRoot: z.string().min(1),
  headSha: z.string().min(1),
  branch: z.string().min(1),
  pullRequestNumber: z.number().int().optional(),
});
