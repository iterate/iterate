import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parquetMetadata, parquetReadObjects, parquetSchema } from "hyparquet";
import type {
  TestTelemetryArtifact,
  TestTelemetryRecord,
} from "@iterate-com/shared/test-support/ci-telemetry";
import { expect, test } from "vitest";
import { ciJobAttempt, testResultsParquet, testResultsTable } from "./test-results-parquet.ts";

const depotJobUrl =
  "https://depot.dev/orgs/0p91s0lz49/workflows/ntb262kdvq?job=jcc9z1d62z&attempt=1nxc464grh";
/** The job attempt's environment, as Depot and the workflow set it. */
const environment = {
  DEPOT_JOB_URL: depotJobUrl,
  GITHUB_REPOSITORY: "iterate/iterate",
  GITHUB_WORKFLOW: "Preview OS",
  GITHUB_RUN_ID: "151191957946117",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "e2e",
  GITHUB_WORKSPACE: "/home/runner/work/iterate/iterate",
  TEST_TELEMETRY_BRANCH: "feature",
  TEST_TELEMETRY_HEAD_SHA: "0a17015917f0",
  TEST_TELEMETRY_PULL_REQUEST_NUMBER: "2981",
};
const job = ciJobAttempt(environment);

const plainTest: TestTelemetryRecord = {
  fullName: "stream › appends round-trip",
  leafName: "appends round-trip",
  moduleId: "/home/runner/work/iterate/iterate/apps/os/src/stream.test.ts",
  expectedState: "passed",
  tags: [],
  annotations: [],
  retryCount: 1,
  passedAfterRetry: true,
  state: "passed",
  durationMs: 12.5,
  startedAt: "2026-09-24T07:23:05.700Z",
  attemptDetail: "complete",
  attempts: [
    {
      attemptIndex: 0,
      state: "failed",
      durationMs: 5,
      phases: [{ name: "Before Hooks", durationMs: 1 }],
      error: { message: "socket closed", stack: "at x" },
    },
    { attemptIndex: 1, state: "passed", durationMs: 7.5, phases: [] },
  ],
  phases: [],
  errors: [{ message: "socket closed" }],
  firstFailure: "socket closed",
};

const pinnedTest: TestTelemetryRecord = {
  ...plainTest,
  fullName: "stream › the echo fits the RPC cap",
  leafName: "the echo fits the RPC cap",
  expectedState: "failed",
  retryCount: 0,
  passedAfterRetry: false,
  attempts: [],
  errors: [],
  firstFailure: undefined,
  tags: ["@slow"],
};

const pinnedRecord = {
  name: "the echo fits the RPC cap",
  kind: "failing",
  outcome: "pinned-fail",
  pattern: "the echo should fit",
  durationMs: 484,
  at: "2026-09-24T07:23:21.371Z",
} as const;

test("one row per test, each carrying its test run and job attempt", () => {
  const { rows, problems } = testResultsTable({
    job,
    artifacts: [artifact()],
    flakeRecords: [
      pinnedRecord,
      { ...pinnedRecord, outcome: "unexpected-error" },
      // restates the plain test's retry, which its row already carries
      {
        name: "appends round-trip",
        kind: "unknown",
        outcome: "retried-pass",
        durationMs: 12,
        at: "",
      },
    ],
  });

  expect(rows).toMatchObject([
    {
      test_run_id: "testrun_1nxc464grh",
      job_attempt_id: "1nxc464grh",
      module_path: "apps/os/src/stream.test.ts",
      retry_count: 1,
      passed_after_retry: true,
      started_at: new Date("2026-09-24T07:23:05.700Z"),
      attempts: [
        { attemptIndex: 0, state: "failed", durationMs: 5, error: "socket closed" },
        { attemptIndex: 1, state: "passed", durationMs: 7.5 },
      ],
      flake_kind: null,
      flake_outcomes: null,
    },
    {
      full_name: "stream › the echo fits the RPC cap",
      tags: ["@slow"],
      flake_kind: "failing",
      flake_pattern: "the echo should fit",
      flake_outcomes: ["pinned-fail", "unexpected-error"],
    },
  ]);
  expect(problems).toEqual([]);
});

