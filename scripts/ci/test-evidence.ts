import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { AwsClient } from "aws4fetch";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import {
  TestEvidenceCompleteness,
  TestEvidenceManifest,
  TestEvidenceTarget,
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
 *   pnpm tsx scripts/ci/test-evidence.ts write [--cancelled]  # tests.parquet, then manifest.json
 *   pnpm tsx scripts/ci/test-evidence.ts upload               # into R2, the manifest last
 *
 * `upload` runs only where a workflow sets TEST_EVIDENCE_UPLOAD to `r2`, and none does until the
 * bucket exists. Neither step decides the job (both are `continue-on-error`): the tests did.
 */
export async function writeTestEvidence(input: {
  repoRoot: string;
  /** The job's: DEPOT_JOB_URL, GITHUB_*, TEST_TELEMETRY_* and TEST_EVIDENCE_STEPS. */
  environment: NodeJS.ProcessEnv;
  /** The job was cancelled (the workflow's `cancelled()`). */
  cancelled: boolean;
  source: Awaited<ReturnType<typeof testEvidenceSource>>;
  toolchain: { node: string; platform: string; arch: string };
  createdAt: Date;
}) {
  const { environment } = input;
  // The one thing that throws: without a Depot job attempt there is no test run id to file under.
  const job = ciJobAttempt(environment);
  const diagnostics: string[] = [];
  const path = (relativePath: string) => resolve(input.repoRoot, relativePath);
  // Every read below is best-effort: what cannot be read becomes a diagnostic, and the manifest,
  // which is what gets the folder uploaded, is written regardless.
  const attempt = async <T, F>(
    what: string,
    read: () => Promise<T>,
    fallback: F,
  ): Promise<T | F> => {
    try {
      return await read();
    } catch (error) {
      diagnostics.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };

  const loaded = await attempt(
    "test telemetry",
    async () =>
      (await loadTestTelemetryArtifacts(path(testEvidencePaths.telemetry))).map(
        ({ artifact }) => artifact,
      ),
    [],
  );
  // Another attempt's artifacts (the finalizer's foreign ones) are listed, never labelled as ours.
  const artifacts = loaded.filter((artifact) => artifact.ci.depotJobUrl === job.depotJobUrl);
  const foreign = loaded.filter((artifact) => !artifacts.includes(artifact));
  if (foreign.length > 0)
    diagnostics.push(
      `test telemetry from another job attempt, left out of the rows: ${foreign.map(({ artifactId }) => artifactId).join(", ")}`,
    );
  const flakeRecords = await attempt(
    "flake records",
    () => loadFlakeRecords(path(testEvidencePaths.flakeRecords)),
    [],
  );
  const completeness = await attempt(
    "the telemetry finalizer's check",
    async () =>
      TestEvidenceCompleteness.parse(
        JSON.parse(await readFile(path(testEvidencePaths.telemetryCheck), "utf8")),
      ),
    undefined,
  );
  const target = existsSync(path(testEvidencePaths.target))
    ? await attempt(
        "the deployed target",
        async () =>
          TestEvidenceTarget.parse(
            JSON.parse(await readFile(path(testEvidencePaths.target), "utf8")),
          ),
        undefined,
      )
    : undefined;
  const steps = testEvidenceSteps(environment.TEST_EVIDENCE_STEPS, diagnostics);

  await mkdir(path(testEvidencePaths.root), { recursive: true });
  await attempt(
    "tables/tests.parquet",
    async () => {
      const { rows, problems } = testResultsTable({ job, artifacts, flakeRecords });
      diagnostics.push(...problems);
      await mkdir(dirname(path(testEvidencePaths.testsTable)), { recursive: true });
      await writeFile(path(testEvidencePaths.testsTable), testResultsParquet(rows));
    },
    undefined,
  );

  const root = path(testEvidencePaths.root);
  const manifestFile = path(testEvidencePaths.manifest);
  const files = [];
  // One file at a time: a failed spec's trace or video can be tens of megabytes.
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const file = join(entry.parentPath, entry.name);
    if (!entry.isFile() || file === manifestFile) continue;
    const bytes = await readFile(file);
    files.push({ path: relative(root, file), bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));

  const runners = artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    producer: artifact.producer,
    suite: artifact.context.suite,
    workspace: artifact.context.workspace,
    status: artifact.run.status,
    testCount: artifact.tests.length,
    startedAt: artifact.run.startedAt,
    finishedAt: artifact.run.finishedAt,
  }));
  const manifest = TestEvidenceManifest.parse({
    manifestSchemaVersion: 1,
    testRunId: job.testRunId,
    createdAt: input.createdAt.toISOString(),
    result: testRunResult({ cancelled: input.cancelled, completeness, steps, runners }),
    source: {
      repository: job.repository,
      ...input.source,
      headSha: job.headSha,
      branch: job.branch,
      pullRequestNumber: job.pullRequestNumber,
    },
    runner: {
      provider: "depot",
      trust:
        environment.GITHUB_REF === "refs/heads/main" &&
        ["push", "schedule"].includes(environment.GITHUB_EVENT_NAME || "")
          ? "main"
          : "pr",
      ref: environment.GITHUB_REF || undefined,
      workflowName: job.workflowName,
      workflowRunId: job.workflowRunId,
      workflowRunAttempt: job.workflowRunAttempt,
      jobName: job.jobName,
      jobId: job.jobId,
      jobAttemptId: job.jobAttemptId,
      jobUrl: job.depotJobUrl,
      trigger: environment.GITHUB_EVENT_NAME || undefined,
      actor: environment.GITHUB_ACTOR || undefined,
      ...input.toolchain,
    },
    steps,
    completeness,
    target,
    timings:
      runners.length > 0
        ? {
            startedAt: runners.map((runner) => runner.startedAt).sort()[0],
            finishedAt: runners
              .map((runner) => runner.finishedAt)
              .sort()
              .at(-1),
          }
        : undefined,
    runners,
    diagnostics,
    files,
  });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * TEST_EVIDENCE_STEPS, which the workflow sets on the write step from its own step outcomes:
 * `tests=${{ steps.tests.outcome }} kit-host-tests=${{ steps.kit-host-tests.outcome }}`. The steps
 * that run tests, so a Kit failure beside passing Vitest runners is a failed run, not a pass.
 */
