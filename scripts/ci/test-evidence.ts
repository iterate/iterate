import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { ciTelemetrySourceFromEnvironment } from "@iterate-com/shared/test-support/ci-telemetry";
import {
  TestEvidenceCompleteness,
  TestEvidenceManifest,
  TestEvidenceTarget,
  testEvidencePaths,
} from "@iterate-com/shared/test-support/test-evidence";
import { ciBucketEnvs } from "../../envs.ts";
import { ciBucket } from "./ci-bucket.ts";
import finalizeTestTelemetry from "./test-telemetry-finalizer.ts";
import { loadTestTelemetryArtifacts, unitTestWorkspaces } from "./test-telemetry-completeness.ts";

/**
 * THE TEST EVIDENCE FOLDER'S MANIFEST, AND ITS UPLOAD TO R2 (docs/test-evidence.md). Two commands,
 * each a step after a CI job's tests, run from the repository root with Node's own type stripping:
 *
 *   node scripts/ci/test-evidence.ts finalize --flake-suites <suite> [--cancelled]
 *     # the telemetry finalizer, then manifest.json
 *   node scripts/ci/test-evidence.ts upload   # into R2, the manifest last
 *
 * They run in the Test, Preview OS and Main OS e2e jobs (testEvidenceJobs), `upload` with Doppler
 * `_shared/preview`'s CLOUDFLARE_API_TOKEN. Neither the manifest nor the upload decides the job (the
 * upload is `continue-on-error`, and `finalize` fails only on the telemetry's account): the tests
 * did. A write or upload that fails says so in a warning annotation and a line of the job's summary
 * (reportStepFailure); one that fails before it can, a later step reports
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
  // Another attempt's artifacts (the finalizer's foreign ones) are named, never counted as ours.
  const artifacts = loaded.filter((artifact) => artifact.ci.depotJobUrl === job.depotJobUrl);
  const foreign = loaded.filter((artifact) => !artifacts.includes(artifact));
  if (foreign.length > 0)
    diagnostics.push(
      `test telemetry from another job attempt, left out of the runners: ${foreign.map(({ artifactId }) => artifactId).join(", ")}`,
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
 * The CI job attempt this process runs in: the manifest's identity. It comes from the job's
 * environment (DEPOT_JOB_URL, GITHUB_*, TEST_TELEMETRY_*), read the way the reporters read it
 * (`ciTelemetrySourceFromEnvironment`), not from the telemetry, so a job whose runners crashed or
 * never started still has one. Without a Depot job attempt (a laptop) there is none.
 */
function ciJobAttempt(environment: NodeJS.ProcessEnv) {
  const job = CiJob.parse(ciTelemetrySourceFromEnvironment(environment));
  const url = new URL(job.depotJobUrl);
  const jobId = url.searchParams.get("job");
  const jobAttemptId = url.searchParams.get("attempt");
  if (!jobId || !jobAttemptId)
    throw new Error(`DEPOT_JOB_URL names no job and attempt: ${job.depotJobUrl}`);
  return { ...job, jobId, jobAttemptId, testRunId: `testrun_${jobAttemptId}` };
}

/** The fields the manifest needs, which a laptop's environment does not have. */
const CiJob = z.object({
  repository: z.string(),
  workflowName: z.string().min(1),
  workflowRunId: z.string(),
  workflowRunAttempt: z.string(),
  jobName: z.string().min(1),
  depotJobUrl: z.url(),
  headSha: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  pullRequestNumber: z.number().int().optional(),
});

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
 * UTC day the manifest was written. Every segment after `ci/` but the last is one a Depot OIDC
 * token's claims give (`ref` and `event_name`, `iat`, `job_id`), so the notary that later mints
 * per-job credentials can derive the prefix rather than take it from the job. `trust` before the
 * date, because R2 lifecycle rules and bucket locks match by prefix. The `key=value` segments are
 * Hive-style: DuckDB's `hive_partitioning` reads them as columns and skips whole prefixes by them.
 */
export function testEvidencePrefix(manifest: TestEvidenceManifest) {
  return `evidence/ci/${testEvidencePartition(manifest)}/${manifest.testRunId}/`;
}

function testEvidencePartition(manifest: TestEvidenceManifest) {
  return [
    `trust=${manifest.runner.trust}`,
    `date=${manifest.createdAt.slice(0, 10)}`,
    `job=${manifest.runner.jobId}`,
  ].join("/");
}

