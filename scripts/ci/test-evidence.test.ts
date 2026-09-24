import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parquetReadObjects } from "hyparquet";
import type { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import {
  TestEvidenceManifest,
  testEvidencePaths,
} from "@iterate-com/shared/test-support/test-evidence";
import { AwsClient } from "aws4fetch";
import { expect, test, vi } from "vitest";
import {
  reportStepFailure,
  testEvidencePrefix,
  testEvidenceSource,
  testEvidenceTableKey,
  testEvidenceUploadedPrefix,
  uploadTestEvidence,
  uploadedSummaryLine,
  writeTestEvidence,
} from "./test-evidence.ts";

const depotJobUrl =
  "https://depot.dev/orgs/0p91s0lz49/workflows/ntb262kdvq?job=jcc9z1d62z&attempt=1nxc464grh";
/** A Preview OS e2e job attempt's environment, as Depot and the workflow set it. */
const environment = {
  DEPOT_JOB_URL: depotJobUrl,
  GITHUB_REPOSITORY: "iterate/iterate",
  GITHUB_WORKFLOW: "Preview OS",
  GITHUB_RUN_ID: "151191957946117",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "e2e",
  GITHUB_WORKSPACE: "/home/runner/work/iterate/iterate",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REF: "refs/pull/2981/merge",
  GITHUB_ACTOR: "jonastemplestein",
  TEST_TELEMETRY_BRANCH: "feature",
  TEST_TELEMETRY_HEAD_SHA: "0a17015917f0",
  TEST_TELEMETRY_PULL_REQUEST_NUMBER: "2981",
  TEST_EVIDENCE_STEPS: "e2e=success",
};
const commit = "c".repeat(40);
const source = { commit, tree: "7".repeat(40), dirty: false, lockfileSha256: "1".repeat(64) };
const toolchain = { node: "v24.8.0", platform: "linux", arch: "x64" };
/** The telemetry finalizer's check (upload-test-telemetry.ts) when nothing is missing. */
const completeCheck = {
  artifactCount: 2,
  cancelled: false,
  expectedWorkspaces: ["iterate-root", "os"],
  foreignArtifactIds: [],
  incompleteArtifactIds: [],
  missingWorkspaces: [],
  observedWorkspaces: ["iterate-root", "os"],
  artifacts: [],
};
const target = {
  previewName: "draft-test-telemetry-parquet",
  url: "https://draft-test-telemetry-parquet-os.iterate-preview.workers.dev",
  deploymentId: "5b1c7e0e-6f7b-4a45-9a37-1f2d3c4b5a69",
  apps: [{ name: "notes", url: "https://draft-test-telemetry-parquet-notes.workers.dev" }],
  checkedAt: "2026-09-24T07:22:58.000Z",
};

test("writes the tests table, then a manifest: the job attempt from the environment, the result from the test steps and the finalizer's check, the deployed target, and every file with its sha256", async () => {
  using folder = evidenceFolder({
    artifacts: [
      artifact("vitest:os:1", "2026-09-24T07:23:01.000Z", "2026-09-24T07:25:00.000Z"),
      artifact("playwright:iterate-root:1", "2026-09-24T07:22:59.000Z", "2026-09-24T07:24:00.000Z"),
    ],
    check: completeCheck,
    target,
  });

  const manifest = await write(folder.path);

  expect(manifest).toMatchObject({
    manifestSchemaVersion: 1,
    testRunId: "testrun_1nxc464grh",
    createdAt: "2026-09-24T07:26:00.000Z",
    result: "passed",
    source: {
      repository: "iterate/iterate",
      commit,
      tree: source.tree,
      dirty: false,
      headSha: "0a17015917f0",
      branch: "feature",
      pullRequestNumber: 2981,
    },
    runner: {
      provider: "depot",
      trust: "pr",
      ref: "refs/pull/2981/merge",
      workflowName: "Preview OS",
      jobName: "e2e",
      jobId: "jcc9z1d62z",
      jobAttemptId: "1nxc464grh",
      jobUrl: depotJobUrl,
      trigger: "pull_request",
      actor: "jonastemplestein",
    },
    steps: [{ name: "e2e", outcome: "success" }],
    completeness: { missingWorkspaces: [], expectedWorkspaces: ["iterate-root", "os"] },
    target,
    // the first runner's start and the last runner's finish
    timings: { startedAt: "2026-09-24T07:22:59.000Z", finishedAt: "2026-09-24T07:25:00.000Z" },
    // in the order the files sort
    runners: [
      { artifactId: "playwright:iterate-root:1", testCount: 1 },
      { artifactId: "vitest:os:1", suite: "vitest", status: "passed", testCount: 1 },
    ],
    diagnostics: [],
  });
  // sorted, hidden files kept, the manifest itself left out
  expect(manifest.files.map((file) => file.path)).toEqual([
    "ci-telemetry/manifest.json",
    "ci-telemetry/raw/playwright-iterate-root-1.json",
    "ci-telemetry/raw/vitest-os-1.json",
    "flake-records/specs/flake-records-1.jsonl",
    "playwright-output/.last-run.json",
    "playwright-output/os-sign-in/trace.zip",
    "tables/tests.parquet",
    "target.json",
  ]);
  expect(manifest.files).toContainEqual({
    path: "playwright-output/os-sign-in/trace.zip",
    bytes: 5,
    sha256: createHash("sha256").update("trace").digest("hex"),
  });
  const written = TestEvidenceManifest.parse(
    JSON.parse(readFileSync(join(folder.path, testEvidencePaths.manifest), "utf8")),
  );
  expect(written).toEqual(manifest);
  expect(await testsTable(folder.path)).toMatchObject([
    { test_run_id: "testrun_1nxc464grh", full_name: "stream › appends round-trip" },
    { test_run_id: "testrun_1nxc464grh", full_name: "stream › appends round-trip" },
  ]);
});

test("a job whose runners left nothing still gets a manifest, and it says incomplete and why", async () => {
  // setup failed before any reporter started: no telemetry, and the finalizer never ran
  using folder = evidenceFolder({ artifacts: [] });

  const manifest = await write(folder.path, {
    environment: { ...environment, TEST_EVIDENCE_STEPS: "e2e=skipped" },
  });

  expect(manifest).toMatchObject({
    testRunId: "testrun_1nxc464grh",
    result: "incomplete",
    steps: [{ name: "e2e", outcome: "skipped" }],
    runners: [],
    diagnostics: [expect.stringMatching(/^the telemetry finalizer's check: ENOENT/u)],
  });
  expect(manifest.timings).toBeUndefined();
  expect(manifest.completeness).toBeUndefined();
  // an empty table, every column still there
  expect(await testsTable(folder.path)).toEqual([]);
});

test.for([
  {
    name: "a failed step whose failure no runner reported (Kit's CTest) fails the run",
    steps: "tests=success kit-host-tests=failure",
    check: completeCheck,
    result: "failed",
  },
  {
    name: "a runner the finalizer found missing makes the run incomplete, not failed",
    steps: "tests=failure kit-host-tests=success",
    check: { ...completeCheck, missingWorkspaces: ["@iterate-com/shared"] },
    result: "incomplete",
  },
  {
    name: "a cancelled job is cancelled, whatever ran",
    steps: "tests=cancelled kit-host-tests=skipped",
    check: completeCheck,
    cancelled: true,
    result: "cancelled",
  },
  {
    name: "no step outcomes is incomplete: the result cannot see the steps",
    steps: undefined,
    check: completeCheck,
    result: "incomplete",
  },
])("$name", async ({ steps, check, cancelled, result }) => {
  using folder = evidenceFolder({
    artifacts: [artifact("vitest:os:1", "2026-09-24T07:23:01.000Z", "2026-09-24T07:25:00.000Z")],
    check,
  });
  const manifest = await write(folder.path, {
    environment: { ...environment, TEST_EVIDENCE_STEPS: steps },
    cancelled: cancelled ?? false,
  });
  expect(manifest).toMatchObject({ result });
});

test("what cannot be read or matched is a diagnostic; the table and the manifest are still written", async () => {
  const retried = artifact("vitest:os:0", "2026-09-24T07:20:01.000Z", "2026-09-24T07:21:00.000Z");
  retried.ci = { ...retried.ci, depotJobUrl: depotJobUrl.replace("1nxc464grh", "0earlier") };
  using folder = evidenceFolder({
    artifacts: [
      artifact("vitest:os:1", "2026-09-24T07:23:01.000Z", "2026-09-24T07:25:00.000Z"),
      retried,
    ],
    check: completeCheck,
    flakeRecords: `${JSON.stringify({
      name: "a test that was renamed",
      kind: "failing",
      outcome: "pinned-fail",
      pattern: "boom",
      durationMs: 1,
      at: "2026-09-24T07:24:00.000Z",
    })}\n`,
  });

  const manifest = await write(folder.path);

  expect(manifest).toMatchObject({
    runners: [{ artifactId: "vitest:os:1" }],
    diagnostics: [
      "test telemetry from another job attempt, left out of the rows: vitest:os:0",
      'The failing record "a test that was renamed" names 0 expected-fail tests in this job attempt, not 1; it is on no row',
    ],
  });
  expect(await testsTable(folder.path)).toHaveLength(1);
});

test("keys a run's folder by trust, the day its manifest was written and its Depot job, each a claim of the job's OIDC token", async () => {
  using folder = evidenceFolder({ artifacts: [] });
  const late = new Date("2026-09-24T00:06:00.000Z");
  const pullRequest = await write(folder.path, { createdAt: late });
  expect(testEvidencePrefix(pullRequest)).toBe(
    "evidence/ci/trust=pr/date=2026-09-24/job=jcc9z1d62z/testrun_1nxc464grh/",
  );
  expect(testEvidenceTableKey(pullRequest)).toBe(
    "tables/tests/trust=pr/date=2026-09-24/job=jcc9z1d62z/testrun_1nxc464grh.parquet",
  );

  const onMain = {
    ...environment,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    TEST_TELEMETRY_HEAD_SHA: commit,
  };
  const mainPush = await write(folder.path, { environment: onMain });
  expect(testEvidencePrefix(mainPush)).toMatch(/^evidence\/ci\/trust=main\//u);
  // a dispatch on main can be told to test anything (Preview OS's pull-request-number)
  const dispatch = await write(folder.path, {
    environment: { ...onMain, GITHUB_EVENT_NAME: "workflow_dispatch" },
  });
  expect(testEvidencePrefix(dispatch)).toMatch(/^evidence\/ci\/trust=pr\//u);
});

test.for([
  { name: "files changed on disk", source: { ...source, dirty: true }, headSha: commit },
  { name: "another commit checked out", source, headSha: "d".repeat(40) },
])(
  "a push to main whose tested tree is not the pushed commit's ($name, as `depot ci run` patches a laptop's changes in) is filed as pr, and the manifest says why",
  async ({ source: tested, headSha }) => {
    using folder = evidenceFolder({ artifacts: [] });
    const manifest = await write(folder.path, {
      source: tested,
      environment: {
        ...environment,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        TEST_TELEMETRY_HEAD_SHA: headSha,
      },
    });
    expect(manifest).toMatchObject({ runner: { trust: "pr" } });
    expect(manifest.diagnostics).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^filed as trust=pr: a push on refs/heads/main, but the tested tree is not commit ${headSha}'s`,
          "u",
        ),
      ),
    );
  },
);

test("a job with no Depot job attempt has no test run to file evidence under", async () => {
  using folder = evidenceFolder({ artifacts: [] });
  await expect(
    write(folder.path, { environment: { ...environment, DEPOT_JOB_URL: undefined } }),
  ).rejects.toThrow("depotJobUrl");
  expect(existsSync(join(folder.path, testEvidencePaths.manifest))).toBe(false);
});

const bucket = { accountId: "376ef7ed81b0573f93524de763666c15", bucketName: "iterate-ci" };
/** Doppler _shared/preview's CLOUDFLARE_API_TOKEN, and the id Cloudflare's token check answers for it. */
const apiToken = "cf-api-token";
const apiTokenId = "0123456789abcdef0123456789abcdef";

test("PUTs every listed file write-once with its manifest sha256 as the signed payload hash, then the manifest, then the table's copy for the loader, with the API token as S3 keys", async () => {
  using folder = evidenceFolder({
    artifacts: [artifact("vitest:os:1", "2026-09-24T07:23:01.000Z", "2026-09-24T07:25:00.000Z")],
    check: completeCheck,
  });
  const manifest = await write(folder.path);
  const api = cloudflare();

  const uploaded = await uploadTestEvidence({ repoRoot: folder.path, ...bucket, apiToken, ...api });

  const { prefix, tableKey } = uploaded;
  const requests = api.r2Requests();
  const urls = requests.map((request) => new URL(request.url));
  expect(new Set(urls.map((url) => url.host))).toEqual(
    new Set(["376ef7ed81b0573f93524de763666c15.r2.cloudflarestorage.com"]),
  );
  const keys = urls.map((url) => decodeURIComponent(url.pathname));
  // the files in parallel, in any order; the table's copy for the loader; the manifest last, the
  // commit point for both
  expect(keys.slice(0, -2).sort()).toEqual(
    manifest.files.map((file) => `/iterate-ci/${prefix}${file.path}`),
  );
  expect(keys.slice(-2)).toEqual([`/iterate-ci/${tableKey}`, `/iterate-ci/${prefix}manifest.json`]);
  expect(prefix).toBe("evidence/ci/trust=pr/date=2026-09-24/job=jcc9z1d62z/testrun_1nxc464grh/");
  const table = manifest.files.find((file) => file.path === "tables/tests.parquet")!;
  const manifestBytes = readFileSync(join(folder.path, testEvidencePaths.manifest)).byteLength;
  expect(uploaded).toMatchObject({
    objects: manifest.files.length + 2,
    bytes:
      manifest.files.reduce((total, file) => total + file.bytes, 0) + table.bytes + manifestBytes,
    retries: 0,
  });
  // `=` is sent percent-encoded, as S3 clients sign it; R2 stores it decoded (measured 2026-09-24)
  expect(urls[0]!.pathname).toContain("/trust%3Dpr/date%3D2026-09-24/");
  const trace = requests.find((request) => request.url.endsWith("trace.zip"))!;
  expect(trace).toMatchObject({ method: "PUT" });
  expect(Object.fromEntries(trace.headers)).toMatchObject({
    "content-type": "application/zip",
    "if-none-match": "*",
    "x-amz-content-sha256": createHash("sha256").update("trace").digest("hex"),
  });
  expect(new TextDecoder().decode(await trace.arrayBuffer())).toBe("trace");
  // the access key is the token's id and the secret the token's SHA-256: signed again with those,
  // at the same instant, the request carries the same signature
  const resigned = await new AwsClient({
    accessKeyId: apiTokenId,
    secretAccessKey: createHash("sha256").update(apiToken).digest("hex"),
    service: "s3",
    region: "auto",
  }).sign(trace.url, {
    method: "PUT",
    body: "trace",
    headers: {
      "content-type": "application/zip",
      "if-none-match": "*",
      "x-amz-content-sha256": trace.headers.get("x-amz-content-sha256")!,
    },
    aws: { datetime: trace.headers.get("x-amz-date")! },
  });
  expect(trace.headers.get("authorization")).toBe(resigned.headers.get("authorization"));
  expect(trace.headers.get("authorization")).toMatch(
    new RegExp(`^AWS4-HMAC-SHA256 Credential=${apiTokenId}/\\d{8}/auto/s3/aws4_request, `),
  );
  expect(requests.at(-2)!.headers.get("content-type")).toBe("application/vnd.apache.parquet");
  expect(requests.at(-1)!.headers.get("content-type")).toBe("application/json");
});

test("a cancelled run's folder is uploaded without a copy of its tests table, whose rows stop part way", async () => {
  using folder = evidenceFolder({
    artifacts: [artifact("vitest:os:1", "2026-09-24T07:23:01.000Z", "2026-09-24T07:25:00.000Z")],
    check: completeCheck,
  });
  const manifest = await write(folder.path, { cancelled: true });
  const api = cloudflare();

  const uploaded = await uploadTestEvidence({ repoRoot: folder.path, ...bucket, apiToken, ...api });

  expect(manifest).toMatchObject({ result: "cancelled" });
  expect(uploaded).toMatchObject({ tableKey: undefined, objects: manifest.files.length + 1 });
  const keys = api.r2Requests().map((request) => decodeURIComponent(new URL(request.url).pathname));
  expect(keys.filter((key) => key.includes("/tables/tests/"))).toEqual([]);
  expect(keys.at(-1)).toBe(`/iterate-ci/${uploaded.prefix}manifest.json`);
});

test("a Cloudflare 5xx, 429 or dropped connection is retried, each retry a platform-failure warn, and the upload completes", async () => {
  using folder = evidenceFolder({ artifacts: [], check: completeCheck });
  await write(folder.path);
  const failures = [
    new Response("<Error><Code>InternalError</Code></Error>", { status: 503 }),
    new Response("slow down", { status: 429, headers: { "retry-after": "60" } }),
    new TypeError("fetch failed", { cause: new Error("ECONNRESET") }),
  ];
  const api = cloudflare((request) => {
    if (!request.url.endsWith("trace.zip") || failures.length === 0) return ok();
    const failure = failures.shift()!;
    if (failure instanceof Error) throw failure;
    return failure;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const uploaded = await uploadTestEvidence({ repoRoot: folder.path, ...bucket, apiToken, ...api });

  expect(uploaded).toMatchObject({ retries: 3 });
  expect(api.r2Requests().filter((request) => request.url.endsWith("trace.zip"))).toHaveLength(4);
  // 1 s, then the 429's Retry-After capped at 5 s, then 4 s
  expect(api).toMatchObject({ waits: [1000, 5000, 4000] });
  expect(warn.mock.calls.map(([entry]) => entry)).toEqual([
    expect.objectContaining({
      event: "test-evidence.platform-failure-retry",
      request: expect.stringMatching(/^PUT evidence\/ci\/.*\/trace\.zip$/u),
      attempt: 1,
      status: 503,
    }),
    expect.objectContaining({ attempt: 2, status: 429, waitMs: 5000 }),
    expect.objectContaining({ attempt: 3, answer: "fetch failed: ECONNRESET" }),
  ]);
  warn.mockRestore();
});

test("the retries are bounded: a Cloudflare 5xx that persists fails the upload, and the manifest never lands", async () => {
  using folder = evidenceFolder({ artifacts: [], check: completeCheck });
  await write(folder.path);
  const api = cloudflare((request) =>
    request.url.endsWith("trace.zip") ? new Response("down", { status: 500 }) : ok(),
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await expect(
    uploadTestEvidence({ repoRoot: folder.path, ...bucket, apiToken, ...api }),
  ).rejects.toThrow(/trace\.zip: 500 down \(after 3 retries\)$/u);
  expect(api.r2Requests().filter((request) => request.url.endsWith("trace.zip"))).toHaveLength(4);
  expect(warn).toHaveBeenCalledTimes(3);
  expect(
    api.requests.some((request) => request.url.endsWith("/testrun_1nxc464grh/manifest.json")),
  ).toBe(false);
  warn.mockRestore();
});

test("no retry starts after the upload's deadline, and the manifest never lands", async () => {
  using folder = evidenceFolder({ artifacts: [], check: completeCheck });
  await write(folder.path);
  const deadline = new AbortController();
  const api = cloudflare((request) => {
    if (!request.url.endsWith("trace.zip")) return ok();
    // the deadline passes while R2 answers the first try
    deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
    return new Response("down", { status: 503 });
  });

  await expect(
    uploadTestEvidence({
      repoRoot: folder.path,
      ...bucket,
      apiToken,
      ...api,
      deadline: deadline.signal,
    }),
  ).rejects.toThrow(/trace\.zip: 503 down \(after 0 retries\)$/u);
  expect(api).toMatchObject({ waits: [] });
  expect(
    api.requests.some((request) => request.url.endsWith("/testrun_1nxc464grh/manifest.json")),
  ).toBe(false);
});

test("a key that exists (412) is this upload's own when it holds the same bytes, and a refusal otherwise; a 4xx is never retried", async () => {
  using folder = evidenceFolder({ artifacts: [], check: completeCheck });
  await write(folder.path);
  const existing = (etag: string) =>
    cloudflare((request) => {
      if (!request.url.endsWith("trace.zip")) return ok();
      if (request.method === "HEAD") return new Response(null, { status: 200, headers: { etag } });
      return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
    });

  // as R2 answered a HEAD of a JSON object on 2026-09-24: weak, since its edge gzips JSON
  const same = existing(`W/"${md5("trace")}"`);
  await uploadTestEvidence({ repoRoot: folder.path, ...bucket, apiToken, ...same });
  expect(
    same.requests.some((request) => request.url.endsWith("/testrun_1nxc464grh/manifest.json")),
  ).toBe(true);

  const other = existing(`"${md5("another run's trace")}"`);
  await expect(
    uploadTestEvidence({ repoRoot: folder.path, ...bucket, apiToken, ...other }),
  ).rejects.toThrow(/trace\.zip: 412 <Error><Code>PreconditionFailed<\/Code><\/Error>$/u);
  expect(
    other.requests.some((request) => request.url.endsWith("/testrun_1nxc464grh/manifest.json")),
  ).toBe(false);

  const forbidden = cloudflare((request) =>
    request.url.endsWith("trace.zip") ? new Response("AccessDenied", { status: 403 }) : ok(),
  );
  await expect(
    uploadTestEvidence({ repoRoot: folder.path, ...bucket, apiToken, ...forbidden }),
  ).rejects.toThrow(/trace\.zip: 403 AccessDenied$/u);
  expect(
    forbidden.r2Requests().filter((request) => request.url.endsWith("trace.zip")),
  ).toHaveLength(1);
  expect(forbidden).toMatchObject({ waits: [] });
});

test("a token Cloudflare does not verify sends nothing to R2", async () => {
  using folder = evidenceFolder({ artifacts: [], check: completeCheck });
  await write(folder.path);
  const api = cloudflare();

  await expect(
    uploadTestEvidence({ repoRoot: folder.path, ...bucket, apiToken: "revoked", ...api }),
  ).rejects.toThrow(
    "CLOUDFLARE_API_TOKEN did not verify (/user/tokens/verify: 401, /accounts/376ef7ed81b0573f93524de763666c15/tokens/verify: 401)",
  );
  expect(api.requests.map((request) => new URL(request.url).host)).toEqual([
    "api.cloudflare.com",
    "api.cloudflare.com",
  ]);
});

test("a file that changed after the manifest listed it is never sent, and the manifest never lands", async () => {
  using folder = evidenceFolder({ artifacts: [], check: completeCheck });
  await write(folder.path);
  writeFileSync(
    join(folder.path, testEvidencePaths.playwrightOutput, "os-sign-in/trace.zip"),
    "later",
  );
  const api = cloudflare();

  await expect(
    uploadTestEvidence({ repoRoot: folder.path, ...bucket, apiToken, ...api }),
  ).rejects.toThrow("playwright-output/os-sign-in/trace.zip changed after the manifest listed it");
  expect(api.requests.some((request) => request.url.endsWith("trace.zip"))).toBe(false);
  expect(
    api.requests.some((request) => request.url.endsWith("/testrun_1nxc464grh/manifest.json")),
  ).toBe(false);
});

test("a failed step says why in a warning annotation and a line of the job's summary, and leaves the marker the fallback report looks for", () => {
  using runner = temporaryDirectory("test-evidence-runner-");
  const summary = join(runner.path, "summary.md");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  reportStepFailure({
    command: "upload",
    error: new Error("R2 PUT iterate-ci/evidence/…/trace.zip: 500 down\n100% of tries failed"),
    environment: { GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: runner.path },
  });

  // `%` and line breaks escaped, as the workflow command syntax asks
  expect(log.mock).toMatchObject({
    calls: [
      [
        "::warning title=Test evidence not in R2::R2 PUT iterate-ci/evidence/…/trace.zip: 500 down%0A100%25 of tries failed",
      ],
    ],
  });
  expect(readFileSync(summary, "utf8")).toBe(
    "**Test evidence not in R2**: R2 PUT iterate-ci/evidence/…/trace.zip: 500 down\n100% of tries failed. The tests' result is unaffected.\n",
  );
  expect(existsSync(join(runner.path, "test-evidence-upload.reported"))).toBe(true);
  expect(existsSync(join(runner.path, "test-evidence-write.reported"))).toBe(false);
  log.mockRestore();
});

test("nothing the upload logs or reports carries the API token or the S3 secret derived from it", async () => {
  using folder = evidenceFolder({ artifacts: [], check: completeCheck });
  using runner = temporaryDirectory("test-evidence-runner-");
  await write(folder.path);
  const output: unknown[] = [];
  const spies = (["log", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args) => output.push(...args)),
  );
  const runnerEnvironment = {
    GITHUB_STEP_SUMMARY: join(runner.path, "summary.md"),
    RUNNER_TEMP: runner.path,
  };
  const fails = [
    // retried, then refused
    cloudflare((request) =>
      request.url.endsWith("trace.zip") ? new Response("down", { status: 502 }) : ok(),
    ),
    // a token Cloudflare does not verify
    { ...cloudflare(), fetch: async () => new Response(null, { status: 401 }) },
    // an existing key holding other bytes
    cloudflare((request) =>
      request.url.endsWith("trace.zip")
        ? new Response(null, { status: request.method === "HEAD" ? 200 : 412 })
        : ok(),
    ),
    // no answer at all
    cloudflare((request) => {
      if (request.url.endsWith("trace.zip")) throw new TypeError("fetch failed");
      return ok();
    }),
  ];

  for (const api of fails) {
    const error = await uploadTestEvidence({
      repoRoot: folder.path,
      ...bucket,
      apiToken,
      ...api,
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    reportStepFailure({ command: "upload", error, environment: runnerEnvironment });
    console.error(error);
  }

  const secret = createHash("sha256").update(apiToken).digest("hex");
  const printed = [
    ...output.map((entry) =>
      entry instanceof Error ? `${entry.stack} ${String(entry.cause)}` : JSON.stringify(entry),
    ),
    readFileSync(runnerEnvironment.GITHUB_STEP_SUMMARY, "utf8"),
  ].join("\n");
  expect(printed).toContain("Test evidence not in R2");
  expect(printed).not.toContain(apiToken);
  expect(printed).not.toContain(secret);
  for (const spy of spies) spy.mockRestore();
});

test("the summary line of an uploaded folder names its prefix, which the CI telemetry sync reads back from the job's summary", () => {
  const prefix = "evidence/ci/trust=main/date=2026-09-24/job=7xwfmnl68l/testrun_73zz670w57/";
  const line = uploadedSummaryLine({
    bucketName: "iterate-ci",
    prefix,
    objects: 20,
    bytes: 3_300_000,
    retries: 1,
  });
  expect(line).toBe(
    `Test evidence: \`r2://iterate-ci/${prefix}\` (20 objects, 3300000 bytes, after 1 platform-failure retries)`,
  );
  // Depot joins the job's step summaries in step order
  expect(testEvidenceUploadedPrefix(`## Unit tests\n\n${line}\n`)).toBe(prefix);
  expect(
    testEvidenceUploadedPrefix(
      "**Test evidence not in R2**: R2 PUT iterate-ci/evidence/ci/…: 500. The tests' result is unaffected.\n",
    ),
  ).toBeUndefined();
});

test("the source's tree is the files on disk, changes and new files included, and the index is left alone", async () => {
  using folder = temporaryDirectory("test-evidence-git-");
  const repo = folder.path;
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  writeFileSync(join(repo, ".gitignore"), "test-results/\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "one");

  const clean = await testEvidenceSource(repo);
  expect(clean).toEqual({
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: false,
    lockfileSha256: createHash("sha256").update("lockfileVersion: '9.0'\n").digest("hex"),
  });

  // ignored output changes nothing
  mkdirSync(join(repo, "test-results"));
  writeFileSync(join(repo, "test-results/manifest.json"), "{}");
  expect(await testEvidenceSource(repo)).toEqual(clean);

  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  const dirty = await testEvidenceSource(repo);
  expect(dirty).toMatchObject({ commit: clean.commit, dirty: true });
  expect(dirty).not.toMatchObject({ tree: clean.tree });
  expect(git("ls-tree", "--name-only", dirty.tree).split("\n")).toEqual([
    ".gitignore",
    "a.ts",
    "b.ts",
    "pnpm-lock.yaml",
  ]);
  // nothing staged, and the new file still untracked
  expect(git("diff", "--cached", "--name-only")).toBe("");
  expect(git("ls-files", "--others", "--exclude-standard")).toBe("b.ts");
});

/**
 * Cloudflare as the upload meets it: the API's token check, then R2's S3 endpoint, whose answers
 * `r2` gives (200 by default). Every request is recorded, the token check included.
 */
function cloudflare(r2: (request: Request) => Response | Promise<Response> = () => ok()) {
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    // a user token, as CI's is: its account's check does not know it
    if (request.url === "https://api.cloudflare.com/client/v4/user/tokens/verify")
      return request.headers.get("authorization") === `Bearer ${apiToken}`
        ? Response.json({ success: true, result: { id: apiTokenId, status: "active" } })
        : new Response(null, { status: 401 });
    if (new URL(request.url).host === "api.cloudflare.com")
      return new Response(null, { status: 401 });
    return r2(request);
  };
  const waits: number[] = [];
  return {
    fetch,
    wait: async (ms: number) => {
      waits.push(ms);
    },
    waits,
    requests,
    r2Requests: () => requests.slice(1),
  };
}
const ok = () => new Response(null, { status: 200 });
const md5 = (text: string) => createHash("md5").update(text).digest("hex");

/** The write step, as the Preview OS e2e job runs it, with the parts a test varies. */
function write(repoRoot: string, overrides: Partial<Parameters<typeof writeTestEvidence>[0]> = {}) {
  return writeTestEvidence({
    repoRoot,
    environment,
    cancelled: false,
    source,
    toolchain,
    createdAt: new Date("2026-09-24T07:26:00.000Z"),
    ...overrides,
  });
}

/** A repository root whose test-results/ holds what an e2e job's runners and finalizer leave. */
function evidenceFolder(input: {
  artifacts: TestTelemetryArtifact[];
  check?: object;
  target?: object;
  flakeRecords?: string;
}) {
  const folder = temporaryDirectory("test-evidence-");
  const put = (path: string, contents: string) => {
    mkdirSync(join(folder.path, path, ".."), { recursive: true });
    writeFileSync(join(folder.path, path), contents);
  };
  for (const telemetry of input.artifacts)
    put(
      `${testEvidencePaths.telemetry}/${telemetry.artifactId.replace(/\W+/gu, "-")}.json`,
      JSON.stringify(telemetry),
    );
  if (input.check) put(testEvidencePaths.telemetryCheck, JSON.stringify(input.check));
  if (input.target) put(testEvidencePaths.target, JSON.stringify(input.target));
  put(`${testEvidencePaths.flakeRecords}/specs/flake-records-1.jsonl`, input.flakeRecords || "");
  put(`${testEvidencePaths.playwrightOutput}/.last-run.json`, '{"status":"passed"}');
  put(`${testEvidencePaths.playwrightOutput}/os-sign-in/trace.zip`, "trace");
  return folder;
}

async function testsTable(repoRoot: string) {
  return parquetReadObjects({
    // a copy: a small file's Buffer is a slice of Node's shared pool, so its `.buffer` holds other bytes
    file: new Uint8Array(readFileSync(join(repoRoot, testEvidencePaths.testsTable))).buffer,
  });
}

function temporaryDirectory(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true }) };
}

function artifact(
  artifactId: string,
  startedAt: string,
  finishedAt: string,
): TestTelemetryArtifact {
  return {
    artifactSchemaVersion: 2,
    artifactId,
    producer: "vitest-retry-telemetry-reporter",
    createdAt: finishedAt,
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
    run: { status: "passed", startedAt, finishedAt, durationMs: 1 },
    runners: [],
    tests: [
      {
        fullName: "stream › appends round-trip",
        leafName: "appends round-trip",
        moduleId: "/home/runner/work/iterate/iterate/apps/os/src/stream.test.ts",
        tags: [],
        annotations: [],
        retryCount: 0,
        passedAfterRetry: false,
        state: "passed",
        durationMs: 12.5,
        attemptDetail: "aggregate-only",
        attempts: [],
        phases: [],
        errors: [],
      },
    ],
    modules: [],
  };
}