function testEvidenceSteps(value: string | undefined, diagnostics: string[]) {
  const steps: TestEvidenceManifest["steps"] = [];
  for (const pair of (value || "").split(/\s+/u).filter(Boolean)) {
    const [name, outcome] = pair.split("=");
    const parsed = TestEvidenceManifest.shape.steps.element.safeParse({ name, outcome });
    if (parsed.success) steps.push(parsed.data);
    else diagnostics.push(`TEST_EVIDENCE_STEPS: "${pair}" is not <step>=<outcome>`);
  }
  if (steps.length === 0) diagnostics.push("TEST_EVIDENCE_STEPS names no step that runs tests");
  return steps;
}

/** The manifest's `result` (TestEvidenceManifest): cancelled, then incomplete, then failed. */
export function testRunResult(input: {
  cancelled: boolean;
  completeness: TestEvidenceManifest["completeness"];
  steps: TestEvidenceManifest["steps"];
  runners: TestEvidenceManifest["runners"];
}): TestEvidenceManifest["result"] {
  const { completeness, steps, runners } = input;
  if (input.cancelled || completeness?.cancelled) return "cancelled";
  if (
    !completeness ||
    completeness.missingWorkspaces.length > 0 ||
    completeness.incompleteArtifactIds.length > 0 ||
    completeness.foreignArtifactIds.length > 0 ||
    runners.length === 0 ||
    steps.length === 0 ||
    steps.some((step) => step.outcome === "skipped" || step.outcome === "cancelled")
  )
    return "incomplete";
  if (
    steps.some((step) => step.outcome === "failure") ||
    runners.some((runner) => runner.status !== "passed" && runner.status !== "skipped")
  )
    return "failed";
  return "passed";
}

/**
 * Where a test run's folder lives in the evidence bucket (docs/test-evidence.md#object-keys):
 * `ci/trust=<main|pr>/date=<YYYY-MM-DD>/job=<Depot job id>/<testRunId>/`, the date being the UTC
 * day the manifest was written. Every segment but the last is one a Depot OIDC token's claims give
 * (`ref` and `event_name`, `iat`, `job_id`), so the notary that later mints per-job credentials can
 * derive the prefix rather than take it from the job. `trust` first, because R2 lifecycle rules and
 * bucket locks match by prefix. The `key=value` segments are Hive-style: DuckDB's
 * `hive_partitioning` reads them as columns and skips whole prefixes by them.
 */
export function testEvidencePrefix(manifest: TestEvidenceManifest) {
  return `ci/${testEvidencePartition(manifest)}/${manifest.testRunId}/`;
}

/** The copy of the run's tests table the loader lists (docs/test-evidence.md#object-keys). */
export function testEvidenceTableKey(manifest: TestEvidenceManifest) {
  return `tables/tests/${testEvidencePartition(manifest)}/${manifest.testRunId}.parquet`;
}

