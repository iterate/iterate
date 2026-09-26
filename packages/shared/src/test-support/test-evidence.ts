import { z } from "zod";

/**
 * THE TEST EVIDENCE FOLDER (docs/test-evidence.md): everything one test run leaves behind, in one
 * directory described by one manifest. A test run is one CI job attempt (the Test job, a preview's
 * or main's e2e job); a run on a laptop is next. Every producer writes below `root`: the Playwright
 * config reads these paths, and the workflows set TEST_TELEMETRY_ARTIFACT_DIR and FLAKE_RECORD_DIR to
 * them (scripts/ci/depot-workflows.test.ts holds them equal). After the runners,
 * `scripts/ci/test-evidence.ts write` adds the manifest, which lists every other file with its
 * sha256; `upload` puts the folder in R2 as it is.
 *
 * Paths are relative to the repository root and are the ones the producers already used, so no
 * reader moved.
 */
export const testEvidencePaths = {
  root: "test-results",
  /** A `TestEvidenceManifest`. Written last: a folder with one is complete. */
  manifest: "test-results/manifest.json",
  /** Each runner's raw telemetry (./ci-telemetry.ts). */
  telemetry: "test-results/ci-telemetry/raw",
  /** The telemetry finalizer's completeness check (scripts/ci/upload-test-telemetry.ts). */
  telemetryCheck: "test-results/ci-telemetry/manifest.json",
  /** createFlake/createFailing/retry record lines (./flake-record.ts), a directory per suite in the e2e jobs. */
  flakeRecords: "test-results/flake-records",
  /** Playwright's per-test output: trace.zip, screenshots, videos, error-context.md. */
  playwrightOutput: "test-results/playwright-output",
  playwrightReport: "test-results/playwright-html",
  playwrightResults: "test-results/playwright-results.json",
  /** Kit's firmware host tests, as CTest's JUnit XML (the Test job's `--output-junit`). */
  ctestJunit: "test-results/ctest/junit.xml",
  /** A `TestEvidenceTarget`: the deployment an e2e job's suites ran against. */
  target: "test-results/target.json",
};

const Timestamp = z.iso.datetime({ offset: true });
const GitObjectId = z.string().regex(/^[0-9a-f]{40}$/u);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * `target.json`: what an e2e job's suites were about to test, recorded just before they start
 * (apps/os/scripts/preview.ts). A run against a preview deployed earlier (Preview OS's `action=e2e`
 * dispatch) tests whatever that deploy left, not the commit the job checked out, so this names the
 * deployment. The shape is the deploy's own `preview.json` summary, narrowed.
 */
export const TestEvidenceTarget = z.object({
  previewName: z.string().min(1),
  /** The OS preview. */
  url: z.url(),
  /** Cloudflare's version id the OS preview's `/version` answered with; absent when it did not answer. */
  deploymentId: z.string().min(1).optional(),
  /** The client apps the specs ran against. They answer `/healthz` with `ok` and no version. */
  apps: z.array(z.object({ name: z.string().min(1), url: z.url() })),
  checkedAt: Timestamp,
});

export type TestEvidenceTarget = z.infer<typeof TestEvidenceTarget>;

/**
 * The telemetry finalizer's verdict on the runners (`ci-telemetry/manifest.json`), as it wrote it:
 * which workspaces it expected and which left no complete artifact of this job attempt.
 */
export const TestEvidenceCompleteness = z.object({
  cancelled: z.boolean(),
  expectedWorkspaces: z.array(z.string()),
  missingWorkspaces: z.array(z.string()),
  incompleteArtifactIds: z.array(z.string()),
  foreignArtifactIds: z.array(z.string()),
});

/**
 * `manifest.json`: who ran which tests on which tree, when, with what result, and what they left.
 * Readers (the R2 consumers in docs/test-evidence.md) parse it with this schema; a change that
 * breaks old manifests bumps `manifestSchemaVersion`. No manifest has been stored yet, so version 1
 * is this shape.
 */
