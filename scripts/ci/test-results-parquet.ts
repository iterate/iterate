import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { AwsClient } from "aws4fetch";
import { parquetWriteBuffer, type BasicType } from "hyparquet-writer";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import type { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { testResultsEnvs } from "../../envs.ts";
import { FlakeRecord } from "./flake-dashboard/contract.ts";
import { loadTestTelemetryArtifacts } from "./upload-test-telemetry.ts";

/**
 * DRAFT (off in CI until `TEST_RESULTS_PARQUET: upload`): one CI job attempt's per-test results as
 * one Parquet file in R2, so test history is a SQL query instead of a Depot artifact download per run.
 * Schema, object keys, a DuckDB query, volume and retention: docs/test-results-parquet.md.
 *
 * Reads what the job already keeps: the runners' raw telemetry artifacts (the finalizer,
 * upload-test-telemetry.ts, has checked them) and the createFlake/createFailing record lines. One row
 * per test; the test's own flake records ride on its row.
 */
export function testResultsTable(input: {
  artifacts: readonly TestTelemetryArtifact[];
  flakeRecords: readonly FlakeRecord[];
}) {
  const [first] = input.artifacts;
  if (!first)
    throw new Error("No test telemetry artifacts: a job attempt with no runner has no rows");
  const job = CiJob.parse(first.ci);
  for (const artifact of input.artifacts) {
    const other = CiJob.parse(artifact.ci);
    if (other.workflowRunId !== job.workflowRunId || other.depotJobUrl !== job.depotJobUrl) {
      throw new Error(
        `${artifact.artifactId} belongs to ${other.depotJobUrl}, not this job attempt (${job.depotJobUrl})`,
      );
    }
  }
  const jobAttemptId = new URL(job.depotJobUrl).searchParams.get("attempt");
  if (!jobAttemptId) throw new Error(`DEPOT_JOB_URL names no job attempt: ${job.depotJobUrl}`);
  const startedAt = input.artifacts.map((artifact) => artifact.run.startedAt).sort()[0]!;
  const workflow = job.workflowName.toLowerCase().replace(/[^a-z0-9]+/gu, "-");

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
      repository: job.repository,
      workflow_name: job.workflowName,
      workflow_run_id: job.workflowRunId,
      workflow_run_attempt: job.workflowRunAttempt,
      job_name: job.jobName,
      job_attempt_id: jobAttemptId,
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
  return {
    /** Hive-style partitions, so DuckDB's `hive_partitioning` turns them into `date` and `workflow` columns. */
    key: `date=${startedAt.slice(0, 10)}/workflow=${workflow}/${job.workflowRunId}-${job.jobName}-${jobAttemptId}.parquet`,
    rows,
  };
}

type TestResultRow = ReturnType<typeof testResultsTable>["rows"][number];

/**
 * Every column's Parquet type, in file order. A `JSON` column takes the value itself; the writer
 * serializes it. Typed columns, rather than hyparquet-writer's guess from the data, keep a file whose
 * values are all null or all whole numbers on the same schema as every other file:
 * https://github.com/hyparam/hyparquet-writer#column-types
 */
const columnTypes: Record<keyof TestResultRow, BasicType> = {
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
 * PUT through R2's S3 API with a bucket-scoped R2 API token
 * (https://developers.cloudflare.com/r2/api/s3/api/, https://developers.cloudflare.com/r2/api/tokens/).
 * aws4fetch only signs the request (SigV4, region `auto`): its `AwsClient.fetch` retries a 5xx up to
 * 10 times by default (https://github.com/mhart/aws4fetch#new-awsclientoptions), which would hide
 * R2 trouble inside one slow step. One request, and a failure fails the step.
 */
export async function putTestResultsObject(input: {
  accountId: string;
  bucketName: string;
  key: string;
  body: Uint8Array;
  accessKeyId: string;
  secretAccessKey: string;
  fetch: typeof fetch;
}) {
  const client = new AwsClient({
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const request = await client.sign(
    `https://${input.accountId}.r2.cloudflarestorage.com/${input.bucketName}/${input.key}`,
    {
      method: "PUT",
      body: input.body,
      // The IANA media type for Parquet: https://www.iana.org/assignments/media-types/application/vnd.apache.parquet
      headers: { "content-type": "application/vnd.apache.parquet" },
    },
  );
  const response = await input.fetch(request);
  if (!response.ok) {
    throw new Error(
      `R2 PUT ${input.bucketName}/${input.key}: ${response.status} ${await response.text()}`,
    );
  }
}

/** Every `*.jsonl` line below `$FLAKE_RECORD_DIR`; the directory exists only once a test recorded. */
async function loadFlakeRecords(directory: string) {
  const files = existsSync(directory) ? await readdir(directory, { recursive: true }) : [];
  const lines = await Promise.all(
    files
      .filter((file) => file.endsWith(".jsonl"))
      .map(async (file) =>
        (await readFile(join(directory, file), "utf8"))
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => FlakeRecord.parse(JSON.parse(line))),
      ),
  );
  return lines.flat();
}

/** The fields a row and the object key need, which a local run's telemetry may not have. */
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

if (isMainModule(import.meta.url)) {
  const flag = (name: string) => {
    const index = process.argv.indexOf(name);
    const value = index === -1 ? undefined : process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
    return value;
  };
  const artifactRoot = resolve(flag("--artifact-root"));
  const { key, rows } = testResultsTable({
    artifacts: (await loadTestTelemetryArtifacts(join(artifactRoot, "raw"))).map(
      ({ artifact }) => artifact,
    ),
    flakeRecords: await loadFlakeRecords(resolve(flag("--flake-records"))),
  });
  const body = testResultsParquet(rows);
  // Beside the raw artifacts, so the job's telemetry upload keeps a queryable copy too.
  await writeFile(join(artifactRoot, "test-results.parquet"), body);
  console.log(`[test-results-parquet] ${rows.length} rows, ${body.byteLength} bytes`);
  if (process.argv.includes("--upload")) {
    const { TEST_RESULTS_R2_ACCESS_KEY_ID, TEST_RESULTS_R2_SECRET_ACCESS_KEY } = process.env;
    if (!TEST_RESULTS_R2_ACCESS_KEY_ID || !TEST_RESULTS_R2_SECRET_ACCESS_KEY) {
      throw new Error(
        "--upload needs TEST_RESULTS_R2_ACCESS_KEY_ID and TEST_RESULTS_R2_SECRET_ACCESS_KEY (Doppler _shared/preview)",
      );
    }
    await putTestResultsObject({
      accountId: testResultsEnvs.ci.cloudflareAccountId,
      bucketName: testResultsEnvs.ci.bucketName,
      key,
      body,
      accessKeyId: TEST_RESULTS_R2_ACCESS_KEY_ID,
      secretAccessKey: TEST_RESULTS_R2_SECRET_ACCESS_KEY,
      fetch,
    });
    console.log(`[test-results-parquet] r2://${testResultsEnvs.ci.bucketName}/${key}`);
  }
}
