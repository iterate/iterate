import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parquetMetadata, parquetReadObjects, parquetSchema } from "hyparquet";
import type {
  TestTelemetryArtifact,
  TestTelemetryRecord,
} from "@iterate-com/shared/test-support/ci-telemetry";
import { expect, test } from "vitest";
import {
  putTestResultsObject,
  testResultsParquet,
  testResultsTable,
} from "./test-results-parquet.ts";

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

test("one row per test, keyed by the job attempt under date and workflow partitions", () => {
  const { key, rows } = testResultsTable({
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

  expect(key).toBe("date=2026-09-24/workflow=preview-os/151191957946117-e2e-1nxc464grh.parquet");
  expect(rows).toMatchObject([
    {
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
});

test("a flake record that names no expected-fail test fails the writer instead of vanishing", () => {
  expect(() =>
    testResultsTable({
      artifacts: [artifact()],
      flakeRecords: [{ ...pinnedRecord, name: "appends round-trip" }],
    }),
  ).toThrow('The failing record "appends round-trip" names 0 expected-fail tests');
});

test("an artifact from another job attempt is refused", () => {
  const retried = artifact({ artifactId: "vitest:os:2" });
  retried.ci = {
    ...retried.ci,
    depotJobUrl: retried.ci.depotJobUrl!.replace("1nxc464grh", "2abc"),
  };
  expect(() => testResultsTable({ artifacts: [artifact(), retried], flakeRecords: [] })).toThrow(
    "vitest:os:2 belongs to",
  );
});

test("local telemetry, with no Depot job, has no key to write under", () => {
  const local = artifact();
  local.ci = { ...local.ci, depotJobUrl: undefined, executionContext: "local" };
  expect(() => testResultsTable({ artifacts: [local], flakeRecords: [] })).toThrow("depotJobUrl");
});

test("round-trips typed values, with JSON columns as values rather than strings", async () => {
  const { rows } = testResultsTable({ artifacts: [artifact()], flakeRecords: [pinnedRecord] });
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
    testResultsTable({ artifacts: [artifact()], flakeRecords: [] }).rows,
  );
  const columns = (bytes: Uint8Array) =>
    parquetSchema(parquetMetadata(bytes.buffer as ArrayBuffer)).children.map(({ element }) => [
      element.name,
      element.type,
      element.converted_type,
    ]);

  expect(columns(empty)).toEqual(columns(withRows));
});

test("docs/test-results-parquet.md describes every column", () => {
  const doc = readFileSync(
    resolve(import.meta.dirname, "../../docs/test-results-parquet.md"),
    "utf8",
  );
  const bytes = testResultsParquet([]);
  const names = parquetSchema(parquetMetadata(bytes.buffer as ArrayBuffer)).children.map(
    ({ element }) => element.name,
  );
  expect(names.filter((name) => !doc.includes(`| \`${name}\``))).toEqual([]);
});

const upload = {
  accountId: "376ef7ed81b0573f93524de763666c15",
  bucketName: "ci-test-results",
  key: "date=2026-09-24/workflow=test/1-test-a.parquet",
  body: new Uint8Array([80, 65, 82, 49]),
  accessKeyId: "key-id",
  secretAccessKey: "secret",
};

test("PUTs to the bucket's S3 endpoint, SigV4-signed for region auto", async () => {
  const requests: Request[] = [];
  await putTestResultsObject({
    ...upload,
    fetch: async (request) => {
      requests.push(request as Request);
      return new Response(null, { status: 200 });
    },
  });

  expect(requests).toHaveLength(1);
  const [request] = requests;
  expect(request!).toMatchObject({
    method: "PUT",
    url: "https://376ef7ed81b0573f93524de763666c15.r2.cloudflarestorage.com/ci-test-results/date=2026-09-24/workflow=test/1-test-a.parquet",
  });
  expect(request!.headers.get("content-type")).toBe("application/vnd.apache.parquet");
  expect(request!.headers.get("authorization")).toMatch(
    /^AWS4-HMAC-SHA256 Credential=key-id\/\d{8}\/auto\/s3\/aws4_request, /,
  );
  expect(new Uint8Array(await request!.arrayBuffer())).toEqual(upload.body);
});

test("a failed PUT fails with R2's answer, without retrying", async () => {
  let calls = 0;
  await expect(
    putTestResultsObject({
      ...upload,
      fetch: async () => {
        calls++;
        return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
      },
    }),
  ).rejects.toThrow(
    "R2 PUT ci-test-results/date=2026-09-24/workflow=test/1-test-a.parquet: 500 <Error><Code>InternalError</Code></Error>",
  );
  expect(calls).toBe(1);
});

function artifact(overrides: Partial<TestTelemetryArtifact> = {}): TestTelemetryArtifact {
  return {
    artifactSchemaVersion: 1,
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
      depotJobUrl:
        "https://depot.dev/orgs/0p91s0lz49/workflows/ntb262kdvq?job=jcc9z1d62z&attempt=1nxc464grh",
      executionContext: "ci",
    },
    context: { framework: "vitest", testKind: "e2e", lane: "vitest", workspace: "os" },
    run: {
      status: "passed",
      startedAt: "2026-09-24T07:23:01.000Z",
      finishedAt: "2026-09-24T07:25:00.000Z",
      durationMs: 119_000,
    },
    lanes: [],
    tests: [plainTest, pinnedTest],
    modules: [],
    ...overrides,
  };
}