export const TestEvidenceManifest = z.object({
  manifestSchemaVersion: z.literal(1),
  /** `testrun_<Depot job attempt id>`, the id every artifact name of that attempt ends in. */
  testRunId: z.string().regex(/^testrun_[a-z0-9]+$/u),
  createdAt: Timestamp,
  /**
   * The run's verdict. `cancelled`: the job was. `incomplete`: the evidence cannot say, because
   * the finalizer found a runner missing, cut short or from another attempt, left no check, or a
   * step that runs tests was skipped or has no outcome. `failed`: a step that runs tests failed or
   * a runner reported a failure. `passed`: none of that.
   */
  result: z.enum(["passed", "failed", "incomplete", "cancelled"]),
  source: z.object({
    repository: z.string().min(1),
    /** The checked-out commit. On a pull request, the merge commit CI tests. */
    commit: GitObjectId,
    /** The tree of the files on disk when the manifest was written, uncommitted changes included. */
    tree: GitObjectId,
    /** `tree` is not `commit`'s tree: something changed or appeared after the checkout. */
    dirty: z.boolean(),
    lockfileSha256: Sha256,
    /** The pull request's head, which the telemetry is labelled with (TEST_TELEMETRY_HEAD_SHA). */
    headSha: z.string().optional(),
    branch: z.string().optional(),
    pullRequestNumber: z.number().int().positive().optional(),
  }),
  runner: z.object({
    provider: z.literal("depot"),
    /**
     * `main`: a push to main or a schedule on main, run by main's own workflow file. `pr`:
     * everything else (pull requests, dispatches, `depot ci run`). The first segment of the
     * run's object keys, so the two get their own retention and never share a prefix.
     */
    trust: z.enum(["main", "pr"]),
    /** GITHUB_REF: `refs/heads/main`, `refs/pull/<n>/merge`. */
    ref: z.string().optional(),
    workflowName: z.string().min(1),
    workflowRunId: z.string().min(1),
    workflowRunAttempt: z.string().min(1),
    jobName: z.string().min(1),
    /** Depot's job id (DEPOT_JOB_URL's `job=`): the same for every attempt of the job. */
    jobId: z.string().regex(/^[a-z0-9]+$/u),
    jobAttemptId: z.string().regex(/^[a-z0-9]+$/u),
    jobUrl: z.url(),
    /** GITHUB_EVENT_NAME: `pull_request`, `push`, `workflow_dispatch`. */
    trigger: z.string().optional(),
    /** GITHUB_ACTOR: who pushed or dispatched. */
    actor: z.string().optional(),
    node: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
  }),
  /** The steps that run tests, as the workflow passed their outcomes in (TEST_EVIDENCE_STEPS). */
  steps: z.array(
    z.object({
      name: z.string().min(1),
      outcome: z.enum(["success", "failure", "cancelled", "skipped"]),
    }),
  ),
  /** The telemetry finalizer's check; absent when it wrote none. */
  completeness: TestEvidenceCompleteness.optional(),
  /** The deployment the suites ran against (`target.json`); only the e2e jobs have one. */
  target: TestEvidenceTarget.optional(),
  /** From the first runner's start to the last runner's finish, by the runners' clocks; absent without runners. */
  timings: z.object({ startedAt: Timestamp, finishedAt: Timestamp }).optional(),
  /** One per raw telemetry artifact of this job attempt: which runner ran where, and its verdict. */
  runners: z.array(
    z.object({
      artifactId: z.string().min(1),
      producer: z.string().min(1),
      suite: z.string().min(1),
      workspace: z.string().optional(),
      status: z.string().min(1),
      testCount: z.number().int().nonnegative(),
      startedAt: Timestamp,
      finishedAt: Timestamp,
    }),
  ),
  /**
   * What the writer could not read: telemetry it could not parse, another attempt's telemetry, a
   * finalizer check or target it could not read. The manifest is written anyway; the result says
   * whether the tests passed.
   */
  diagnostics: z.array(z.string()),
  /** Every file in the folder but this one, relative to the folder, sorted by path. */
  files: z.array(
    z.object({
      path: z.string().min(1),
      bytes: z.number().int().nonnegative(),
      sha256: Sha256,
    }),
  ),
});

export type TestEvidenceManifest = z.infer<typeof TestEvidenceManifest>;
