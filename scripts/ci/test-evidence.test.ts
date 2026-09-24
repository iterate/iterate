import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  uploadTestEvidence,
  writeTestEvidence,
} from "./test-evidence.ts";

const commit = "c".repeat(40);
const source = {
  commit,
  tree: "7".repeat(40),
  dirty: false,
  lockfileSha256: "1".repeat(64),
};
const runner = {
  trigger: "pull_request",
  actor: "jonastemplestein",
  node: "v24.8.0",
  platform: "linux",
  arch: "x64",
};

test("writes the tests table, then a manifest naming the job attempt, its tree and every file with its sha256", async () => {
  using folder = evidenceFolder();
  const repoRoot = folder.path;

  const manifest = await writeTestEvidence({
    repoRoot,
    artifacts: [
      artifact("vitest:os:1", "2026-09-24T07:23:01.000Z", "2026-09-24T07:25:00.000Z"),
      artifact("playwright:iterate-root:1", "2026-09-24T07:22:59.000Z", "2026-09-24T07:24:00.000Z"),
    ],
    flakeRecords: [],
    source,
    runner,
    createdAt: new Date("2026-09-24T07:26:00.000Z"),
  });

  expect(manifest).toMatchObject({
    manifestSchemaVersion: 1,
    testRunId: "testrun_1nxc464grh",
    createdAt: "2026-09-24T07:26:00.000Z",
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
      workflowName: "Preview OS",
      jobName: "e2e",
      jobAttemptId: "1nxc464grh",
      trigger: "pull_request",
      actor: "jonastemplestein",
    },
    // the first runner's start and the last runner's finish
    timings: { startedAt: "2026-09-24T07:22:59.000Z", finishedAt: "2026-09-24T07:25:00.000Z" },
    runners: [
      { artifactId: "vitest:os:1", suite: "vitest", status: "passed", testCount: 1 },
      { artifactId: "playwright:iterate-root:1", testCount: 1 },
    ],
  });
  // sorted, hidden files kept, the manifest itself left out
  expect(manifest.files.map((file) => file.path)).toEqual([
    "ci-telemetry/raw/vitest-os.json",
    "flake-records/specs/flake-records-1.jsonl",
    "playwright-output/.last-run.json",
    "playwright-output/os-sign-in/trace.zip",
    "tables/tests.parquet",
  ]);
  expect(manifest.files).toContainEqual({
    path: "playwright-output/os-sign-in/trace.zip",
    bytes: 5,
    sha256: createHash("sha256").update("trace").digest("hex"),
  });
  const written = TestEvidenceManifest.parse(
    JSON.parse(readFileSync(join(repoRoot, testEvidencePaths.manifest), "utf8")),
  );
  expect(written).toEqual(manifest);

  const rows = await parquetReadObjects({
    // a copy: a small file's Buffer is a slice of Node's shared pool, so its `.buffer` holds other bytes
    file: new Uint8Array(readFileSync(join(repoRoot, testEvidencePaths.testsTable))).buffer,
  });
  expect(rows).toMatchObject([
    { test_run_id: "testrun_1nxc464grh", full_name: "stream › appends round-trip" },
    { test_run_id: "testrun_1nxc464grh", full_name: "stream › appends round-trip" },
  ]);
});

test("keys a test run's folder by day, workflow and job, Hive-style", async () => {
  using folder = evidenceFolder();
  const manifest = await writeTestEvidence({
    repoRoot: folder.path,
    artifacts: [artifact("vitest:os:1", "2026-09-23T23:59:59.000Z", "2026-09-24T00:05:00.000Z")],
    flakeRecords: [],
    source,
    runner,
    createdAt: new Date("2026-09-24T00:06:00.000Z"),
  });

  expect(testEvidencePrefix(manifest)).toBe(
    "ci/date=2026-09-23/workflow=preview-os/job=e2e/testrun_1nxc464grh/",
  );
});

const credentials = {
  accountId: "376ef7ed81b0573f93524de763666c15",
  bucketName: "ci-test-evidence",
  accessKeyId: "key-id",
  secretAccessKey: "secret",
};

test("PUTs every listed file write-once with its manifest sha256 as the signed payload hash, then the manifest", async () => {
  using folder = evidenceFolder();
  const repoRoot = folder.path;
  const manifest = await writeTestEvidence({
    repoRoot,
    artifacts: [artifact("vitest:os:1", "2026-09-24T07:23:01.000Z", "2026-09-24T07:25:00.000Z")],
    flakeRecords: [],
    source,
    runner,
    createdAt: new Date("2026-09-24T07:26:00.000Z"),
  });
  const requests: Request[] = [];

  const prefix = await uploadTestEvidence({
    repoRoot,
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
  // the files in parallel, in any order; the manifest alone, last
  expect(keys.slice(0, -1).sort()).toEqual(
    manifest.files.map((file) => `/ci-test-evidence/${prefix}${file.path}`),
  );
  expect(keys.at(-1)).toBe(`/ci-test-evidence/${prefix}manifest.json`);
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
  expect(requests.at(-1)!.headers.get("content-type")).toBe("application/json");
});

test("a refused PUT fails the upload with R2's answer, one request each, and the manifest never lands", async () => {
  using folder = evidenceFolder();
  const repoRoot = folder.path;
  await writeTestEvidence({
    repoRoot,
    artifacts: [artifact("vitest:os:1", "2026-09-24T07:23:01.000Z", "2026-09-24T07:25:00.000Z")],
    flakeRecords: [],
    source,
    runner,
    createdAt: new Date("2026-09-24T07:26:00.000Z"),
  });
  const urls: string[] = [];

  await expect(
    uploadTestEvidence({
      repoRoot,
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
  expect(urls.some((url) => url.endsWith("manifest.json"))).toBe(false);
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

/** A repository root whose test-results/ holds what an e2e job's runners leave. */
function evidenceFolder() {
  const folder = temporaryDirectory("test-evidence-");
  const put = (path: string, contents: string) => {
    mkdirSync(join(folder.path, path, ".."), { recursive: true });
    writeFileSync(join(folder.path, path), contents);
  };
  put(`${testEvidencePaths.telemetry}/vitest-os.json`, "{}");
  put(`${testEvidencePaths.flakeRecords}/specs/flake-records-1.jsonl`, "");
  put(`${testEvidencePaths.playwrightOutput}/.last-run.json`, '{"status":"passed"}');
  put(`${testEvidencePaths.playwrightOutput}/os-sign-in/trace.zip`, "trace");
  return folder;
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
      depotJobUrl:
        "https://depot.dev/orgs/0p91s0lz49/workflows/ntb262kdvq?job=jcc9z1d62z&attempt=1nxc464grh",
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
