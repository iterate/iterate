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
import { expect, test } from "vitest";
import {
  testEvidencePrefix,
  testEvidenceSource,
  testEvidenceTableKey,
  uploadTestEvidence,
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
    "ci/trust=pr/date=2026-09-24/job=jcc9z1d62z/testrun_1nxc464grh/",
  );
  expect(testEvidenceTableKey(pullRequest)).toBe(
    "tables/tests/trust=pr/date=2026-09-24/job=jcc9z1d62z/testrun_1nxc464grh.parquet",
  );

  const mainPush = await write(folder.path, {
    environment: { ...environment, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" },
  });
  expect(testEvidencePrefix(mainPush)).toMatch(/^ci\/trust=main\//u);
  // a dispatch on main can be told to test anything (Preview OS's pull-request-number)
  const dispatch = await write(folder.path, {
    environment: {
      ...environment,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
    },
  });
  expect(testEvidencePrefix(dispatch)).toMatch(/^ci\/trust=pr\//u);
});

test("a job with no Depot job attempt has no test run to file evidence under", async () => {
  using folder = evidenceFolder({ artifacts: [] });
  await expect(
    write(folder.path, { environment: { ...environment, DEPOT_JOB_URL: undefined } }),
  ).rejects.toThrow("depotJobUrl");
  expect(existsSync(join(folder.path, testEvidencePaths.manifest))).toBe(false);
});

const credentials = {
  accountId: "376ef7ed81b0573f93524de763666c15",
  bucketName: "ci-test-evidence",
  accessKeyId: "key-id",
  secretAccessKey: "secret",
};

test("PUTs every listed file write-once with its manifest sha256 as the signed payload hash, then the manifest, then the table's copy for the loader", async () => {
  using folder = evidenceFolder({
    artifacts: [artifact("vitest:os:1", "2026-09-24T07:23:01.000Z", "2026-09-24T07:25:00.000Z")],
    check: completeCheck,
  });
  const manifest = await write(folder.path);
  const requests: Request[] = [];

  const { prefix, tableKey } = await uploadTestEvidence({
    repoRoot: folder.path,
    ...credentials,
    fetch: async (request) => {
      requests.push(request as Request);
      return new Response(null, { status: 200 });
    },
  });

  const urls = requests.map((request) => new URL(request.url));
  expect(new Set(urls.map((url) => url.host))).toEqual(
    new Set(["376ef7ed81b0573f93524de763666c15.r2.cloudflarestorage.com"]),
  );
  const keys = urls.map((url) => decodeURIComponent(url.pathname));
  // the files in parallel, in any order; the manifest alone; the table's copy last
  expect(keys.slice(0, -2).sort()).toEqual(
    manifest.files.map((file) => `/ci-test-evidence/${prefix}${file.path}`),
  );
  expect(keys.slice(-2)).toEqual([
    `/ci-test-evidence/${prefix}manifest.json`,
    `/ci-test-evidence/${tableKey}`,
  ]);
  expect(prefix).toBe("ci/trust=pr/date=2026-09-24/job=jcc9z1d62z/testrun_1nxc464grh/");
  // `=` is sent percent-encoded, as S3 clients sign it; R2 decodes it back into the key
  expect(urls[0]!.pathname).toContain("/trust%3Dpr/date%3D2026-09-24/");
  const trace = requests.find((request) => request.url.endsWith("trace.zip"))!;
  expect(trace).toMatchObject({ method: "PUT" });
  expect(Object.fromEntries(trace.headers)).toMatchObject({
    "content-type": "application/zip",
    "if-none-match": "*",
    "x-amz-content-sha256": createHash("sha256").update("trace").digest("hex"),
  });
  expect(trace.headers.get("authorization")).toMatch(
    /^AWS4-HMAC-SHA256 Credential=key-id\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[^,]*if-none-match[^,]*x-amz-content-sha256/,
  );
  expect(new TextDecoder().decode(await trace.arrayBuffer())).toBe("trace");
  expect(requests.at(-2)!.headers.get("content-type")).toBe("application/json");
  expect(requests.at(-1)!.headers.get("content-type")).toBe("application/vnd.apache.parquet");
});

test("a file that changed after the manifest listed it is never sent, and the manifest never lands", async () => {
  using folder = evidenceFolder({ artifacts: [], check: completeCheck });
  await write(folder.path);
  writeFileSync(
    join(folder.path, testEvidencePaths.playwrightOutput, "os-sign-in/trace.zip"),
    "later",
  );
  const urls: string[] = [];

  await expect(
    uploadTestEvidence({
      repoRoot: folder.path,
      ...credentials,
      fetch: async (request) => {
        urls.push((request as Request).url);
        return new Response(null, { status: 200 });
      },
    }),
  ).rejects.toThrow("playwright-output/os-sign-in/trace.zip changed after the manifest listed it");
  expect(urls.some((url) => url.endsWith("trace.zip"))).toBe(false);
  expect(urls.some((url) => url.endsWith("/testrun_1nxc464grh/manifest.json"))).toBe(false);
});

test("a refused PUT fails the upload with R2's answer, one request each, and the manifest never lands", async () => {
  using folder = evidenceFolder({ artifacts: [], check: completeCheck });
  await write(folder.path);
  const urls: string[] = [];

  await expect(
    uploadTestEvidence({
      repoRoot: folder.path,
      ...credentials,
      fetch: async (request) => {
        urls.push((request as Request).url);
        return (request as Request).url.endsWith("trace.zip")
          ? new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 })
          : new Response(null, { status: 200 });
      },
    }),
  ).rejects.toThrow(/trace\.zip: 412 <Error><Code>PreconditionFailed<\/Code><\/Error>$/);
  expect(urls.filter((url) => url.endsWith("trace.zip"))).toHaveLength(1);
  expect(urls.some((url) => url.endsWith("/testrun_1nxc464grh/manifest.json"))).toBe(false);
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
