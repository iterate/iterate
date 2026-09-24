import { z } from "zod";

/**
 * THE TEST EVIDENCE FOLDER (docs/test-evidence.md): everything one test run leaves behind, in one
 * directory described by one manifest. A test run is one CI job attempt (the Test job, a preview's
 * or main's e2e job); a run on a laptop is next. Every producer writes below `root`: the Playwright
 * config reads these paths, and the workflows set TEST_TELEMETRY_ARTIFACT_DIR and FLAKE_RECORD_DIR to
 * them (scripts/ci/depot-workflows.test.ts holds them equal). After the runners,
 * `scripts/ci/test-evidence.ts write` adds the per-test rows and then the manifest, which lists
 * every other file with its sha256; `upload` puts the folder in R2 as it is.
 *
 * Paths are relative to the repository root and are the ones the producers already used, so no
 * reader moved.
 */
export const testEvidencePaths = {
  root: "test-results",
  /** A `TestEvidenceManifest`. Written last: a folder with one is complete. */
  manifest: "test-results/manifest.json",
  /** Each runner's raw telemetry (./ci-telemetry.ts), and the finalizer's `../manifest.json` check. */
  telemetry: "test-results/ci-telemetry/raw",
  /** createFlake/createFailing/retry record lines (./flake-record.ts), a directory per suite in the e2e jobs. */
  flakeRecords: "test-results/flake-records",
  /** Playwright's per-test output: trace.zip, screenshots, videos, error-context.md. */
  playwrightOutput: "test-results/playwright-output",
  playwrightReport: "test-results/playwright-html",
  playwrightResults: "test-results/playwright-results.json",
  /** One row per test, the analytics input (scripts/ci/test-results-parquet.ts). */
  testsTable: "test-results/tables/tests.parquet",
};

const Timestamp = z.iso.datetime({ offset: true });
const GitObjectId = z.string().regex(/^[0-9a-f]{40}$/u);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * `manifest.json`: who ran which tests on which tree, when, and what they left. Readers (the R2
 * consumers in docs/test-evidence.md) parse it with this schema; a change that breaks old manifests
 * bumps `manifestSchemaVersion`.
 */
export const TestEvidenceManifest = z.object({
  manifestSchemaVersion: z.literal(1),
  /** `testrun_<Depot job attempt id>`: the `test_run_id` of every row in the folder's tables. */
  testRunId: z.string().regex(/^testrun_[a-z0-9]+$/u),
  createdAt: Timestamp,
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
    workflowName: z.string().min(1),
    workflowRunId: z.string().min(1),
    workflowRunAttempt: z.string().min(1),
    jobName: z.string().min(1),
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
  /** From the first runner's start to the last runner's finish, by the runners' clocks. */
  timings: z.object({ startedAt: Timestamp, finishedAt: Timestamp }),
  /** One per raw telemetry artifact: which runner ran where, and its verdict. */
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