/** One request's ceiling: a folder's largest file, a failed spec's trace, is a few megabytes. */
const REQUEST_TIMEOUT_MS = 60_000;
/** The whole upload's: no retry starts after it and the request in flight is aborted, so a Cloudflare
 *  outage costs the job a minute and a half. The e2e job is a pull request's slowest check, and this
 *  evidence decides nothing. */
const UPLOAD_DEADLINE_MS = 90_000;
/** PUTs in flight at once. One takes about half a second to the WEUR bucket however many go
 *  together (2026-09-27), so an upload's time is its waves: a job's 10 to 53 files are one or two
 *  at 32, and the manifest one more. */
const UPLOAD_CONCURRENCY = 32;
/** The bodies those PUTs hold in memory at once. A failed spec's trace or video can be tens of
 *  megabytes; a file larger than this goes alone. */
const UPLOAD_BYTES_IN_FLIGHT = 128 * 1024 * 1024;

/**
 * PUTs the folder into the CI bucket (scripts/ci/ci-bucket.ts): every file the manifest lists, the
 * largest first and up to UPLOAD_CONCURRENCY at once, then the manifest. The manifest is the commit
 * point: a folder whose manifest is in R2 is complete. R2's S3 API, not the Cloudflare API's own
 * object endpoint (the one `wrangler r2 object put` uses): that endpoint can replace an existing
 * object despite `If-None-Match: *` and store a body whose `Content-MD5` is wrong, where R2's S3 API
 * refuses both (412, and XAmzContentSHA256Mismatch), and each of its requests counts against the
 * token owner's 1,200 per five minutes, which preview deploys share.
 *
 * Each PUT is write-once. A 412 means the key exists: when it holds these very bytes (a single PUT's
 * ETag is the body's MD5), it is this upload's own earlier try, landed after all; anything else is
 * refused. Each file is hashed again as it is read and refused if it no longer matches the
 * manifest, and that sha256 is signed as the payload hash, so R2 refuses a body that changed on the
 * way too (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html).
 */
export async function uploadTestEvidence(input: {
  repoRoot: string;
  accountId: string;
  bucketName: string;
  /** Doppler `_shared/preview`'s CLOUDFLARE_API_TOKEN. */
  apiToken: string;
  fetch: typeof fetch;
}) {
  /** Platform-failure retries so far, for the step summary. */
  let retries = 0;
  const bucket = await ciBucket({
    ...input,
    area: "test-evidence",
    timeoutMs: REQUEST_TIMEOUT_MS,
    // aborts the request in flight, and any retry after it
    signal: AbortSignal.timeout(UPLOAD_DEADLINE_MS),
    onRetry: () => retries++,
  });
  const root = resolve(input.repoRoot, testEvidencePaths.root);
  const manifestBytes = await readFile(resolve(input.repoRoot, testEvidencePaths.manifest));
  const manifest = TestEvidenceManifest.parse(JSON.parse(manifestBytes.toString("utf8")));
  const prefix = testEvidencePrefix(manifest);
  const put = async (key: string, path: string, body: Uint8Array, payloadSha256: string) => {
    if (sha256(body) !== payloadSha256)
      throw new Error(`${path} changed after the manifest listed it; nothing more is uploaded`);
    const response = await bucket.put(key, body, {
      contentType: contentTypes[extname(path)] || "application/octet-stream",
      sha256: payloadSha256,
    });
    if (response.ok) return;
    const answer = `${response.status} ${await response.text()}`;
    if (response.status === 412) {
      const held = await bucket.head(key);
      // Cloudflare's edge compresses a JSON answer and so marks its ETag weak: `W/"<md5>"`.
      const etag = held.headers.get("etag")?.match(/^(?:W\/)?"([0-9a-f]{32})"$/u)?.[1];
      if (held.ok && etag === createHash("md5").update(body).digest("hex")) {
        console.log(`[test-evidence] ${key} already held these bytes`);
        return;
      }
    }
    throw new Error(`R2 PUT ${input.bucketName}/${key}: ${answer}`);
  };
  await inPool(manifest.files, async (file) =>
    put(`${prefix}${file.path}`, file.path, await readFile(join(root, file.path)), file.sha256),
  );
  const manifestPath = relative(testEvidencePaths.root, testEvidencePaths.manifest);
  await put(`${prefix}${manifestPath}`, manifestPath, manifestBytes, sha256(manifestBytes));
  const bytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
  return {
    prefix,
    /** Every PUT: the listed files, then the manifest. */
    objects: manifest.files.length + 1,
    bytes: bytes + manifestBytes.byteLength,
    retries,
  };
}

