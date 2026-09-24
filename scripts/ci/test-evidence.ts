import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { AwsClient } from "aws4fetch";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import type { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import {
  TestEvidenceManifest,
  testEvidencePaths,
} from "@iterate-com/shared/test-support/test-evidence";
import { testEvidenceEnvs } from "../../envs.ts";
import { FlakeRecord } from "./flake-dashboard/contract.ts";
import { ciJobAttempt, testResultsParquet, testResultsTable } from "./test-results-parquet.ts";
import { loadTestTelemetryArtifacts } from "./upload-test-telemetry.ts";

/**
 * THE TEST EVIDENCE FOLDER'S MANIFEST, AND ITS UPLOAD TO R2 (docs/test-evidence.md). Two commands,
 * each a step after a CI job's telemetry finalizer, run from the repository root:
 *
 *   pnpm tsx scripts/ci/test-evidence.ts write    # tables/tests.parquet, then manifest.json
 *   pnpm tsx scripts/ci/test-evidence.ts upload   # the folder into R2, the manifest last
 *
 * `upload` runs only where a workflow sets TEST_EVIDENCE_UPLOAD to `r2`, and none does until the
 * bucket exists. Neither step decides the job (both are `continue-on-error`): the tests did.
 */
export async function writeTestEvidence(input: {
  repoRoot: string;
  artifacts: readonly TestTelemetryArtifact[];
  flakeRecords: readonly FlakeRecord[];
  source: Awaited<ReturnType<typeof testEvidenceSource>>;
  runner: { trigger?: string; actor?: string; node: string; platform: string; arch: string };
  createdAt: Date;
}) {
  const job = ciJobAttempt(input.artifacts);
  const testsTable = resolve(input.repoRoot, testEvidencePaths.testsTable);
  await mkdir(dirname(testsTable), { recursive: true });
  await writeFile(
    testsTable,
    testResultsParquet(
      testResultsTable({ job, artifacts: input.artifacts, flakeRecords: input.flakeRecords }),
    ),
  );

  const root = resolve(input.repoRoot, testEvidencePaths.root);
  const manifestFile = resolve(input.repoRoot, testEvidencePaths.manifest);
  const files = [];
  // One file at a time: a failed spec's trace or video can be tens of megabytes.
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const file = join(entry.parentPath, entry.name);
    if (!entry.isFile() || file === manifestFile) continue;
    const bytes = await readFile(file);
    files.push({ path: relative(root, file), bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));

  const runs = input.artifacts.map((artifact) => artifact.run);
  const manifest = TestEvidenceManifest.parse({
    manifestSchemaVersion: 1,
    testRunId: job.testRunId,
    createdAt: input.createdAt.toISOString(),
    source: {
      repository: job.repository,
      ...input.source,
      headSha: job.headSha,
      branch: job.branch,
      pullRequestNumber: job.pullRequestNumber,
    },
    runner: {
      provider: "depot",
      workflowName: job.workflowName,
      workflowRunId: job.workflowRunId,
      workflowRunAttempt: job.workflowRunAttempt,
      jobName: job.jobName,
      jobAttemptId: job.jobAttemptId,
      jobUrl: job.depotJobUrl,
      ...input.runner,
    },
    timings: {
      startedAt: runs.map((run) => run.startedAt).sort()[0],
      finishedAt: runs
        .map((run) => run.finishedAt)
        .sort()
        .at(-1),
    },
    runners: input.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      producer: artifact.producer,
      suite: artifact.context.suite,
      workspace: artifact.context.workspace,
      status: artifact.run.status,
      testCount: artifact.tests.length,
      startedAt: artifact.run.startedAt,
      finishedAt: artifact.run.finishedAt,
    })),
    files,
  });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Where a test run's folder lives in the evidence bucket (docs/test-evidence.md#object-keys):
 * `ci/date=<YYYY-MM-DD>/workflow=<workflow>/job=<job>/<testRunId>/`, the date being the day its
 * first runner started (UTC). The `key=value` segments are Hive-style, so DuckDB's
 * `hive_partitioning` reads date, workflow and job as columns and skips whole prefixes by them.
 */
export function testEvidencePrefix(manifest: TestEvidenceManifest) {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
  return [
    "ci",
    `date=${new Date(manifest.timings.startedAt).toISOString().slice(0, 10)}`,
    `workflow=${slug(manifest.runner.workflowName)}`,
    `job=${slug(manifest.runner.jobName)}`,
    manifest.testRunId,
    "",
  ].join("/");
}

/**
 * PUTs the folder through R2's S3 API (https://developers.cloudflare.com/r2/api/s3/api/) with a
 * bucket-scoped R2 API token's keys: every file the manifest lists, eight at a time, then the
 * manifest, so a folder whose manifest is in R2 is complete. Each PUT is write-once
 * (`If-None-Match: *`: an existing key fails with 412 rather than being replaced) and signs the
 * manifest's sha256 as the payload hash, so R2 refuses a file that changed after the manifest listed
 * it (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html).
 *
 * aws4fetch only signs: its own `AwsClient.fetch` retries a 5xx up to 10 times out of sight
 * (https://github.com/mhart/aws4fetch#new-awsclientoptions). One request per object, and a failure
 * fails the step; the job's Depot artifact still has the folder.
 */
