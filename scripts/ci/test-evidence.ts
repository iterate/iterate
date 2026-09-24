import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { AwsClient } from "aws4fetch";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import {
  TestEvidenceCompleteness,
  TestEvidenceManifest,
  TestEvidenceTarget,
  testEvidencePaths,
} from "@iterate-com/shared/test-support/test-evidence";
import { ciBucketEnvs } from "../../envs.ts";
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
 * `upload` runs in the Test, Preview OS and Main OS e2e jobs (testEvidenceJobs), with Doppler
 * `_shared/preview`'s CLOUDFLARE_API_TOKEN. Neither step decides the job (both are
 * `continue-on-error`): the tests did. A step that fails says so in a warning annotation and a line
 * of the job's summary (reportStepFailure); one that fails before it can, a later step reports
 * (scripts/ci/test-evidence-unreported.sh).
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
      trust: runnerTrust({ environment, source: input.source, headSha: job.headSha, diagnostics }),
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
 * `main` for a push or schedule on refs/heads/main that tested that very commit: the files on disk
 * are its tree, unchanged. `depot ci run` applies a laptop's changes to the checkout as a patch, so a
 * run whose tree is not the pushed commit's is filed as `pr`, with a diagnostic saying why. Everything
 * else is `pr`, dispatches included, since a dispatch can be told to test a pull request.
 */