/**
 * `put` for every file, the largest first, up to UPLOAD_CONCURRENCY at once and holding at most
 * UPLOAD_BYTES_IN_FLIGHT of their bytes (a file larger than that goes alone). The first failure
 * rejects at once and nothing more starts.
 */
function inPool(
  files: TestEvidenceManifest["files"],
  put: (file: TestEvidenceManifest["files"][number]) => Promise<void>,
) {
  const queue = files.toSorted((a, b) => b.bytes - a.bytes);
  let active = 0;
  let bytes = 0;
  let failed = false;
  return new Promise<void>((resolve, reject) => {
    const next = () => {
      if (failed) return;
      if (queue.length === 0 && active === 0) return resolve();
      while (
        queue.length > 0 &&
        active < UPLOAD_CONCURRENCY &&
        (active === 0 || bytes + queue[0]!.bytes <= UPLOAD_BYTES_IN_FLIGHT)
      ) {
        const file = queue.shift()!;
        active++;
        bytes += file.bytes;
        put(file).then(
          () => {
            active--;
            bytes -= file.bytes;
            next();
          },
          (error: unknown) => {
            failed = true;
            reject(error);
          },
        );
      }
    };
    next();
  });
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
      // a git that never answers holds the event loop, so the manifest's deadline could not pass
      timeout: WRITE_DEADLINE_MS,
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
};

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
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
 * A failed write's or upload's report. Neither decides the job (the upload's step is
 * `continue-on-error`, and a failed write leaves `finalize` the finalizer's result), so this makes
 * the missing evidence visible on the run's page: a warning annotation and a line of the job's
 * summary saying why. Then a marker in the runner's temporary directory says it reported, so the
 * workflow's next step (scripts/ci/test-evidence-unreported.sh), which reports a step that failed
 * before it got here (Node, Doppler, the step's timeout), does not report it twice.
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

/**
 * THE STEP AFTER A JOB'S TESTS, in one process (docs/test-evidence.md#what-ci-does): the telemetry
 * finalizer (test-telemetry-finalizer.ts: every expected runner left a complete artifact, the unit
 * row budget, the suite's suite-summary.json), then the test evidence manifest. The finalizer
 * decides the step: missing, incomplete or foreign telemetry fails it, once the manifest is
 * written. The manifest decides nothing: a failure to write it is a warning and a line of the job's
 * summary (reportStepFailure), and the step's result stays the finalizer's.
 *
 * The step's outputs say what the folder holds, each as soon as it is true: `evidence=kept` before
 * anything else, `manifest=written`, and `playwright-report=written` when it holds Playwright's HTML
 * report. The steps after it read these rather than `hashFiles()`, which costs the runner about
 * 0.2 s per condition (the job's first about 0.6 s), one at a time even inside a parallel block.
 */
export async function finalize(
  options: {
    /** The flake suite this job ran, for its suite-summary.json. */
    flakeSuites?: "unit" | "specs" | "preview-e2e";
    /** Expect the checked-out tree's test workspaces (the Test workflow); otherwise the list
     *  TEST_TELEMETRY_EXPECTED_WORKSPACES names (a preview test job's `iterate-root` or `os`). */
    expectUnitWorkspaces?: boolean;
    /** A suite job's: keep evidence only once its suite read the deployed target
     *  (test-results/target.json). A job that never had a preview has nothing to keep. */
    onlyWithTarget?: boolean;
    /** The job was cancelled (the workflow's `cancelled()`). */
    cancelled?: boolean;
  } = {},
) {
  const { flakeSuites, expectUnitWorkspaces, onlyWithTarget, cancelled = false } = options;
  if (onlyWithTarget && !existsSync(resolve(process.cwd(), testEvidencePaths.target))) {
    console.log(
      `[test-evidence] no ${testEvidencePaths.target}: the suite had no preview to test, so there is no evidence to keep`,
    );
    return;
  }
  stepOutput("evidence", "kept");
  const telemetry = await finalizeTestTelemetry({
    cancelled,
    expectedWorkspaces: expectUnitWorkspaces
      ? unitTestWorkspaces(process.cwd())
      : (process.env.TEST_TELEMETRY_EXPECTED_WORKSPACES || "")
          .split(",")
          .map((workspace) => workspace.trim())
          .filter(Boolean),
    flakeSuites,
    headSha: process.env.TEST_TELEMETRY_HEAD_SHA,
  }).then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  const manifest = await writeManifest({
    repoRoot: process.cwd(),
    environment: process.env,
    cancelled,
  });
  if (manifest) {
    stepOutput("manifest", "written");
    const report = `${relative(testEvidencePaths.root, testEvidencePaths.playwrightReport)}/index.html`;
    if (manifest.files.some((file) => file.path === report))
      stepOutput("playwright-report", "written");
  }
  if (telemetry) throw telemetry.error;
}

/** One of the step's outputs (GITHUB_OUTPUT), for the steps after it. */
function stepOutput(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** How long the manifest may take, a second or two in CI: one pass over the folder and a git tree.
 *  Past it the manifest is a failed write, so one that never finishes cannot run its step, which
 *  also carries the finalizer's result, into the step's two-minute timeout. */
const WRITE_DEADLINE_MS = 60_000;

/** manifest.json, in the job's test evidence folder. A failure, or no manifest by
 *  WRITE_DEADLINE_MS, is reported (reportStepFailure), never thrown: the manifest decides nothing. */
export async function writeManifest(input: {
  repoRoot: string;
  /** The job's, as writeTestEvidence reads it, and the report's GITHUB_STEP_SUMMARY and RUNNER_TEMP. */
  environment: NodeJS.ProcessEnv;
  cancelled: boolean;
  /** The source the manifest records, testEvidenceSource's by default. */
  source?: (repoRoot: string) => ReturnType<typeof testEvidenceSource>;
}) {
  const { repoRoot, environment, source = testEvidenceSource } = input;
  const pastDeadline = Promise.withResolvers<never>();
  const deadline = setTimeout(
    () => pastDeadline.reject(new Error(`not written within ${WRITE_DEADLINE_MS / 1000} s`)),
    WRITE_DEADLINE_MS,
  );
  try {
    const manifest = await Promise.race([
      (async () =>
        writeTestEvidence({
          repoRoot,
          environment,
          cancelled: input.cancelled,
          source: await source(repoRoot),
          toolchain: { node: process.version, platform: process.platform, arch: process.arch },
          createdAt: new Date(),
        }))(),
      pastDeadline.promise,
    ]);
    const bytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
    console.log(
      `[test-evidence] ${manifest.testRunId} ${manifest.result}: ${manifest.files.length} files, ${bytes} bytes, tree ${manifest.source.tree}${manifest.source.dirty ? " (not the commit's)" : ""}`,
    );
    for (const diagnostic of manifest.diagnostics) console.log(`[test-evidence] ${diagnostic}`);
    return manifest;
  } catch (error) {
    reportStepFailure({ command: "write", error, environment });
    console.error(error);
    return undefined;
  } finally {
    clearTimeout(deadline);
  }
}

/** The test evidence folder into R2, the manifest last (CLOUDFLARE_API_TOKEN, Doppler _shared/preview). */
export async function upload() {
  const bucket = ciBucketEnvs.ci;
  const started = performance.now();
  try {
    const { CLOUDFLARE_API_TOKEN } = process.env;
    if (!CLOUDFLARE_API_TOKEN)
      throw new Error("upload needs CLOUDFLARE_API_TOKEN (Doppler _shared/preview)");
    const uploaded = await uploadTestEvidence({
      repoRoot: process.cwd(),
      accountId: bucket.cloudflareAccountId,
      bucketName: bucket.bucketName,
      apiToken: CLOUDFLARE_API_TOKEN,
      fetch,
    });
    // the upload's own time, and the process's: the difference is Node's start-up
    console.log(
      `[test-evidence] r2://${bucket.bucketName}/${uploaded.prefix} (${uploaded.objects} objects in ${seconds(performance.now() - started)}, ${seconds(performance.now())} after Node started)`,
    );
    stepSummary(process.env, uploadedSummaryLine({ bucketName: bucket.bucketName, ...uploaded }));
  } catch (error) {
    failStep("upload", error);
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/** Reports the failed step (reportStepFailure) and exits 1. */
function failStep(command: keyof typeof stepFailureTitles, error: unknown): never {
  reportStepFailure({ command, error, environment: process.env });
  console.error(error);
  process.exit(1);
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "test-evidence" }).run();