export async function uploadTestEvidence(input: {
  repoRoot: string;
  accountId: string;
  bucketName: string;
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
  const root = resolve(input.repoRoot, testEvidencePaths.root);
  const manifestBytes = await readFile(resolve(input.repoRoot, testEvidencePaths.manifest));
  const manifest = TestEvidenceManifest.parse(JSON.parse(manifestBytes.toString("utf8")));
  const prefix = testEvidencePrefix(manifest);
  const put = async (path: string, body: Uint8Array, payloadSha256: string) => {
    const key = `${prefix}${path}`;
    const request = await client.sign(
      `https://${input.accountId}.r2.cloudflarestorage.com/${input.bucketName}/${key.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "PUT",
        body,
        headers: {
          "content-type": contentTypes[extname(path)] || "application/octet-stream",
          "if-none-match": "*",
          "x-amz-content-sha256": payloadSha256,
        },
      },
    );
    const response = await input.fetch(request);
    if (!response.ok) {
      throw new Error(
        `R2 PUT ${input.bucketName}/${key}: ${response.status} ${await response.text()}`,
      );
    }
  };

  for (let start = 0; start < manifest.files.length; start += 8) {
    await Promise.all(
      manifest.files
        .slice(start, start + 8)
        .map(async (file) => put(file.path, await readFile(join(root, file.path)), file.sha256)),
    );
  }
  await put(
    relative(testEvidencePaths.root, testEvidencePaths.manifest),
    manifestBytes,
    sha256(manifestBytes),
  );
  return prefix;
}

/**
 * The source a manifest records. `tree` is the files on disk, not HEAD's tree: a copy of the index
 * with every change and untracked file added (`git add --all`, which leaves ignored files such as
 * test-results/ out) is written as a tree, and the real index is not touched. It is the tree the
 * tests read, and the one a proof that they ran would name (docs/test-evidence.md#skipping-ci).
 */
export async function testEvidenceSource(repoRoot: string) {
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).trim();
  const directory = await mkdtemp(join(tmpdir(), "test-evidence-index-"));
  try {
    const index = join(directory, "index");
    await copyFile(resolve(repoRoot, git(["rev-parse", "--git-path", "index"])), index);
    git(["add", "--all"], { GIT_INDEX_FILE: index });
    const tree = git(["write-tree"], { GIT_INDEX_FILE: index });
    return {
      commit: git(["rev-parse", "HEAD"]),
      tree,
      dirty: tree !== git(["rev-parse", "HEAD^{tree}"]),
      lockfileSha256: sha256(await readFile(resolve(repoRoot, "pnpm-lock.yaml"))),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** What the evidence folder holds, so a viewer serving it from R2 can pass the type on. */
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".jsonl": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".webm": "video/webm",
  ".zip": "application/zip",
  // https://www.iana.org/assignments/media-types/application/vnd.apache.parquet
  ".parquet": "application/vnd.apache.parquet",
};

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
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

if (isMainModule(import.meta.url)) {
  const repoRoot = process.cwd();
  const command = process.argv[2];
  if (command === "write") {
    const manifest = await writeTestEvidence({
      repoRoot,
      artifacts: (
        await loadTestTelemetryArtifacts(resolve(repoRoot, testEvidencePaths.telemetry))
      ).map(({ artifact }) => artifact),
      flakeRecords: await loadFlakeRecords(resolve(repoRoot, testEvidencePaths.flakeRecords)),
      source: await testEvidenceSource(repoRoot),
      runner: {
        trigger: process.env.GITHUB_EVENT_NAME || undefined,
        actor: process.env.GITHUB_ACTOR || undefined,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      createdAt: new Date(),
    });
    const bytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
    console.log(
      `[test-evidence] ${manifest.testRunId}: ${manifest.files.length} files, ${bytes} bytes, tree ${manifest.source.tree}${manifest.source.dirty ? " (not the commit's)" : ""}`,
    );
  } else if (command === "upload") {
    const { TEST_EVIDENCE_R2_ACCESS_KEY_ID, TEST_EVIDENCE_R2_SECRET_ACCESS_KEY } = process.env;
    if (!TEST_EVIDENCE_R2_ACCESS_KEY_ID || !TEST_EVIDENCE_R2_SECRET_ACCESS_KEY) {
      throw new Error(
        "upload needs TEST_EVIDENCE_R2_ACCESS_KEY_ID and TEST_EVIDENCE_R2_SECRET_ACCESS_KEY (Doppler _shared/preview)",
      );
    }
    const prefix = await uploadTestEvidence({
      repoRoot,
      accountId: testEvidenceEnvs.ci.cloudflareAccountId,
      bucketName: testEvidenceEnvs.ci.bucketName,
      accessKeyId: TEST_EVIDENCE_R2_ACCESS_KEY_ID,
      secretAccessKey: TEST_EVIDENCE_R2_SECRET_ACCESS_KEY,
      fetch,
    });
    console.log(`[test-evidence] r2://${testEvidenceEnvs.ci.bucketName}/${prefix}`);
  } else {
    throw new Error("Usage: pnpm tsx scripts/ci/test-evidence.ts write|upload");
  }
}