function runnerTrust(input: {
  environment: NodeJS.ProcessEnv;
  source: { commit: string; dirty: boolean };
  headSha: string | undefined;
  diagnostics: string[];
}): TestEvidenceManifest["runner"]["trust"] {
  const { environment, source } = input;
  const event = environment.GITHUB_EVENT_NAME || "";
  if (environment.GITHUB_REF !== "refs/heads/main" || !["push", "schedule"].includes(event))
    return "pr";
  if (!source.dirty && source.commit === input.headSha) return "main";
  input.diagnostics.push(
    `filed as trust=pr: a ${event} on refs/heads/main, but the tested tree is not commit ${input.headSha}'s (checked out ${source.commit}${source.dirty ? ", changed on disk" : ""})`,
  );
  return "pr";
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
function testRunResult(input: {
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
 * Where a test run's folder lives in the CI bucket (docs/test-evidence.md#object-keys):
 * `evidence/ci/trust=<main|pr>/date=<YYYY-MM-DD>/job=<Depot job id>/<testRunId>/`, the date being the
 * UTC day the manifest was written. `evidence/` keeps the folders apart from the bucket's `tables/`
 * and `state/`, which never expire. Every segment after `ci/` but the last is one a Depot OIDC
 * token's claims give (`ref` and `event_name`, `iat`, `job_id`), so the notary that later mints
 * per-job credentials can derive the prefix rather than take it from the job. `trust` before the
 * date, because R2 lifecycle rules and bucket locks match by prefix. The `key=value` segments are
 * Hive-style: DuckDB's `hive_partitioning` reads them as columns and skips whole prefixes by them.
 */
export function testEvidencePrefix(manifest: TestEvidenceManifest) {
  return `evidence/ci/${testEvidencePartition(manifest)}/${manifest.testRunId}/`;
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

/** Retries of one request whose failure is Cloudflare's (sendRetryingPlatformFailures). */
const PLATFORM_FAILURE_RETRIES = 3;
/** One request's ceiling: a folder's largest file, a failed spec's trace, is a few megabytes. */
const REQUEST_TIMEOUT_MS = 60_000;
/** The whole upload's: no retry starts after it and the request in flight is aborted, so a Cloudflare
 *  outage costs the job a minute and a half. The e2e job is a pull request's slowest check, and this
 *  evidence decides nothing. */
const UPLOAD_DEADLINE_MS = 90_000;
/** The longest wait before a retry, whatever a 429's Retry-After asks. */
const RETRY_WAIT_CEILING_MS = 5_000;

/**
 * PUTs the folder into the CI bucket through R2's S3 API (https://developers.cloudflare.com/r2/api/s3/api/):
 * every file the manifest lists, eight at a time, then a copy of `tables/tests.parquet` under
 * `tables/` for the loader (not for a cancelled run, whose rows stop part way), then the manifest.
 * The manifest is the commit point: a folder, or a table's copy, whose manifest is in R2 is complete,
 * and the loader skips a copy whose manifest is not.
 *
 * The credentials are the Cloudflare API token CI already holds (Doppler `_shared/preview`'s
 * CLOUDFLARE_API_TOKEN, the one preview deploys use): an API token with R2 permissions is also an
 * S3 key pair, its id the access key id and the SHA-256 of its value the secret
 * (https://developers.cloudflare.com/r2/api/tokens/#get-s3-api-credentials-from-an-api-token). S3,
 * not the Cloudflare API's own object endpoint (the one `wrangler r2 object put` uses): on
 * 2026-09-24 that endpoint replaced an existing object despite `If-None-Match: *` and stored a body
 * whose `Content-MD5` was wrong, and each of its requests counts against the token owner's 1,200
 * per five minutes, which preview deploys share. R2's S3 API refused both (412, and
 * XAmzContentSHA256Mismatch).
 *
 * Each PUT is write-once (`If-None-Match: *`). A 412 means the key exists: when it holds these very
 * bytes (a single PUT's ETag is the body's MD5), it is this upload's own earlier try, landed after
 * all; anything else is refused. Each file is hashed again as it is read and refused if it no
 * longer matches the manifest, and that sha256 is signed as the payload hash, so R2 refuses a body
 * that changed on the way too (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html).
 * aws4fetch only signs: its own `AwsClient.fetch` would retry out of sight.
 */
export async function uploadTestEvidence(input: {
  repoRoot: string;
  accountId: string;
  bucketName: string;
  /** Doppler `_shared/preview`'s CLOUDFLARE_API_TOKEN. */
  apiToken: string;
  fetch: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  /** Aborts the upload: the request in flight, and any retry after it. UPLOAD_DEADLINE_MS by default. */
  deadline?: AbortSignal;
}) {
  const context: RequestContext = {
    fetch: input.fetch,
    wait: input.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    deadline: input.deadline || AbortSignal.timeout(UPLOAD_DEADLINE_MS),
    retries: 0,
  };
  const client = new AwsClient({
    accessKeyId: await apiTokenId(input, context),
    secretAccessKey: sha256(new TextEncoder().encode(input.apiToken)),
    service: "s3",
    region: "auto",
  });
  const root = resolve(input.repoRoot, testEvidencePaths.root);
  const manifestBytes = await readFile(resolve(input.repoRoot, testEvidencePaths.manifest));
  const manifest = TestEvidenceManifest.parse(JSON.parse(manifestBytes.toString("utf8")));
  const prefix = testEvidencePrefix(manifest);
  const objectUrl = (key: string) =>
    `https://${input.accountId}.r2.cloudflarestorage.com/${input.bucketName}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const put = async (key: string, path: string, body: Uint8Array, payloadSha256: string) => {
    if (sha256(body) !== payloadSha256)
      throw new Error(`${path} changed after the manifest listed it; nothing more is uploaded`);
    const response = await sendRetryingPlatformFailures(
      `PUT ${key}`,
      async (signal) =>
        context.fetch(
          await client.sign(objectUrl(key), {
            method: "PUT",
            body,
            headers: {
              "content-type": contentTypes[extname(path)] || "application/octet-stream",
              "if-none-match": "*",
              "x-amz-content-sha256": payloadSha256,
            },
          }),
          { signal },
        ),
      context,
    );
    if (response.ok) return;
    const answer = `${response.status} ${await response.text()}`;
    if (response.status === 412) {
      const held = await sendRetryingPlatformFailures(
        `HEAD ${key}`,
        async (signal) =>
          context.fetch(await client.sign(objectUrl(key), { method: "HEAD" }), { signal }),
        context,
      );
      // Cloudflare's edge compresses a JSON answer and so marks its ETag weak: `W/"<md5>"`.
      const etag = held.headers.get("etag")?.match(/^(?:W\/)?"([0-9a-f]{32})"$/u)?.[1];
      if (held.ok && etag === createHash("md5").update(body).digest("hex")) {
        console.log(`[test-evidence] ${key} already held these bytes`);
        return;
      }
    }
    throw new Error(`R2 PUT ${input.bucketName}/${key}: ${answer}`);
  };
  const putFile = async (key: string, file: TestEvidenceManifest["files"][number]) =>
    put(key, file.path, await readFile(join(root, file.path)), file.sha256);

  for (let start = 0; start < manifest.files.length; start += 8) {
    await Promise.all(
      manifest.files.slice(start, start + 8).map((file) => putFile(`${prefix}${file.path}`, file)),
    );
  }
  const testsTable =
    manifest.result === "cancelled"
      ? undefined
      : manifest.files.find(
          (file) => file.path === relative(testEvidencePaths.root, testEvidencePaths.testsTable),
        );
  const tableKey = testsTable && testEvidenceTableKey(manifest);
  if (testsTable && tableKey) await putFile(tableKey, testsTable);
  const manifestPath = relative(testEvidencePaths.root, testEvidencePaths.manifest);
  await put(`${prefix}${manifestPath}`, manifestPath, manifestBytes, sha256(manifestBytes));
  const bytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
  return {
    prefix,
    tableKey,
    /** Every PUT: the listed files, the table's copy when there is one, and the manifest. */
    objects: manifest.files.length + (testsTable ? 1 : 0) + 1,
    bytes: bytes + (testsTable?.bytes ?? 0) + manifestBytes.byteLength,
    retries: context.retries,
  };
}

type RequestContext = {
  fetch: typeof fetch;
  wait: (ms: number) => Promise<void>;
  /** The upload's deadline: aborts the request in flight, and no retry starts after it. */
  deadline: AbortSignal;
  /** Platform-failure retries so far, for the step summary. */
  retries: number;
};

/**
 * The API token's id, which is its S3 access key id. A user token answers `/user/tokens/verify`,
 * an account-owned one its account's (https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/).
 */
async function apiTokenId(input: { accountId: string; apiToken: string }, context: RequestContext) {
  const answers: string[] = [];
  for (const path of ["/user/tokens/verify", `/accounts/${input.accountId}/tokens/verify`]) {
    const response = await sendRetryingPlatformFailures(
      `GET ${path}`,
      (signal) =>
        context.fetch(`https://api.cloudflare.com/client/v4${path}`, {
          headers: { authorization: `Bearer ${input.apiToken}` },
          signal,
        }),
      context,
    );
    if (response.ok) return TokenVerification.parse(await response.json()).result.id;
    answers.push(`${path}: ${response.status}`);
  }
  throw new Error(`CLOUDFLARE_API_TOKEN did not verify (${answers.join(", ")})`);
}

