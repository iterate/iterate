# Test evidence

Every test run leaves evidence: raw telemetry, flake records, Playwright traces,
screenshots, videos and reports, logs, the CI trace. Today it sits under four
roots (`test-results/`, `apps/os/output/`, `ci-trace.ignoreme/` and the Depot
job logs), with no manifest, and reaches readers as Depot artifacts. The
workflows ask for 30 days, but Depot keeps them about a week: on 2026-09-24,
main's runs up to 7 days old still listed their 15 or 16 artifacts, and every
run from 8 to 35 days old listed none. So a ci-reports link, a "Playwright
report" status or a flake record is gone after a week. Asking "which tests got
slower this month" means downloading artifacts one run at a time, and a month
ago is already gone.

The design: **one folder per test run, with one manifest, uploaded straight to
R2, into one bucket, `iterate-ci`. Everything else reads R2.** That includes per-test analytics, which run as
SQL over R2 (DuckDB over the folders from day one, then
[R2 SQL](https://developers.cloudflare.com/r2-sql/) over Iceberg tables an
hourly loader fills from them), and later a way for CI to skip a job that a
trusted run already proved.

**Status.** This PR implements the first part: the folder layout, the
manifest with the run's result, the deployed target of the e2e jobs, Kit's
CTest results as JUnit XML, the per-test Parquet rows, and the upload to R2,
which is on (`TEST_EVIDENCE_UPLOAD: r2`) in the Test, Preview OS and Main OS
e2e workflows. The bucket exists ([setup](#setup)), and CI writes it with the
Cloudflare API token it already holds, so no secret was added. Sections
marked _next_ are design only.

## The evidence folder

A **test run** is one CI job attempt that runs tests: the Test job, and the
`e2e` jobs of Preview OS and Main OS e2e. (A run on a laptop or an agent's
machine is [next](#local-and-agent-runs).) Its folder is the repository's
`test-results/`, the directory most producers already wrote to. The paths are
`testEvidencePaths` in
[`packages/shared/src/test-support/test-evidence.ts`](../packages/shared/src/test-support/test-evidence.ts),
so none of today's readers had to move.

```text
test-results/
├── manifest.json                   written last; the result, and every other file with its sha256
├── tables/tests.parquet            one row per test, the analytics input
├── target.json                     the e2e jobs: the preview and the deployment the suites ran against
├── ctest/junit.xml                 the Test job: Kit's firmware host tests
├── ci-telemetry/
│   ├── raw/<runner>.json           each runner's telemetry: one per Vitest workspace, one for Playwright
│   └── manifest.json               the finalizer's completeness check (upload-test-telemetry.ts)
├── flake-records/[<suite>/]*.jsonl createFlake / createFailing / retry lines, plus suite-summary.json
├── playwright-output/<test>/       trace.zip, test-failed-*.png, error-context.md, videos, spec screenshots
├── playwright-html/                Playwright's HTML report
└── playwright-results.json         Playwright's JSON reporter
```

Today the `e2e` jobs of Preview OS and Main OS e2e run the Vitest e2e suite
and the Playwright specs side by side in one step (`runE2eSuites` in
`apps/os/scripts/preview.ts`), so their folder holds both.

### When deploy, e2e and specs are separate jobs

This PR does not split them; #3054 splits Preview OS into Deploy preview, E2E
tests and Browser specs jobs. Once it lands, each test job is its own test
run, with its own folder, `testRunId`, manifest, result and prefix in R2. The
design stays; the workflows need:

- the finalizer's `TEST_TELEMETRY_EXPECTED_WORKSPACES`, today
  `"iterate-root,os"` in one job, split: `os` for e2e, `iterate-root` for
  specs;
- the write and upload steps, and the flake-record uploads, in both jobs,
  each with its own `TEST_EVIDENCE_STEPS`;
- `runE2eSuites` run one suite at a time, each job calling it for its own,
  and each writing `target.json` before it starts;
- the step-order assertions in `scripts/ci/depot-workflows.test.ts` for both
  jobs, and `public-playwright-report` moved to the specs job.

Each job pays its own queue and setup (checkout, dependency reconcile,
Doppler, and Chromium for the specs), in parallel with the other; the CI
trace's Setup phase per job is where to measure what that costs.

A run against a preview that is already deployed (Preview OS's `action=e2e`
dispatch, from `depot ci run` or the dashboard) is a test run like any other.
Its folder says both what it tested and with which tests: `target.json` names
the preview and the deployment its `/version` answered with just before the
suites started, and `source` names the tree the tests came from. They can
differ: that job checks out the pull request's head and merges it into
today's main, which need not be what the earlier deploy built. Comparing
`target.deploymentId` with the deploy's own `preview.json` tells which.

### How each producer writes into it

| Producer                                                                          | Writes                                                              | How it gets there                                                                                       | Status      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------- |
| Vitest, every unit workspace and the OS e2e suite (`retry-telemetry-reporter.ts`) | `ci-telemetry/raw/`                                                 | `TEST_TELEMETRY_ARTIFACT_DIR`, set by the workflows                                                     | today       |
| Playwright telemetry reporter                                                     | `ci-telemetry/raw/`                                                 | the same variable                                                                                       | today       |
| createFlake, createFailing, retried plain tests                                   | `flake-records/`                                                    | `FLAKE_RECORD_DIR`: test.yml, and `apps/os/scripts/preview.ts` per suite (now from `testEvidencePaths`) | today       |
| Playwright output, HTML and JSON reporters                                        | `playwright-output/`, `playwright-html/`, `playwright-results.json` | `playwright.config.ts`, now from `testEvidencePaths`                                                    | today       |
| The telemetry finalizer                                                           | `ci-telemetry/manifest.json`, `suite-summary.json`                  | `scripts/ci/upload-test-telemetry.ts`                                                                   | today       |
| The evidence writer                                                               | `tables/tests.parquet`, then `manifest.json`                        | `scripts/ci/test-evidence.ts write`                                                                     | **this PR** |
| Kit firmware host tests (CTest)                                                   | `ctest/junit.xml`                                                   | `--output-junit`, which `pnpm --dir apps/kit firmware:test:host` passes to CTest; rows are next         | **this PR** |
| Perf, soak, bench and real-model reports                                          | `os/`                                                               | move `apps/os/output/{perf-report,real-model-report}.json` and `soak/` here                             | next        |
| Step logs                                                                         | `logs/<step>.log`                                                   | fetched from Depot's API after the job; the bucket is private and the viewer never serves them          | next        |
| The CI trace                                                                      | `ci-trace/trace.{json,html}`, `tables/spans.parquet`                | the trace job, as its own test run folder                                                               | next        |
| The deployed target (e2e jobs)                                                    | `target.json`                                                       | `runE2eSuites`, before the suites: the preview, the OS deployment `/version` names, the apps' URLs      | **this PR** |

Videos are off in CI: `playwright.config.ts` keeps them only under
`VIDEO_MODE=1` or on local failures, because retained videos left ffmpeg
workers holding the job open. When on, they land in `playwright-output/` and
travel with the folder like everything else.

The Vitest e2e suite, the Playwright specs and the telemetry reporters record
nothing unless `TEST_TELEMETRY_ARTIFACT_DIR` and `FLAKE_RECORD_DIR` are set, so
a laptop run records nothing today. Nothing configures Vitest coverage or a
JUnit or JSON reporter; the telemetry reporter's raw JSON is Vitest's record.

### What CI does

In each of the three jobs, after the telemetry finalizer:

1. **Write the test evidence manifest**
   (`pnpm tsx scripts/ci/test-evidence.ts write`, `if: always()`,
   `--cancelled` when the job was, `continue-on-error`, two minutes at most).
   The workflow passes
   the outcome of every step that runs tests in `TEST_EVIDENCE_STEPS`
   (`tests=… kit-host-tests=…` in the Test job, `e2e=…` in the e2e jobs). It
   builds `tables/tests.parquet` from this attempt's raw telemetry and flake
   records, then hashes every file in the folder and writes `manifest.json`.
   On real artifacts it takes about half a second (37 files, 3.5 MB).
2. **Upload the test evidence to R2**
   (`pnpm tsx scripts/ci/test-evidence.ts upload`), `if: always()` when the
   workflow's `TEST_EVIDENCE_UPLOAD` is `r2` (all three are) and a manifest
   exists (`continue-on-error`, three minutes at most; Doppler
   `_shared/preview` supplies `CLOUDFLARE_API_TOKEN`). A cancelled or
   timed-out job's folder goes too, when the runner gives `always()` steps
   the time: its manifest says `cancelled`, and it gets no copy under
   `tables/`, since its rows stop part way and would skew durations. The
   step prints the run's prefix
   (`[test-evidence] r2://iterate-ci/evidence/ci/trust=pr/date=…/job=…/testrun_…/`)
   and writes it as a line of the job's summary.
3. **Report a test evidence step that could not**
   (`scripts/ci/test-evidence-unreported.sh`), when either step's outcome is
   `failure` ([below](#a-failed-step)).
4. The Depot artifacts as before. The e2e jobs already keep the whole folder
   as `{preview,main}-os-test-artifacts-attempt-<id>`; the Test job keeps its
   telemetry and flake records, and its manifest reaches only R2.

The write step fails when the job has no Depot job attempt to name the run
after, when git cannot record the source (`testEvidenceSource`), or when a
runner's fields do not fit the manifest's schema. Everything else it cannot
read (telemetry that does not parse, no finalizer check, a flake record that
names no test, a table it cannot write) goes into the manifest's
`diagnostics`, and the manifest is written anyway: the run whose runner
crashed is the one whose evidence matters most.

#### A failed step

Neither step decides the job. The tests' own steps and the finalizer do, so
both steps are `continue-on-error`, and a failure is made visible instead:

- **The step's own report.** The script catches its failure
  (`reportStepFailure`), prints a warning annotation ("Test evidence not in
  R2" or "No test evidence manifest") with the reason, adds a line saying
  why to the job's summary, and leaves a marker in `$RUNNER_TEMP`.
- **The fallback.** A step can fail before the script runs or reports:
  Doppler refusing `DOPPLER_TOKEN`, `pnpm tsx` crashing on import, or the
  step's own timeout (two and three minutes, so a hang can never reach the
  job's `timeout-minutes` and turn a green job red). The next step runs
  when either step's outcome is `failure`, and for a step that left no
  marker it writes the same annotation and a summary line saying the step
  failed before it could say why. It is plain shell, so it needs none of
  the things that failed.
- **Adding up.** A warning on a green run is easy to miss. The hourly CI
  telemetry sync reads each Test and e2e job attempt's summary from Depot
  and sets `test_evidence_uploaded` on its `ci job attempt finished` event
  in PostHog: `true` when the upload's line names a prefix, `false`
  otherwise, whatever the reason
  ([CI telemetry](ci-test-telemetry.md#ci-events-in-posthog)).
  Attempts whose folder never reached R2 are a count in PostHog, not a
  warning on a page nobody opened.

### The manifest

`TestEvidenceManifest` (the same module) is the schema; readers parse with it.
Abbreviated to one runner and two files, with this change's own Preview OS
run's identity (the `result`, `steps`, `completeness`, `target` and
`diagnostics` fields came after that run, so their values are illustrative):

```json
{
  "manifestSchemaVersion": 1,
  "testRunId": "testrun_1tf879r75h",
  "createdAt": "2026-09-24T13:15:47.062Z",
  "result": "passed",
  "source": {
    "repository": "iterate/iterate",
    "commit": "50f69522109a8eedf91f4f57fd0abfdafbf58ecb",
    "tree": "4ed3ca3b42b277eeaf664e2a3a9553453ba73856",
    "dirty": false,
    "lockfileSha256": "c752eac5b45390fe6f91bc5720b458a00b86e67b93d3c79359cbed5d9f58f60b",
    "headSha": "4a4617db58006f1ed5cea4e34bc683ab5a7584ea",
    "branch": "draft-test-telemetry-parquet",
    "pullRequestNumber": 2984
  },
  "runner": {
    "provider": "depot",
    "trust": "pr",
    "ref": "refs/pull/2984/merge",
    "workflowName": "Preview OS",
    "workflowRunId": "227491187545774",
    "workflowRunAttempt": "1",
    "jobName": "e2e",
    "jobId": "7zncg7grdw",
    "jobAttemptId": "1tf879r75h",
    "jobUrl": "https://depot.dev/orgs/0p91s0lz49/workflows/tnvgwdc563?job=7zncg7grdw&attempt=1tf879r75h",
    "trigger": "pull_request",
    "actor": "jonastemplestein",
    "node": "v24.21.0",
    "platform": "linux",
    "arch": "x64"
  },
  "steps": [{ "name": "e2e", "outcome": "success" }],
  "completeness": {
    "cancelled": false,
    "expectedWorkspaces": ["iterate-root", "os"],
    "missingWorkspaces": [],
    "incompleteArtifactIds": [],
    "foreignArtifactIds": []
  },
  "target": {
    "previewName": "draft-test-telemetry-parquet",
    "url": "https://draft-test-telemetry-parquet-<os preview host>",
    "deploymentId": "<the version id /version answered>",
    "apps": [
      { "name": "notes", "url": "https://draft-test-telemetry-parquet-<notes preview host>" }
    ],
    "checkedAt": "2026-09-24T13:12:38.902Z"
  },
  "timings": { "startedAt": "2026-09-24T13:12:39.651Z", "finishedAt": "2026-09-24T13:15:43.644Z" },
  "runners": [
    {
      "artifactId": "vitest:os:1553:1790255559651",
      "producer": "vitest-retry-telemetry-reporter",
      "suite": "vitest",
      "workspace": "os",
      "status": "passed",
      "testCount": 335,
      "startedAt": "2026-09-24T13:12:39.651Z",
      "finishedAt": "2026-09-24T13:15:43.644Z"
    }
  ],
  "diagnostics": [],
  "files": [
    {
      "path": "ci-telemetry/raw/vitest-os-1553-1790255559651-fd4fc5bccf5e.json",
      "bytes": 359565,
      "sha256": "627dff179d047a0412801fec308ce5bf7d716bfcce82097fa7899f400a8c2606"
    },
    {
      "path": "tables/tests.parquet",
      "bytes": 61645,
      "sha256": "b19f56bd1b4394f32b28a4b94a696700249b68267ef36346ec5668be454ebd98"
    }
  ]
}
```

The same run's Test job wrote the same `tree`: both jobs tested one merge
commit, and neither left the checkout dirty.

- `testRunId` is `testrun_<Depot job attempt id>`, the id every artifact name
  of that attempt already ends in ([per job attempt](depot-ci.md#artifacts-per-job-attempt)),
  and the `test_run_id` of every row in the folder's tables. It and the rest
  of the job's identity come from the job's environment (`DEPOT_JOB_URL`,
  `GITHUB_*`, `TEST_TELEMETRY_*`, read by the same
  `ciTelemetrySourceFromEnvironment` the reporters use), not from the
  telemetry, so a job whose runners never started still has one. Telemetry
  from another attempt is left out of the rows and named in `diagnostics`.
- `result` is `cancelled` when the job was; `incomplete` when the finalizer
  found a workspace missing, a runner cut short or another attempt's
  artifact, wrote no check, or a step that runs tests was skipped or passed
  no outcome; `failed` when such a step failed or a runner reported a
  failure; otherwise `passed`. A Test job whose Vitest runners all passed but
  whose Kit CTest step failed is `failed`: that step reports no telemetry,
  which is why the workflow passes the steps' outcomes in.
- `completeness` is the finalizer's own check (`ci-telemetry/manifest.json`,
  `scripts/ci/upload-test-telemetry.ts`), copied, not recomputed.
- `target` is `target.json`, in the e2e jobs only
  ([above](#when-deploy-e2e-and-specs-are-separate-jobs)). Only the OS
  preview answers with its deployment (`/version`); the client apps answer
  `/healthz` with `ok`, so their deployments are _next_.
- `source.commit` is the checked-out commit: on a pull request, the merge
  commit CI tests. `source.tree` is the tree of the files on disk when the
  manifest was written, uncommitted and untracked files included: a copy of
  the index gets `git add --all` and `git write-tree`, and the real index is
  untouched. `dirty` says it differs from the commit's tree. Ignored files,
  `test-results/` among them, are not in it. It is taken after the tests, so
  it shows what the run left, not what it started from; a proof needs the
  tree before the run as well, and the two equal (_next_: a `begin` step
  before the runners).
- `runner` is the Depot job attempt and who started it (`GITHUB_EVENT_NAME`,
  `GITHUB_ACTOR`), plus the toolchain the job ran on. `trust` is `main` for a
  push or schedule on `refs/heads/main` that tested that commit (`source` not
  `dirty`, and `commit` the pushed head), and `pr` for everything else,
  dispatches included, since a dispatch can be told to test a pull request.
  A push to main whose tree was not the commit's is filed as `pr`, with a
  diagnostic saying why ([object keys](#object-keys)).
  Environment variables that change what the tests do (`CI`, the base URLs,
  `VIDEO_MODE`) are set in the runners' own steps, which this step cannot
  see; recording them is part of the input key work.
- `timings` spans the first runner's start to the last runner's finish, by
  the runners' clocks; absent when no runner reported. Queue and setup time
  are Depot's and the CI trace's.
- `files` is every file but the manifest, sorted, with its size and sha256.

## Upload to R2

### One bucket

Everything CI keeps in R2 lives in one bucket, **`iterate-ci`**, on the
dev/preview account (`ciBucketEnvs.ci` in `envs.ts`), under three top-level
prefixes:

| Prefix      | Holds                                                                                     | Expires                                     |
| ----------- | ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| `evidence/` | Each test run's folder: `evidence/ci/…` from CI, `evidence/local/…` from laptops (_next_) | By lifecycle rule ([retention](#retention)) |
| `tables/`   | The per-test tables' copies the loader reads                                              | Never                                       |
| `state/`    | The guards' memory, one `<guard>.json` each (_next_, [downstream](#downstream-of-r2))     | Never                                       |

When the loader comes, the R2 Data Catalog is enabled on this bucket too. Its
tables' files live under the catalog's own prefix, which no lifecycle rule
covers: a rule that deleted an Iceberg data file would corrupt its table, and
Cloudflare warns against deleting a catalog's files by hand
([deleting data](https://developers.cloudflare.com/r2-data-catalog/deleting-data/)).
Retention there is snapshot expiration, which also deletes the data files no
snapshot references.

**Why one bucket.** A second bucket isolates data only through credentials:
an R2 API token can be scoped to buckets, never to a prefix. Today CI has one
credential. It writes with `CLOUDFLARE_API_TOKEN` from Doppler
`_shared/preview` ([credentials](#credentials)), the token preview deploys
use, which can create and delete every bucket on the account, and every CI
job holding `DOPPLER_TOKEN` can read it, pull request jobs included. Three
buckets written with that one token would be three names, three lifecycle
configurations and three places to look, and no boundary. Retention needs no
second bucket either: lifecycle rules and bucket locks match by prefix.

**When to split: when jobs get credentials scoped to what they write.** If
those are R2 API tokens, they scope by bucket only, so a writer whose data
the others must not touch gets its own bucket then. The first is the guards'
state: a pull request's job must never be able to reset a guard's memory,
which is why that state stays in Depot artifacts, written only by each
guard's own runs, until then ([downstream](#downstream-of-r2)). The
[notary's](#credentials) temporary credentials scope by prefix as well
(`state/<guard>.json` for a guard, one run's folder for a test job), so with
those one bucket can still hold. Bucket-wide settings are the other reason: public access (an `r2.dev`
URL, a custom domain) is per bucket, so this one is never public, since that
would expose `state/` and every trace. The viewer reads it through a Worker
binding, and anything that must be public gets a bucket of its own.

### Object keys

```text
evidence/ci/trust=<main|pr>/date=<YYYY-MM-DD>/job=<Depot job id>/<testRunId>/<path in the folder>
tables/tests/trust=<main|pr>/date=<YYYY-MM-DD>/job=<Depot job id>/<testRunId>.parquet
state/<guard>.json                                                    (next)
evidence/local/date=<YYYY-MM-DD>/user=<GitHub login>/<testRunId>/…    (next)
```

For example
`evidence/ci/trust=pr/date=2026-09-24/job=7zncg7grdw/testrun_1tf879r75h/playwright-html/index.html`
(`testEvidencePrefix` and `testEvidenceTableKey` in
`scripts/ci/test-evidence.ts`).

- **`evidence/` first**, so the folders, which expire, sit apart from
  `tables/` and `state/`, which never do: no rule on `evidence/…` can reach
  them.
- **Then `trust`.** R2 lifecycle rules and bucket locks match by key prefix
  only, so main's runs and everything else need different prefixes to get
  different retention, and a run of main's workflow never shares a namespace
  with a pull request's (the lesson of CREEP,
  [below](#skipping-ci-when-a-trusted-run-proves-it)). `main` is a push or
  schedule on `refs/heads/main` whose tree on disk is the pushed commit's;
  `pr` is everything else, dispatches included, and so is a `depot ci run`
  from a laptop: on 2026-09-24 one run from a clean `main` checkout got
  `GITHUB_EVENT_NAME=api` and `GITHUB_REF=refs/heads/main`, and one with
  local changes has them applied as a patch, so its tree is not the
  commit's either way.
- **Only what a Depot OIDC token's claims give.** The token carries `ref` and
  `event_name` (so `trust`), `iat` (the date), and `job_id`, but no job
  attempt id and no job name
  ([claims](https://depot.dev/docs/ci/oidc)). So the notary that later mints
  credentials ([below](#credentials)) can derive everything down to
  `job=<job_id>/` itself, and the job picks only the last segment, its own
  attempt's folder, which write-once PUTs keep it from reusing. Today the date
  is the UTC day the manifest was written, and the job id is
  `DEPOT_JOB_URL`'s `job=`; that it equals the `job_id` claim is unverified
  until one job requests a token.
- The `key=value` segments are Hive-style: DuckDB's `hive_partitioning` turns
  them into `trust`, `date` and `job` columns and skips whole prefixes by
  them.
- **The tables' copy.** Before the manifest, the upload PUTs
  `tables/tests.parquet` again under `tables/tests/` (not for a cancelled
  run). The loader lists that prefix, one object per run, instead of every
  object under `evidence/` (about 7 million a year), and it never expires,
  so a rebuild of the catalog can replay every run, not only the last
  year's folders. The run's manifest, at the same `trust`, `date` and `job`
  under `evidence/`, is the commit point for the copy too: the loader skips
  a copy whose manifest is not there, so a failed upload leaves nothing half
  loaded, and there is no copy that never gets loaded.

### Addressed by run, verified by content

Files keep their paths under the run's prefix rather than living at
`sha256/<hash>` keys, because the folder has to work as a folder: Playwright's
HTML report loads its traces and screenshots by relative path, and a viewer
serving `…/playwright-html/` from R2 needs them beside it.

That costs some repetition. In a failing Preview OS folder measured on
2026-09-24 (68 files, 9.9 MB), about 4.7 MB were copies: the HTML report
copies every `trace.zip` and `test-failed-*.png` from `playwright-output/`
into its `data/` byte for byte, and its trace viewer's scripts, styles and
fonts (about 1.3 MB) are the same in every failing run. A passing folder
repeats little. At the [costs below](#sizes-and-costs) that is a few dollars a
month, not worth a viewer that resolves every path through the manifest. If
failing runs come to dominate, the upload can skip a `playwright-output/` file
whose sha256 the report's `data/` already holds, with the manifest recording
both paths.

Content still decides what is accepted. Each of these was checked against the
bucket on 2026-09-24:

- The upload hashes each file again as it reads it and refuses one that no
  longer matches the manifest, before sending it. It then signs that sha256
  as the SigV4 payload hash (`x-amz-content-sha256`), so R2 also refuses a
  body that changed on the way: a PUT whose header does not match its body
  gets `400 XAmzContentSHA256Mismatch`
  ([SigV4](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html)).
- Every PUT is write-once (`If-None-Match: *`,
  [supported by R2](https://developers.cloudflare.com/r2/api/s3/api/)): an
  existing key answers 412 and is never replaced. A 412 on a key that already
  holds the very bytes being sent (a single PUT's ETag is the body's MD5) is
  this upload's own earlier try, landed after all, or the step run again; the
  upload goes on. Other bytes at that key fail it.
- The manifest goes last, after every file and the tables' copy. A folder
  whose manifest is in R2 is complete, and the manifest's own sha256 is the
  content address of the whole run: anyone holding it can re-hash every
  file.
- Keys carry `=` percent-encoded (`trust%3Dpr`), as S3 clients sign them; R2
  stores them decoded.

The upload sends one request per object, eight at a time. A Cloudflare 5xx, a
429 or no answer at all is sent again up to three times, after 1, 2 and 4
seconds or what a 429's `Retry-After` asks (up to 5), and each retry logs a
warn whose `event` is `test-evidence.platform-failure-retry`
([engineering invariant](engineering-invariants.md)); the summary line counts
them. A request times out after 60 seconds, and 90 seconds into the upload
the request in flight is aborted and no retry starts: the e2e job is a pull
request's slowest check, a healthy upload adds about five seconds to it, and
this evidence decides nothing, so a degraded R2 costs it at most about a
minute and a half. Anything else, a 4xx included, or a fourth failure, fails
the step: the warning annotation and the summary line say why, the e2e jobs'
folder is still in their Depot artifact, and without a manifest nothing
downstream picks the partial folder up.

### Reading it back

The upload step's log and the job's summary give the run's prefix. With the
same token, from the repository root:

```sh
doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 object get "iterate-ci/<prefix>manifest.json" --remote --pipe
doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 object get "iterate-ci/<prefix>playwright-html/index.html" --remote --file index.html
```

Every file the manifest lists is at `<prefix><path>`, its bytes hashing to
the listed sha256.

### Sizes and costs

Measured on real artifacts from 2026-09-24:

| Test run (passing) | Files | Unzipped | Of which                                                                                                                     |
| ------------------ | ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Test job attempt   | 18    | 3.8 MB   | raw telemetry 2.8 MB, flake suite summary 0.65 MB, `tests.parquet` 0.26 MB (about 2,300 rows), CTest's JUnit XML 0.01 MB     |
| Preview OS e2e     | 38    | 3.6 MB   | telemetry 1.4 MB, HTML report 0.7 MB, 18 screenshots 0.65 MB, JSON results 0.68 MB, `tests.parquet` 0.06 MB (about 370 rows) |

Each is this change's own run's folder; the upload adds the manifest and the
table's copy, so 20 and 40 objects.

A failing Preview OS attempt with two failed specs was 68 files and 9.9 MB:
two `trace.zip` files of 2.35 MB together, their copies in the report, and
the report's trace viewer. Depot ran 178 to 377 pull-request runs and 173 to
384 push runs a day from 2026-09-21 to 2026-09-23; assume at most 500 Test
and 300 e2e job attempts a day (PostHog's `ci job attempt finished` can
confirm it). At [R2 Standard pricing](https://developers.cloudflare.com/r2/pricing/)
($0.015 per GB-month after 10 GB free, Class A $4.50 per million after 1
million free, no egress fees):

- **Volume**: about 2.6 GB a day before failures, 80 GB a month. Assume
  half of it main's and half pull requests' (the run counts above split
  about evenly).
- **Storage** at steady state: main's folders for 365 days, about 475 GB;
  pull requests' for 90 days, about 120 GB; the tables' copies, about 140 MB
  a day and never deleted, about 50 GB a year. About 650 GB, **about $10 a
  month**, the tables adding under $1 a month for every year kept. Keeping
  pull requests' folders a year too would be about $15.
- **Writes**: about 21,000 PUTs a day, 630,000 a month. The free million
  Class A operations are the whole dev/preview account's, previews
  included, so count on paying for them: **about $3 a month**.

Raw telemetry JSON compresses about 16× (a Test attempt's 2.6 MB zips to
165 KB). Storing it gzipped would cut storage by two thirds but make every
reader decompress; not worth it at these prices.

### Retention

Lifecycle rules on `iterate-ci`, set when it was created ([setup](#setup)):

- `evidence/ci/trust=main/`: deleted 365 days after upload
  (`evidence-main-after-365-days`).
- `evidence/ci/trust=pr/`: 90 days (`evidence-pr-after-90-days`). Most of
  the volume, and a pull request's evidence matters while it is open and for
  the flake history after.
- `evidence/local/`: 30 days (`evidence-local-after-30-days`), in place
  before any laptop writes there.
- `tables/` and `state/`: never deleted. Every run's rows, so the catalog can
  always be rebuilt from R2, and (_next_) the guards' memory.
- R2's own default rule aborts incomplete multipart uploads after 7 days; the
  upload makes none.
- **No bucket lock is set.** A [bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
  on `evidence/ci/trust=main/` and `tables/` for 30 days would keep anyone,
  CI's token included, from deleting or overwriting them; a lock takes
  precedence over a lifecycle rule, and 30 days is shorter than every
  expiry. It is a [decision to confirm](#decisions-to-confirm), with the
  commands in [setup](#setup).
- The catalog's rows (_next_) are kept indefinitely; its snapshot expiration
  deletes superseded data files, never rows. A year of `ci.tests` is about
  50 GB, under a dollar a month.

Nothing in CI deletes objects.

### Credentials

- **CI, this PR: the token CI already has.** The upload uses Doppler
  `_shared/preview`'s `CLOUDFLARE_API_TOKEN`, the user API token preview
  deploys use and the one that created the bucket, so no secret was added.
  An API token with R2 permissions is also an S3 key pair: its id is the
  access key id (the upload asks Cloudflare's `GET /user/tokens/verify` for
  it) and the SHA-256 of its value is the secret
  ([R2 authentication](https://developers.cloudflare.com/r2/api/tokens/#get-s3-api-credentials-from-an-api-token)).
  The upload speaks S3 rather than the Cloudflare API's object endpoint,
  which `wrangler r2 object put` uses, because on 2026-09-24 that endpoint
  replaced an existing object despite `If-None-Match: *`, stored a body whose
  `Content-MD5` was wrong, and counted every request against the token
  owner's 1,200 per five minutes, which preview deploys share (a failing e2e
  folder is about 70 objects). The S3 endpoint refused both and has no such
  limit. Wrangler still reads objects back ([above](#reading-it-back)).
- **What that token can do.** It reaches every bucket on the account, deletes
  included, and every CI job holding `DOPPLER_TOKEN` can read it, pull
  request jobs included. Write-once PUTs only keep the honest uploader from
  replacing a run's evidence; they are no defence against the token, which
  can plant, replace or delete any object, `trust=main` and `tables/`
  included, and no bucket lock is set. That is acceptable while evidence
  proves nothing and no guard keeps its memory in the bucket; it is not
  acceptable once evidence can
  [skip CI](#skipping-ci-when-a-trusted-run-proves-it). It is also why there
  is [one bucket](#one-bucket).
- **CI, next: no long-lived key.** Depot CI issues
  [OIDC tokens](https://depot.dev/docs/ci/oidc) to jobs with
  `permissions: id-token: write`: issuer `https://identity.depot.dev`, keys at
  `/keys`, five minutes' lifetime, and GitHub-compatible claims
  (`repository`, `ref`, `sha`, `event_name`, `workflow`, `workflow_ref`,
  `workflow_sha`, `run_id`, `run_attempt`, `actor`) plus Depot's `org_id` and
  `job_id`. The upload presents one to a notary: a small Worker of its own,
  not the public ci-reports viewer, because it holds the parent key that
  mints credentials. The notary checks the token, **derives**
  `evidence/ci/trust=…/date=<iat>/job=<job_id>/` and the matching
  `tables/tests/…` prefix from the claims ([object keys](#object-keys)),
  returns them, and mints
  [temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
  by local signing with the parent key (an HS256 JWT; no API call), scoped to
  `PutObject` on those prefixes for an hour. The upload uses the prefixes it
  is given, so a run that straddles midnight is filed under the token's day.
  When the manifest lands, the notary signs its sha256 with a key only it
  holds. The test jobs then stop using the account token for R2. (Sigstore's
  keyless signing is not an option: its Fulcio does not trust Depot's
  issuer.)
- **Laptops and agents** (_next_) never get CI's token. The same endpoint
  checks the caller's GitHub token belongs to an iterate org member and mints
  credentials for `evidence/local/…/user=<login>/<testRunId>/` only. An agent
  on someone's laptop uses that person's `gh` login, so it can write only
  under their prefix, and its manifest says `local`, never CI.

## Downstream of R2

| Reader                                                                                                    | Today                                                                                                                                                                  | Reading R2 (_next_)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ci-reports viewer (`apps/ci-reports`)                                                                 | Proxies `public-*` Depot artifacts with range reads; links die with the artifact, after about a week                                                                   | An R2 binding serves `…/<testRunId>/playwright-html/` and the CI trace, and links live as long as the evidence. R2 bindings have no read-only mode, so the Worker's code only reads, and it serves those two paths only ([exposure](#what-a-public-report-exposes))                                                                                                                                                                                      |
| PR body and the "Playwright report" / "CI trace" statuses                                                 | Link the viewer by Depot artifact                                                                                                                                      | Link it by the run's prefix, which the upload step prints                                                                                                                                                                                                                                                                                                                                                                                                |
| PostHog job events (`sync-ci-telemetry.ts`)                                                               | Job-level, from Depot's API. A test evidence job's `ci job attempt finished` has `test_run_id` and `test_evidence_uploaded` (this PR, [a failed step](#a-failed-step)) | The home of job-level analytics (queue and run time, time to green with `pr-ttg-guard.ts`). The event gains the manifest's `result`. Per-test rows never go to PostHog (they were 70% of its ingestion)                                                                                                                                                                                                                                                  |
| The flake dashboard (`flake-dashboard/update.ts`)                                                         | Lists `flake-records-*` Depot artifacts hourly, and parses their JSONL and `suite-summary.json`                                                                        | Reads `ci.tests` (`flake_kind`, `flake_outcomes`, `passed_after_retry`) once the loader runs, so the flake records have one parser, the writer's; the fold is unchanged                                                                                                                                                                                                                                                                                  |
| Main OS e2e's alert (`main-e2e-alert.ts`)                                                                 | Reads the folder inside the job                                                                                                                                        | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The guards' memory (`pr-ttg-state`, `flake-dashboard-state`, `os-latency-state`, `prd-fault-alarm-state`) | A Depot artifact each guard overwrites, written only by its own runs (the prd fault alarm's only on `main`); a guard that does not run for a week forgets              | Stays in Depot artifacts until jobs have [scoped credentials](#credentials). With CI's account token any pull request's job could reset or forge a guard's memory, and a forged "already paged" would silence the prd fault alarm. Then `state/<guard>.json`, written only with that guard's credential and compare-and-swap (`If-Match` on the ETag it read, `If-None-Match: *` for the first), so two runs cannot overwrite each other; never expiring |
| Depot artifacts                                                                                           | Every reader's source                                                                                                                                                  | Kept while R2 proves itself. Once every job attempt's manifest has reached R2 for two weeks, drop the duplicates (the separate telemetry and flake-record artifacts, `public-playwright-report`), then keep one folder artifact per attempt as the fallback for an R2 outage                                                                                                                                                                             |

Three things summarize a job attempt today: the finalizer's
`ci-telemetry/manifest.json`, the flake suites' `suite-summary.json`, and
this manifest with its table. This manifest copies the finalizer's check
rather than restating it, and the flake dashboard moving to `ci.tests` retires
the second parser; `suite-summary.json` stays until then.

### What a public report exposes

A failing run's `playwright-output/<test>/trace.zip` holds the browser's
network traffic, preview sign-in included, and the HTML report copies every
trace byte for byte into `playwright-html/data/`. So serving
`playwright-html/` serves the traces. That is already true today:
`public-playwright-report` is the same folder, open to anyone who has the
viewer link. Serving it from R2 keeps the exposure and makes it last as long
as the evidence, a year for main. The link names the run
(`…/job=<id>/testrun_<id>/`), which the PR statuses print. Whether the viewer
keeps serving traces, or serves the report without `data/` and leaves the
traces to people with R2 access, is a [decision](#decisions-to-confirm).

## Analytics: per-test rows, map-reduced over R2

The goal is questions like "p95 of every test over two weeks" or "flake rate
of every Playwright spec on main", down to the individual test, without
downloading anything.

### Options

All three Cloudflare products are in open beta, and all three have billed
since 2026-08-03
([catalog](https://developers.cloudflare.com/changelog/product/r2-data-catalog/),
[R2 SQL](https://developers.cloudflare.com/changelog/product/r2-sql/),
[Pipelines](https://developers.cloudflare.com/changelog/product/pipelines/)).
R2 SQL queries "Apache Iceberg tables managed by R2 Data Catalog", nothing
else ([R2 SQL](https://developers.cloudflare.com/r2-sql/)), so the rows have
to be written into one. The question is who writes them.

| Option                                                                                                                                                                                                                        | For                                                                                                                                                                                                                                                                                              | Against                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DuckDB over the tables' copies under `tables/tests/`**                                                                                                                                                                      | Works the day the bucket exists; no other service                                                                                                                                                                                                                                                | Someone runs DuckDB; a year is about 290,000 small files, slow to open; no Worker can run it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **An hourly loader that owns the tables**: DuckDB (1.4 or later) attached to the [R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/config-examples/duckdb/), inserting each new folder's rows               | The folders already hold Parquet, so nothing is converted; one writer, so idempotency and schema changes are ours (`ALTER TABLE` works on Iceberg in [DuckDB](https://duckdb.org/docs/current/core_extensions/iceberg/writing)); no queue, notification or stream to run; about 24 commits a day | DuckDB's Iceberg writer is young (writes since late 2025). Cloudflare's DuckDB page says "DuckDB does not currently support DELETE on partitioned tables", while DuckDB's own current docs say UPDATE and DELETE work on partitioned tables (merge-on-read), and list MERGE INTO: the loader pins one DuckDB version and its test runs what it relies on. Rows arrive up to an hour late; no Worker can run it                                                                                                                                                                                                                     |
| [Pipelines](https://developers.cloudflare.com/pipelines/): an R2 notification on each manifest, a queue consumer in `apps/ci-reports` reading the Parquet and sending JSON rows to a stream, a catalog sink writing the table | Rows in minutes; exactly-once from stream to table                                                                                                                                                                                                                                               | Streams, sinks and pipelines cannot be changed after creation ([manage sinks](https://developers.cloudflare.com/pipelines/sinks/manage-sinks/)), and "Sinks cannot be created for existing Iceberg tables" ([R2 Data Catalog sink](https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2-data-catalog/)), so every new column is a new stream, sink, pipeline and table; a row that does not match the stream's schema is accepted and then dropped ([writing](https://developers.cloudflare.com/pipelines/streams/writing-to-streams/)); the queue delivers at least once, so duplicates; Parquet to JSON and back |
| Register the tables' copies in Iceberg with PyIceberg `add_files`                                                                                                                                                             | No copy                                                                                                                                                                                                                                                                                          | The copies would become the catalog's files: compaction rewrites them and snapshot expiration then deletes them, taking with them the copies a rebuild replays; needs Python                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Choice: the hourly loader writes `ci.tests` and `ci.runs` in a catalog on
`iterate-ci`, and R2 SQL reads them. DuckDB over the folders
works from day one and stays the fallback.** The deciding fact is that a
Pipelines sink is frozen at creation, while this table gained a column
(`test_run_id`) within this PR alone, and a dropped row is silent. If
minutes ever matter more than that, Pipelines can feed a second table later
from the same folders, with a small fixed schema and one JSON `extra` column.

### The path (_next_)

```text
CI job: test-results/ ──PUT──▶ iterate-ci  evidence/ci/trust=…/date=…/job=…/<testRunId>/…, manifest.json,
                                            then tables/tests/trust=…/date=<day>/job=…/<testRunId>.parquet
                                      │
                                      │ hourly Depot workflow, one run at a time (concurrency group)
                                      ▼
            loader: DuckDB, pinned, ATTACH the catalog, list today's and yesterday's tables' copies,
                    skip test_run_ids the tables already hold, read those runs' manifests and rows
                                      │ one INSERT per table = one Iceberg commit
                                      ▼
            iterate-ci's R2 Data Catalog: ci.tests, partitioned by day(started_at); ci.runs
            compaction and snapshot expiration on
                                      │
                                      ▼
             R2 SQL: wrangler r2 sql query, the REST API from a Worker, the dashboard SQL editor
```

The loader's only state is the tables. Each hour it lists
`tables/tests/trust=*/date=<today>/` and yesterday's (a run is dated by its
manifest's day, so an hour's runs can land after midnight), keeps the runs
whose `test_run_id` is not yet in `ci.tests` and whose manifest is in R2
(the copy lands before it, [object keys](#object-keys)), and inserts their
rows in one statement, which Iceberg commits atomically. Then it merges the same runs'
manifests into `ci.runs` (`MERGE INTO … ON test_run_id`, inserting only runs
it lacks). Each commit is idempotent on its own: run twice, the loader
inserts nothing the second time, and a crash between the two is repaired by
the next hour. A backfill or rebuild is the
same loader over older date prefixes of `tables/`, which never expire. Each
day it also checks every run's summed `testCount` in `ci.runs` against its
rows in `ci.tests`, and fails loudly on a difference. It uses CI's
`CLOUDFLARE_API_TOKEN` once that token also has the catalog's permissions
([setup](#setup)), and gets a token of its own only when jobs get scoped
credentials ([one bucket](#one-bucket)).

### Tables

`ci.runs`: one row per manifest (`test_run_id`, `result`, the `source`,
`runner`, `target` and `timings` fields flattened, the completeness lists and
`diagnostics` as JSON, and the runners' `testCount` summed). `ci.tests`: the rows of `tables/tests.parquet`,
one per test the runners reported, skipped tests included. Its columns
(`scripts/ci/test-results-parquet.ts`; a test holds this table to that file):

| Column                  | Type      | Meaning                                                                                                                                                                          |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_run_id`           | STRING    | The folder's `testRunId`: joins a row to its manifest and its evidence                                                                                                           |
| `repository`            | STRING    | `iterate/iterate`                                                                                                                                                                |
| `workflow_name`         | STRING    | Workflow display name (`Test`, `Preview OS`)                                                                                                                                     |
| `workflow_run_id`       | STRING    | `GITHUB_RUN_ID` as Depot sets it                                                                                                                                                 |
| `workflow_run_attempt`  | STRING    | `GITHUB_RUN_ATTEMPT`                                                                                                                                                             |
| `job_name`              | STRING    | `GITHUB_JOB` (`test`, `e2e`)                                                                                                                                                     |
| `job_attempt_id`        | STRING    | Depot's job attempt id                                                                                                                                                           |
| `depot_job_url`         | STRING    | The job attempt's Depot page                                                                                                                                                     |
| `head_sha`              | STRING    | The tested PR head or main commit (`TEST_TELEMETRY_HEAD_SHA`)                                                                                                                    |
| `branch`                | STRING    | Source branch (`main` for main pushes)                                                                                                                                           |
| `pull_request_number`   | INT32     | Null outside pull requests                                                                                                                                                       |
| `producer`              | STRING    | `vitest-retry-telemetry-reporter` or `playwright-telemetry-reporter`                                                                                                             |
| `framework`             | STRING    | `vitest` or `playwright`                                                                                                                                                         |
| `test_kind`             | STRING    | `unit`, `integration` or `e2e`                                                                                                                                                   |
| `workspace`             | STRING    | pnpm workspace the runner ran in (`os`, `@iterate-com/shared`, `iterate-root`)                                                                                                   |
| `test_project`          | STRING    | Playwright project (`os`, `voice`, …); null for Vitest                                                                                                                           |
| `module_path`           | STRING    | Test file, relative to the repository root                                                                                                                                       |
| `full_name`             | STRING    | Suite path and title as the runner names it                                                                                                                                      |
| `leaf_name`             | STRING    | Bare title, the name flake records and the flake dashboard use                                                                                                                   |
| `test_line`             | INT32     | Line of the test in `module_path` (Playwright)                                                                                                                                   |
| `state`                 | STRING    | Final state: `passed`, `failed`, `skipped`, `timedout`, …                                                                                                                        |
| `expected_state`        | STRING    | `passed`; `failed` for createFlake/createFailing/`test.fails`; `skip`                                                                                                            |
| `outcome`               | STRING    | Playwright's verdict: `expected`, `unexpected`, `flaky`, `skipped`                                                                                                               |
| `retry_count`           | INT32     | Retries the runner made                                                                                                                                                          |
| `passed_after_retry`    | BOOLEAN   | A retry rescued it                                                                                                                                                               |
| `started_at`            | TIMESTAMP | When the test started, by the runner's clock (UTC, milliseconds)                                                                                                                 |
| `duration_ms`           | DOUBLE    | The runner's reported duration                                                                                                                                                   |
| `configured_timeout_ms` | DOUBLE    | The test's timeout                                                                                                                                                               |
| `first_failure`         | STRING    | First failed attempt's error text                                                                                                                                                |
| `errors`                | JSON      | Final errors: `[{ name?, message, stack? }]`; null when none                                                                                                                     |
| `attempts`              | JSON      | `[{ attemptIndex, state, durationMs, startedAt?, error? }]` when the runner reports attempts (Playwright); null otherwise. Playwright's per-step phases stay in the raw artifact |
| `tags`                  | JSON      | Test tags; null when none                                                                                                                                                        |
| `flake_kind`            | STRING    | `flake` (createFlake) or `failing` (createFailing); null for other tests                                                                                                         |
| `flake_pattern`         | STRING    | The wrapper's tracked-error pattern                                                                                                                                              |
| `flake_outcomes`        | JSON      | Its records' outcomes, one per recorded run: `["pinned-fail"]`, `["flake-fail","pass"]`                                                                                          |

Kind `unknown` flake records are not joined: they restate a plain test's
`passed_after_retry` and final `state`, which the row already has. A
createFlake or createFailing record that names no test, or more than one,
is on no row and is named in the manifest's `diagnostics`, never silently
dropped and never the reason a folder has no manifest.

Vitest reports one aggregate duration and retry count per test, not each
attempt's ([ci-test-telemetry.md](ci-test-telemetry.md)), so a retried Vitest
row's `duration_ms` is not a clean sample. The queries below rank passed rows
with no retry.

In the catalog, `ci.tests` is partitioned by `day(started_at)`, and the JSON
columns are strings, since Iceberg has no JSON type; R2 SQL's JSON functions
read them. A new column in `tests.parquet` is an `ALTER TABLE … ADD COLUMN` in
the loader, older rows reading null.

Later tables (_next_): `ci.test_attempts` (Playwright attempts and their
steps) and `ci.modules` (Vitest module import and collect costs). Job-level
questions, such as where a pull request's time to green goes, stay with
PostHog's `ci job attempt finished` events and `pr-ttg-guard.ts`; a
`ci.spans` table from the CI trace would only be for step-level questions
they cannot answer.

### Example queries (R2 SQL)

Each query takes its time bound as an RFC3339 string, the form R2 SQL's
[reference](https://developers.cloudflare.com/r2-sql/sql-reference/)
documents; the caller computes it (here, 14 days before 2026-09-24).

Slowest tests on main, p95 over 14 days:

```sql
SELECT module_path, full_name, test_project,
       count(*) AS runs,
       approx_percentile_cont(duration_ms, 0.95) AS p95_ms,
       approx_median(duration_ms) AS median_ms
FROM ci.tests
WHERE started_at >= '2026-09-10T00:00:00Z'
  AND branch = 'main' AND state = 'passed' AND retry_count = 0
GROUP BY module_path, full_name, test_project
HAVING count(*) >= 10
ORDER BY p95_ms DESC
LIMIT 25;
```

Flake rate per test on main (plain tests; wrapped ones are counted by their
records):

```sql
SELECT module_path, full_name, test_project,
       count(*) AS runs,
       sum(CASE WHEN passed_after_retry THEN 1 ELSE 0 END) AS rescued_by_retry,
       sum(CASE WHEN state IN ('failed', 'timedout') THEN 1 ELSE 0 END) AS failed,
       round(100.0 * sum(CASE WHEN passed_after_retry OR state IN ('failed', 'timedout') THEN 1 ELSE 0 END) / count(*), 2) AS flake_pct
FROM ci.tests
WHERE started_at >= '2026-09-10T00:00:00Z'
  AND branch = 'main' AND (expected_state IS NULL OR expected_state = 'passed')
GROUP BY module_path, full_name, test_project
HAVING sum(CASE WHEN passed_after_retry OR state IN ('failed', 'timedout') THEN 1 ELSE 0 END) > 0
ORDER BY flake_pct DESC
LIMIT 25;
```

Run one with `wrangler r2 sql query <warehouse> "<sql>"` and a token in
`WRANGLER_R2_SQL_AUTH_TOKEN`, or `POST
https://api.sql.cloudflarestorage.com/api/v1/accounts/<account>/r2-sql/query/iterate-ci`
with a Bearer header ([query data](https://developers.cloudflare.com/r2-sql/query-data/)).
R2 SQL is in beta and its grammar may change. `APPROX_PERCENTILE_CONT` and
`APPROX_MEDIAN` (since 2026-02-09), subqueries (since 2026-05-15) and window
functions with QUALIFY (since 2026-06-22) are in its
[changelog](https://developers.cloudflare.com/changelog/product/r2-sql/).
`now()`, `TIMESTAMP '…'` literals and `INTERVAL` arithmetic are in neither,
so the queries avoid them; try them with `EXPLAIN` once the table exists.

The same questions work today, before any of that, with DuckDB over the
tables' copies. Its R2 secret takes S3 keys: CI's token gives them as the
upload derives them ([credentials](#credentials)), or an R2 API token with
Object Read on the bucket gives its own:

```sql
CREATE SECRET iterate_ci (TYPE r2, KEY_ID '<token id>', SECRET '<sha256 of the token>', ACCOUNT_ID '376ef7ed81b0573f93524de763666c15');

SELECT module_path, full_name, count(*) AS runs, quantile_cont(duration_ms, 0.95) AS p95_ms
FROM read_parquet('r2://iterate-ci/tables/tests/*/*/*/*.parquet', hive_partitioning = true, union_by_name = true)
WHERE trust = 'main' AND date >= current_date - 14 AND state = 'passed' AND retry_count = 0
GROUP BY ALL ORDER BY p95_ms DESC LIMIT 25;
```

A downloaded folder works too: `read_parquet('test-results/tables/tests.parquet')`.

### Volume and cost

About 1.3 million rows a day (500 Test attempts of 2,258 to 2,485 tests, 300
e2e attempts of about 370), about 140 MB a day as Parquet. The loader reads
that once and writes it once; its 48 commits a day are far inside the free
million catalog operations, and compacting 4 GB a month is inside the free
10 GB ([catalog pricing](https://developers.cloudflare.com/r2/data-catalog/platform/pricing/)).
A year of rows is about 50 GB of storage, under a dollar a month. A 14-day
query reads at most about 2 GB, usually a fraction since it reads only its
columns: under half a cent at $2.50 per TB scanned, with 10 GB a month free
([R2 SQL pricing](https://developers.cloudflare.com/r2-sql/platform/pricing/)).

The same rows through Pipelines would be about 1.2 KB each as JSON, 45 GB a
month, just inside the 50 GB of transforms and sinks Workers Paid includes
([Pipelines pricing](https://developers.cloudflare.com/pipelines/platform/pricing/)).

## Local and agent runs

_Next._ `pnpm evidence <command>` (for example `pnpm evidence pnpm spec`)
gives each run a folder of its own, then runs the command and writes the
manifest:

- **One folder per run.** Locally `test-results/` builds up: raw telemetry
  from every earlier run stays in `ci-telemetry/raw/`, and Playwright empties
  only `playwright-output/`. So `pnpm evidence` moves any existing
  `test-results/` aside (to `test-results.previous/`) before it starts,
  rather than letting `write` sweep up earlier runs.
- **Its own identity.** There is no Depot job attempt, so it generates the
  test run id (`testrun_<random base36>`), sets `TEST_TELEMETRY_ARTIFACT_DIR`
  and `FLAKE_RECORD_DIR`, and the writer takes a local identity where it
  takes `DEPOT_JOB_URL` today: `runner` becomes a union on `provider`
  (`depot` | `local`), the local one naming the user, the host and the agent
  when one ran it (Claude Code sets `CLAUDECODE=1`). `ciJobAttempt` refuses a
  laptop today on purpose, so nothing is mislabelled until then.
- With a GitHub login it uploads under `evidence/local/` with
  [temporary credentials](#credentials). Plain `pnpm test` and `pnpm spec`
  stay as they are.

Today a laptop keeps only the last `pnpm spec` run (Playwright empties its
output folder when it starts) and nothing from Vitest but its output. Locally
there are no retries, one worker, and the notes, voice and dash specs skip
rather than fail when their base URLs are unset. A local manifest records all
of that, which is one reason a local run proves less than CI. Local folders
are for analytics and debugging; CI never trusts them.

## Skipping CI when a trusted run proves it

_Future work._ The groundwork this PR lays: every CI manifest records the
result, the commit, the tree on disk, the lockfile hash, the runner, the
deployed target and every file's hash. Before trusting anything, measure:
how often does a pull request push's input key match one that already
passed? That is a query over `ci.runs`, once the manifests record the
per-workspace inputs below.

### The input key

A proof is keyed by what went into the run, recomputed by the verifier, never
taken from the claimant:

- **Per suite, not per tree.** A key over the whole merged tree changes with
  every merge to main, so it would almost never match, and "Measure" would
  find nothing. As Nx and Turborepo hash a task, the key is per test
  workspace (per Vitest workspace, and per Playwright project for the
  specs): that workspace's files, the files of the workspaces it depends on
  (pnpm's workspace graph), the lockfile's entries for its dependencies, and
  the root configs every suite reads (`vitest.config.ts`, the base
  `tsconfig`, `playwright.config.ts`, `.depot/workflows`). Each is computed
  on the pull request merged into main, not its head
  (`git merge-tree --write-tree origin/main HEAD` gives that tree without a
  checkout), before and after the run, and the two must be equal. The
  manifest does not record these digests yet; recording them per workspace
  is what the measure phase needs first.
- **The installed dependencies and toolchain.** The lockfile is not enough:
  `node_modules` can be linked or patched. A digest of the installed tree
  (the CI image's baked-store fingerprint in `scripts/depot-ci/dependencies.mjs`
  is the model), Node, pnpm, OS and architecture, and the Playwright browser
  revision.
- **Selection and behaviour**: the command and its arguments (no `-t`,
  `--project` or `.only`), and the names and values of the variables that
  change behaviour (`CI`, which changes retries and workers; `DEMO_BASE_URL`,
  `NOTES_BASE_URL`, `VOICE_BASE_URL`, `DASH_BASE_URL`; `VIDEO_MODE`,
  `E2E_REAL_MODELS`), never secret values.
- **The deployed target**, for suites that run against a preview: a content
  digest of each deployed bundle (the OS and each client's `dist`) and the
  Doppler config version, not Cloudflare's version ids, which change on every
  upload of an identical bundle. The verifier also asks each app's `/version`
  that it still runs those deployments. `target.json` records the OS
  preview's deployment id today, which attributes a run but is not yet a
  key. Bazel caches test results
  by action digest but always re-runs tests tagged `external`
  ([Bazel](https://bazel.build/reference/be/common-definitions)); likewise
  the first targets here are the hermetic suites: the Test job's unit and
  workers projects, and the Kit host tests.

### The proof

The manifest becomes an [in-toto](https://github.com/in-toto/attestation/blob/main/spec/predicates/test-result.md)
Statement: subject the tree, predicate `test-result/v0.1` with the result, the
input digest, the runner, the times, the full test inventory and the files'
hashes. CI checks completeness cheaply: `vitest list` and
`playwright test --list` on the same tree must match the manifest's inventory,
as the finalizer already checks workspaces today.

**Who signs:**

- **A Depot-hosted run**, including one an agent starts with
  [`depot ci run`](https://depot.dev/docs/cli/reference/depot-ci) on its
  local, unpushed tree. The job's Depot OIDC token goes to the notary
  ([credentials](#credentials)), which countersigns the manifest's sha256
  (a DSSE envelope around the Statement) with a key no build step can reach:
  SLSA's "provenance generated by the control plane"
  ([SLSA 1.2](https://slsa.dev/spec/v1.2/build-requirements)). The job's own
  steps can still write any result, so the verifier accepts only a run whose
  `workflow_sha` is main's workflow, and a pull request that changes
  `.depot/workflows/**` or a test config is never skipped. Nx's CREEP
  vulnerability (CVE-2025-36852) was exactly this: results built by a pull
  request landing where trusted builds read them
  ([Nx](https://nx.dev/blog/creep-vulnerability-build-cache-security)).
  `depot ci run` sends only tracked files, and which claims such a run's
  token carries is unverified; one test dispatch answers it.
- **A laptop or agent run.** A key on disk (Turborepo's signature key,
  [remote caching](https://turborepo.com/docs/core-concepts/remote-caching))
  proves who holds the key, not that tests ran. A hardware key that needs a
  person's touch proves a person approved, still not that tests ran. Only a
  local attestor that runs the pinned command itself, in a clean checkout as
  another OS user or in a VM, and signs its own result
  ([Witness](https://github.com/in-toto/witness)), has teeth. The
  recommendation: an agent that wants its run to count uses `depot ci run`.
- **External contributors**: never.

**Tamper evidence:** write-once objects under an `attestations/<input key>/<signer>`
prefix with a bucket lock, never replaced; the manifest's digest anchored in a
commit status the notary posts; CI re-running a random 10% of accepted
proofs, and revoking a signer's proofs after one mismatch. That makes lying
expensive rather than impossible.

### Threat model

| Actor                                                        | Trust                    | Main risks                                                                                                                                                                                                                          | Policy                                                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A person or agent, honest                                    | High intent, error-prone | A stale or dirty tree; the head tested instead of the merge; filtered or skipped suites (unset base URLs); another Node or browser; a local worker instead of the deployed one; an overloaded laptop's timeouts; no retries locally | The verifier recomputes the key and checks completeness                                                                                                                                              |
| An agent on the owner's machine                              | Mostly trusted           | Pressure to go green, so a fabricated or edited manifest; it can reach the owner's credentials, Doppler included                                                                                                                    | Signing is out of its reach (Depot plus the notary); spot re-runs; `depot ci run` rather than a local proof                                                                                          |
| A pull request author (internal)                             | Reviewed code only       | Edits a workflow or test config to skip tests and forge a pass (CREEP)                                                                                                                                                              | A change to workflows or test configs is never skipped; only main's `workflow_sha` counts                                                                                                            |
| An external contributor                                      | Untrusted                | Forged proofs                                                                                                                                                                                                                       | Never accepted; always runs in CI                                                                                                                                                                    |
| Anyone holding CI's Cloudflare token or another R2 write key | None                     | Planted, replaced or deleted objects, main's evidence and the tables' copies included                                                                                                                                               | Today none: write-once PUTs bind only the honest uploader, and no bucket lock is set. Next: a bucket lock, notary signatures, credentials scoped to one run's prefix, the guards' state out of reach |

### Phases

1. **Record** (this PR, the upload on): every CI run's manifest in R2. Then
   OIDC-scoped uploads and the tree before and after. Nothing is skipped.
2. **Measure**: how often a push's input key matches one that already passed.
3. **Reuse Depot-hosted passes** of hermetic suites, countersigned by the
   notary, from main's workflow only.
4. **Deployed suites**, keyed by bundle digests.
5. **Laptop proofs**: probably never; `depot ci run` covers the need. This
   departs from asking CI to trust a run on an agent's machine, so it is a
   [decision to confirm](#decisions-to-confirm).

## Setup

All on the dev/preview account (`376ef7ed81b0573f93524de763666c15`), with
Doppler `_shared/preview`'s `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. That token's calls to the catalog, R2 SQL and
Pipelines fail today ("Authentication error [code: 10000]", 80013, and a 403
from the catalog's REST endpoint), so 3 and 4 need permissions it does not
have yet.

1. **The bucket and its retention.** Done on 2026-09-24:

   ```sh
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket create iterate-ci
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle add iterate-ci evidence-main-after-365-days evidence/ci/trust=main/ --expire-days 365 --force
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle add iterate-ci evidence-pr-after-90-days evidence/ci/trust=pr/ --expire-days 90 --force
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle add iterate-ci evidence-local-after-30-days evidence/local/ --expire-days 30 --force
   # nothing expires tables/ or state/
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle list iterate-ci
   ```

   Not done ([a decision](#decisions-to-confirm)): nobody, CI's token
   included, could delete or overwrite main's evidence or the tables' copies
   for their first 30 days:

   ```sh
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lock add iterate-ci evidence-main-locked-30-days evidence/ci/trust=main/ --retention-days 30 --force
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lock add iterate-ci tables-locked-30-days tables/ --retention-days 30 --force
   ```

2. **The upload.** On in `test.yml`, `preview-os.yml` and `main-os-e2e.yml`
   (`TEST_EVIDENCE_UPLOAD: r2`), with no new secret. Check a run
   ([reading it back](#reading-it-back)).

3. **The catalog, for the loader** (with the PR that adds it). Add
   **Workers R2 Data Catalog Write** to CI's token in the dashboard (My
   Profile → API Tokens; it is a user token). Compaction and snapshot
   expiration run in Cloudflare with a token they keep, so they get one of
   their own, never CI's account-wide token: an Account API token limited to
   **Workers R2 Storage Write** and **Workers R2 Data Catalog Write** on
   `iterate-ci`. Read it into the environment rather than typing it into the
   command or the shell history:

   ```sh
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket catalog enable iterate-ci
   read -rs CATALOG_MAINTENANCE_TOKEN && export CATALOG_MAINTENANCE_TOKEN
   doppler run --project _shared --config preview -- sh -c 'pnpm --dir apps/os exec wrangler r2 bucket catalog compaction enable iterate-ci --target-size 128 --token "$CATALOG_MAINTENANCE_TOKEN"'
   doppler run --project _shared --config preview -- sh -c 'pnpm --dir apps/os exec wrangler r2 bucket catalog snapshot-expiration enable iterate-ci --older-than-days 7 --retain-last 10 --token "$CATALOG_MAINTENANCE_TOKEN"'
   # prints the warehouse name and the catalog URI the loader attaches
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket catalog get iterate-ci
   ```

   Wrangler takes that token only as `--token`, so it is in the process list
   while wrangler runs: run these where nobody else can list processes.
   `--token` stores it with `POST /accounts/<account>/r2-catalog/iterate-ci/credential`
   and the body `{"token": …}`, so sending that request with the body on
   stdin keeps it out of every command line.

   Then check that no lifecycle rule covers the prefix the catalog writes
   under; the three rules above cover `evidence/` only.

4. **A read-only token for queries**: an Account API token with **Workers R2
   SQL Read**, **Workers R2 Data Catalog Read** and **Workers R2 Storage
   Bucket Item Read**, used as `WRANGLER_R2_SQL_AUTH_TOKEN`:

   ```sh
   read -rs WRANGLER_R2_SQL_AUTH_TOKEN && export WRANGLER_R2_SQL_AUTH_TOKEN
   pnpm --dir apps/os exec wrangler r2 sql query "376ef7ed81b0573f93524de763666c15_iterate-ci" "SELECT count(*) FROM ci.tests"
   ```

   The R2 SQL page still asks for storage read and write, which predates
   read-only catalog tokens (2026-07-13); try read-only first
   ([query data](https://developers.cloudflare.com/r2-sql/query-data/),
   [catalog tokens](https://developers.cloudflare.com/r2/data-catalog/manage-catalogs/)).

No queue, event notification, stream, sink or pipeline is needed; the
[Pipelines option](#options) would add them.

## Decisions to confirm

- The names: the bucket `iterate-ci` and its prefixes `evidence/`, `tables/`
  and `state/`, `ciBucketEnvs` in `envs.ts`, and the workflow switch
  `TEST_EVIDENCE_UPLOAD` (`off` | `r2`).
- [One bucket](#one-bucket), written with CI's existing Cloudflare token,
  until jobs get scoped credentials.
- The key layout: `trust=main|pr` first, then the manifest's day and Depot's
  job id, every segment one a Depot OIDC token can prove; a dispatch counts
  as `pr`.
- Retention: main's folders 365 days, pull requests' 90, laptops' 30, the
  tables' copies, the guards' state and the catalog's rows kept (about $10 a
  month at steady state, plus about $3 of writes).
- Keeping today's paths inside `test-results/` rather than a new layout.
- `continue-on-error` on both steps, each bounded by a step timeout:
  evidence never decides a job, and a failed step is a warning, a line of
  the job's summary and `test_evidence_uploaded: false` in PostHog. A
  cancelled or timed-out job's folder is uploaded too, without a copy under
  `tables/`.
- Whether to set the 30-day bucket lock on `evidence/ci/trust=main/` and
  `tables/` ([setup](#setup)) now, while CI's token can delete anything.
- Whether the viewer serves Playwright traces from R2
  ([what a public report exposes](#what-a-public-report-exposes)).
- An hourly DuckDB loader, not Pipelines, as the catalog's only writer.
- CI's account token now, replaced by Depot OIDC and a notary Worker of its
  own before evidence can skip anything.
- **Laptop and agent runs never skip CI.** The ask was for CI to trust a run
  done on an agent's machine. The recommendation is that such a run counts
  only when the agent starts it on Depot (`depot ci run`), because nothing on
  a laptop can prove the tests ran rather than that someone holds a key
  ([who signs](#the-proof)). Laptop folders still go to R2 for analytics
  and debugging.