function testEvidencePartition(manifest: TestEvidenceManifest) {
  return [
    `trust=${manifest.runner.trust}`,
    `date=${manifest.createdAt.slice(0, 10)}`,
    `job=${manifest.runner.jobId}`,
  ].join("/");
}

/**
 * PUTs the folder through R2's S3 API (https://developers.cloudflare.com/r2/api/s3/api/) with a
 * bucket-scoped R2 API token's keys: every file the manifest lists, eight at a time, then the
 * manifest, so a folder whose manifest is in R2 is complete, then a copy of `tables/tests.parquet`
 * under `tables/` for the loader. Each PUT is write-once (`If-None-Match: *`: an existing key fails
 * with 412 rather than being replaced). Each file is hashed again as it is read and refused if it
 * no longer matches the manifest, and that sha256 is signed as the payload hash, so R2 refuses a
 * body that changed on the way too
 * (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html).
 *
 * aws4fetch only signs: its own `AwsClient.fetch` retries a 5xx up to 10 times out of sight
 * (https://github.com/mhart/aws4fetch#new-awsclientoptions). One request per object, and a failure
 * fails the step.
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
  const put = async (key: string, path: string, body: Uint8Array, payloadSha256: string) => {
    if (sha256(body) !== payloadSha256)
      throw new Error(`${path} changed after the manifest listed it; nothing more is uploaded`);
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
  const putFile = async (key: string, file: TestEvidenceManifest["files"][number]) =>
    put(key, file.path, await readFile(join(root, file.path)), file.sha256);

  for (let start = 0; start < manifest.files.length; start += 8) {
    await Promise.all(
      manifest.files.slice(start, start + 8).map((file) => putFile(`${prefix}${file.path}`, file)),
    );
  }
  const manifestPath = relative(testEvidencePaths.root, testEvidencePaths.manifest);
  await put(`${prefix}${manifestPath}`, manifestPath, manifestBytes, sha256(manifestBytes));
  const testsTable = manifest.files.find(
    (file) => file.path === relative(testEvidencePaths.root, testEvidencePaths.testsTable),
  );
  const tableKey = testsTable ? testEvidenceTableKey(manifest) : undefined;
  if (testsTable && tableKey) await putFile(tableKey, testsTable);
  return { prefix, tableKey };
}

/**
 * The source a manifest records. `tree` is the files on disk, not HEAD's tree: a copy of the index
 * with every change and untracked file added (`git add --all`, which leaves ignored files such as
 * test-results/ out) is written as a tree, and the real index is not touched. It is the tree the
 * tests read, and the one a proof that they ran would name
 * (docs/test-evidence.md#skipping-ci-when-a-trusted-run-proves-it).
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
  ".xml": "application/xml",
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
      environment: process.env,
      cancelled: process.argv.includes("--cancelled"),
      source: await testEvidenceSource(repoRoot),
      toolchain: { node: process.version, platform: process.platform, arch: process.arch },
      createdAt: new Date(),
    });
    const bytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
    console.log(
      `[test-evidence] ${manifest.testRunId} ${manifest.result}: ${manifest.files.length} files, ${bytes} bytes, tree ${manifest.source.tree}${manifest.source.dirty ? " (not the commit's)" : ""}`,
    );
    for (const diagnostic of manifest.diagnostics) console.log(`[test-evidence] ${diagnostic}`);
  } else if (command === "upload") {
    const { TEST_EVIDENCE_R2_ACCESS_KEY_ID, TEST_EVIDENCE_R2_SECRET_ACCESS_KEY } = process.env;
    if (!TEST_EVIDENCE_R2_ACCESS_KEY_ID || !TEST_EVIDENCE_R2_SECRET_ACCESS_KEY) {
      throw new Error(
        "upload needs TEST_EVIDENCE_R2_ACCESS_KEY_ID and TEST_EVIDENCE_R2_SECRET_ACCESS_KEY (Doppler _shared/preview)",
      );
    }
    const { prefix } = await uploadTestEvidence({
      repoRoot,
      accountId: testEvidenceEnvs.ci.cloudflareAccountId,
      bucketName: testEvidenceEnvs.ci.bucketName,
      accessKeyId: TEST_EVIDENCE_R2_ACCESS_KEY_ID,
      secretAccessKey: TEST_EVIDENCE_R2_SECRET_ACCESS_KEY,
      fetch,
    });
    console.log(`[test-evidence] r2://${testEvidenceEnvs.ci.bucketName}/${prefix}`);
  } else {
    throw new Error("Usage: pnpm tsx scripts/ci/test-evidence.ts write [--cancelled] | upload");
  }
}