const TokenVerification = z.object({ result: z.object({ id: z.string().min(1) }) });

/**
 * One request to Cloudflare, sent again when the failure is Cloudflare's: a 5xx, a 429, or no
 * answer (a reset connection, REQUEST_TIMEOUT_MS). Each retry is a warn whose `event` is
 * `test-evidence.platform-failure-retry` (docs/engineering-invariants.md), after a wait of 1, 2 and
 * then 4 seconds, or what a 429's Retry-After asks, up to RETRY_WAIT_CEILING_MS. After
 * PLATFORM_FAILURE_RETRIES, or at the upload's deadline, the failure is thrown. Every other answer, a
 * 4xx included, is the caller's.
 */
async function sendRetryingPlatformFailures(
  what: string,
  send: (signal: AbortSignal) => Promise<Response>,
  context: RequestContext,
) {
  for (let attempt = 1; ; attempt++) {
    let failure: { status?: number; answer: string; retryAfterSeconds?: number };
    try {
      const response = await send(
        AbortSignal.any([context.deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      );
      if (response.status < 500 && response.status !== 429) return response;
      failure = {
        status: response.status,
        answer: (await response.text()).slice(0, 500),
        retryAfterSeconds: Number(response.headers.get("retry-after")) || undefined,
      };
    } catch (error) {
      failure = { answer: describeError(error) };
    }
    if (attempt > PLATFORM_FAILURE_RETRIES || context.deadline.aborted)
      throw new Error(
        `${what}: ${failure.status ?? "no answer"} ${failure.answer} (after ${attempt - 1} retries)`,
      );
    const waitMs = Math.min(
      (failure.retryAfterSeconds ?? 2 ** (attempt - 1)) * 1000,
      RETRY_WAIT_CEILING_MS,
    );
    context.retries++;
    console.warn({
      event: "test-evidence.platform-failure-retry",
      request: what,
      attempt,
      status: failure.status,
      answer: failure.answer,
      waitMs,
    });
    await context.wait(waitMs);
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause ? `${error.message}: ${describeError(error.cause)}` : error.message;
}

/**
 * The source a manifest records. `tree` is the files on disk, not HEAD's tree: a copy of the index
 * with every change and untracked file added (`git add --all`, which leaves ignored files such as
 * test-results/ out) is written as a tree, and the real index is not touched. It is the tree the
 * tests read, and the one a proof that they ran would name (skipping CI on such a proof is
 * designed, not built: https://github.com/iterate/iterate/issues/3110).
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

/**
 * The job summary's line for a folder that reached R2. The hourly CI telemetry sync reads it back
 * from each job attempt's summary (testEvidenceUploadedPrefix), so the attempts whose folder never
 * arrived add up in PostHog.
 */
export function uploadedSummaryLine(input: {
  bucketName: string;
  prefix: string;
  objects: number;
  bytes: number;
  retries: number;
}) {
  const retries = input.retries > 0 ? `, after ${input.retries} platform-failure retries` : "";
  return `Test evidence: \`r2://${input.bucketName}/${input.prefix}\` (${input.objects} objects, ${input.bytes} bytes${retries})`;
}

/** The prefix an uploadedSummaryLine in a job attempt's summary names; undefined when it has none. */
export function testEvidenceUploadedPrefix(summary: string) {
  return /^Test evidence: `r2:\/\/[^/`]+\/(evidence\/[^`]+)`/mu.exec(summary)?.[1];
}

/**
 * The CI jobs that write and upload a test evidence folder, as Depot keys them (`<file>:<job>`).
 * scripts/ci/depot-workflows.test.ts holds this to the workflows.
 */
export const testEvidenceJobs = [
  "test.yml:test",
  "preview-os.yml:e2e",
  "preview-os.yml:specs",
  "main-os-e2e.yml:e2e",
  "main-os-e2e.yml:specs",
];

/** A failed step's warning title, which its summary line and the fallback report's repeat. */
export const stepFailureTitles = {
  write: "No test evidence manifest",
  upload: "Test evidence not in R2",
};

/**
 * A failed step's report. The step is `continue-on-error`, so the job's result stays the tests';
 * this makes the missing evidence visible on the run's page: a warning annotation and a line of the
 * job's summary saying why. Then a marker in the runner's temporary directory says it reported, so
 * the workflow's next step (scripts/ci/test-evidence-unreported.sh), which reports a step that
 * failed before it got here (Doppler, pnpm, the step's timeout), does not report it twice.
 */
export function reportStepFailure(input: {
  command: keyof typeof stepFailureTitles;
  error: unknown;
  /** The step's: GITHUB_STEP_SUMMARY and RUNNER_TEMP. */
  environment: NodeJS.ProcessEnv;
}) {
  const title = stepFailureTitles[input.command];
  const message = describeError(input.error);
  // a message's own `%` and line breaks, escaped as the workflow command syntax asks
  const data = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.log(`::warning title=${title}::${data}`);
  stepSummary(input.environment, `**${title}**: ${message}. The tests' result is unaffected.`);
  writeFileSync(
    join(input.environment.RUNNER_TEMP || tmpdir(), `test-evidence-${input.command}.reported`),
    `${message}\n`,
  );
}

/** A line on the job's summary page (GITHUB_STEP_SUMMARY, which Depot CI provides). */
function stepSummary(environment: NodeJS.ProcessEnv, line: string) {
  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (isMainModule(import.meta.url)) {
  const repoRoot = process.cwd();
  const command = process.argv[2];
  const bucket = ciBucketEnvs.ci;
  if (command !== "write" && command !== "upload") {
    console.error("Usage: pnpm tsx scripts/ci/test-evidence.ts write [--cancelled] | upload");
    process.exit(2);
  }
  try {
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
    } else {
      const { CLOUDFLARE_API_TOKEN } = process.env;
      if (!CLOUDFLARE_API_TOKEN)
        throw new Error("upload needs CLOUDFLARE_API_TOKEN (Doppler _shared/preview)");
      const uploaded = await uploadTestEvidence({
        repoRoot,
        accountId: bucket.cloudflareAccountId,
        bucketName: bucket.bucketName,
        apiToken: CLOUDFLARE_API_TOKEN,
        fetch,
      });
      console.log(`[test-evidence] r2://${bucket.bucketName}/${uploaded.prefix}`);
      stepSummary(process.env, uploadedSummaryLine({ bucketName: bucket.bucketName, ...uploaded }));
    }
  } catch (error) {
    reportStepFailure({ command, error, environment: process.env });
    console.error(error);
    process.exitCode = 1;
  }
}