test("a flake record that names no expected-fail test is a problem to report, and on no row", () => {
  const { rows, problems } = testResultsTable({
    job,
    artifacts: [artifact()],
    flakeRecords: [{ ...pinnedRecord, name: "appends round-trip" }],
  });
  expect(problems).toEqual([
    'The failing record "appends round-trip" names 0 expected-fail tests in this job attempt, not 1; it is on no row',
  ]);
  expect(rows.map((row) => row.flake_kind)).toEqual([null, null]);
});

test("the job attempt comes from the environment: Depot's job and attempt ids, and the test run named for the attempt", () => {
  expect(job).toMatchObject({
    testRunId: "testrun_1nxc464grh",
    jobId: "jcc9z1d62z",
    jobAttemptId: "1nxc464grh",
    workflowName: "Preview OS",
    jobName: "e2e",
    headSha: "0a17015917f0",
    pullRequestNumber: 2981,
  });
});

test("a laptop, with no Depot job, is not a CI job attempt", () => {
  expect(() => ciJobAttempt({ ...environment, DEPOT_JOB_URL: undefined })).toThrow("depotJobUrl");
  expect(() =>
    ciJobAttempt({
      ...environment,
      DEPOT_JOB_URL: "https://depot.dev/orgs/0p91s0lz49/workflows/x",
    }),
  ).toThrow("DEPOT_JOB_URL names no job and attempt");
});

test("round-trips typed values, with JSON columns as values rather than strings", async () => {
  const { rows } = testResultsTable({
    job,
    artifacts: [artifact()],
    flakeRecords: [pinnedRecord],
  });
  const file = testResultsParquet(rows).buffer as ArrayBuffer;

  const read = await parquetReadObjects({ file });
  expect(read).toHaveLength(2);
  expect(read[0]).toMatchObject({
    pull_request_number: 2981,
    duration_ms: 12.5,
    started_at: new Date("2026-09-24T07:23:05.700Z"),
    errors: [{ message: "socket closed" }],
  });
  expect(read[1]).toMatchObject({ flake_outcomes: ["pinned-fail"], tags: ["@slow"] });
});

test("a job attempt whose runners reported no tests still writes every column", () => {
  const empty = testResultsParquet([]);
  const withRows = testResultsParquet(
    testResultsTable({ job, artifacts: [artifact()], flakeRecords: [] }).rows,
  );
  const columns = (bytes: Uint8Array) =>
    parquetSchema(parquetMetadata(bytes.buffer as ArrayBuffer)).children.map(({ element }) => [
      element.name,
      element.type,
      element.converted_type,
    ]);

  expect(columns(empty)).toEqual(columns(withRows));
});

test("docs/test-evidence.md describes every column", () => {
  const doc = readFileSync(resolve(import.meta.dirname, "../../docs/test-evidence.md"), "utf8");
  const bytes = testResultsParquet([]);
  const names = parquetSchema(parquetMetadata(bytes.buffer as ArrayBuffer)).children.map(
    ({ element }) => element.name,
  );
  expect(names.filter((name) => !doc.includes(`| \`${name}\``))).toEqual([]);
});

function artifact(overrides: Partial<TestTelemetryArtifact> = {}): TestTelemetryArtifact {
  return {
    artifactSchemaVersion: 2,
    artifactId: "vitest:os:1",
    producer: "vitest-retry-telemetry-reporter",
    createdAt: "2026-09-24T07:25:00.000Z",
    ci: {
      repository: "iterate/iterate",
      headSha: "0a17015917f0",
      branch: "feature",
      pullRequestNumber: 2981,
      workflowName: "Preview OS",
      workflowRunId: "151191957946117",
      workflowRunAttempt: "1",
      jobName: "e2e",
      workspaceRoot: "/home/runner/work/iterate/iterate",
      runnerProvider: "depot",
      depotJobUrl,
      executionContext: "ci",
    },
    context: { framework: "vitest", testKind: "e2e", suite: "vitest", workspace: "os" },
    run: {
      status: "passed",
      startedAt: "2026-09-24T07:23:01.000Z",
      finishedAt: "2026-09-24T07:25:00.000Z",
      durationMs: 119_000,
    },
    runners: [],
    tests: [plainTest, pinnedTest],
    modules: [],
    ...overrides,
  };
}
