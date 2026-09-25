# Test evidence

Every test run leaves evidence: raw telemetry, flake records, Playwright traces,
screenshots, videos and reports, logs, the CI trace. Depot artifacts carry it
to readers, but Depot keeps them about a week, though the workflows ask for 30
days: on 2026-09-24, main's runs up to 7 days old still listed their 15 or 16
artifacts, and every run from 8 to 35 days old listed none. So a ci-reports
link, a "Playwright report" status or a flake record is gone after a week.

So each test run in CI also writes **one folder, with one manifest, uploaded
straight to R2, into one bucket, `iterate-ci`**. The Test job and the E2E tests
and Browser specs jobs of Preview OS and Main OS e2e write it. The folder holds
the run's result, the deployed target of the e2e jobs, Kit's CTest results as
JUnit XML and the per-test Parquet rows. CI writes the bucket with the
Cloudflare API token it already holds. One reader is built: the
[flake dashboard](https://github.com/iterate/iterate/issues/2580) reads the
recent folders' flake records and suite summaries back every hour
([reading it back](#reading-it-back)). The other readers, the analytics, local
runs and skipping CI on a trusted run are designed, not built, and
[#3110](https://github.com/iterate/iterate/issues/3110) holds that design and its open decisions.

## The evidence folder

A **test run** is one CI job attempt that runs tests: the Test job, and the
E2E tests and Browser specs jobs of Preview OS and Main OS e2e. (A laptop run writes none, and nor
do the other workflows that run suites against a preview, such as the latency
and real-model guards: each would need the same write, upload and report steps
and a line in `testEvidenceJobs`.) Its folder is the repository's
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

### When deploy, e2e and specs are separate jobs

Since #3054, Preview OS and Main OS e2e run Deploy preview, then E2E tests
and Browser specs as jobs of their own. Each test job is its own test
run, with its own folder, `testRunId`, manifest, result and prefix in R2:

- its finalizer expects its own workspace in
  `TEST_TELEMETRY_EXPECTED_WORKSPACES`: `os` for E2E tests, `iterate-root`
  for Browser specs;
- the write and upload steps, and its flake-record upload, run in both jobs,
  each with its own `TEST_EVIDENCE_STEPS` (`e2e=…`, `specs=…`); on a PR, only
  once the suite started, since a job whose deploy failed has nothing to keep;
- `runSuite` (`apps/os/scripts/preview.ts`) runs one suite per job, each
  writing `target.json` before it starts, with the client apps for the specs;
- `public-playwright-report` comes from the Browser specs job.

Each job pays its own queue and setup (checkout, dependency reconcile,
Doppler, and Chromium for the specs), in parallel with the other; the CI
trace's Setup phase per job is where to measure what that costs.

A run against a preview that is already deployed (Preview OS's `action=test`,
`e2e` or `specs` dispatch, from `depot ci dispatch` or the dashboard) is a test
run like any other.
Its folder says both what it tested and with which tests: `target.json` names
the preview and the deployment its `/version` answered with just before the
suites started, and `source` names the tree the tests came from. They can
differ: that job checks out the pull request's head and merges it into
today's main, which need not be what the earlier deploy built. Comparing
`target.deploymentId` with the deploy's own `preview.json` tells which.

### How each producer writes into it

| Producer                                                                          | Writes                                                              | How it gets there                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Vitest, every unit workspace and the OS e2e suite (`retry-telemetry-reporter.ts`) | `ci-telemetry/raw/`                                                 | `TEST_TELEMETRY_ARTIFACT_DIR`, set by the workflows                                                  |
| Playwright telemetry reporter                                                     | `ci-telemetry/raw/`                                                 | the same variable                                                                                    |
| createFlake, createFailing, retried plain tests                                   | `flake-records/`                                                    | `FLAKE_RECORD_DIR`: test.yml, and `apps/os/scripts/preview.ts` per suite (from `testEvidencePaths`)  |
| Playwright output, HTML and JSON reporters                                        | `playwright-output/`, `playwright-html/`, `playwright-results.json` | `playwright.config.ts`, from `testEvidencePaths`                                                     |
| The telemetry finalizer                                                           | `ci-telemetry/manifest.json`, `suite-summary.json`                  | `scripts/ci/upload-test-telemetry.ts`                                                                |
| The evidence writer                                                               | `tables/tests.parquet`, then `manifest.json`                        | `scripts/ci/test-evidence.ts write`                                                                  |
| Kit firmware host tests (CTest)                                                   | `ctest/junit.xml`                                                   | `--output-junit`, which `pnpm --dir apps/kit firmware:test:host` passes to CTest; not yet table rows |
| The deployed target (e2e jobs)                                                    | `target.json`                                                       | `runSuite`, before the suite: the preview, the OS deployment `/version` names, the apps' URLs        |

Videos are off in CI: `playwright.config.ts` keeps them only under
`VIDEO_MODE=1` or on local failures, because retained videos left ffmpeg
workers holding the job open. When on, they land in `playwright-output/` and
travel with the folder like everything else.

The Vitest e2e suite, the Playwright specs and the telemetry reporters record
nothing unless `TEST_TELEMETRY_ARTIFACT_DIR` and `FLAKE_RECORD_DIR` are set, so
a laptop run records nothing today. Nothing configures Vitest coverage or a
JUnit or JSON reporter; the telemetry reporter's raw JSON is Vitest's record.

### What CI does

In each of those jobs, after the telemetry finalizer:

1. **Write the test evidence manifest**
   (`pnpm tsx scripts/ci/test-evidence.ts write`, `if: always()`,
   `--cancelled` when the job was, `continue-on-error`, two minutes at most).
   The workflow passes
   the outcome of every step that runs tests in `TEST_EVIDENCE_STEPS`
   (`tests=… kit-host-tests=…` in the Test job, `e2e=…` or `specs=…` in the
   others). It
   builds `tables/tests.parquet` from this attempt's raw telemetry and flake
   records, then hashes every file in the folder and writes `manifest.json`.
   On real artifacts it takes about half a second (37 files, 3.5 MB).
2. **Upload the test evidence to R2**
   (`pnpm tsx scripts/ci/test-evidence.ts upload`), `if: always()` when a
   manifest exists (`continue-on-error`, three minutes at most; Doppler
   `_shared/preview` supplies `CLOUDFLARE_API_TOKEN`). A cancelled or
   timed-out job's folder goes too, when the runner gives `always()` steps
   the time: its manifest says `cancelled`, and it gets no copy under
   `tables/`, since its rows stop part way and would skew durations. The
   step prints the run's prefix
   (`[test-evidence] r2://iterate-ci/evidence/ci/trust=pr/date=…/job=…/testrun_…/`)
   and writes it as a line of the job's summary. It runs in one `parallel:`
   block beside the Depot artifact uploads, since each only reads the folder
   ([parallel steps](depot-ci.md#parallel-steps)). The e2e jobs' artifacts
   keep the whole folder as `{preview,main}-os-test-artifacts-attempt-<id>`;
   the Test job's keep its telemetry and flake records, and its manifest
   reaches only R2.
3. **Report a test evidence step that could not**
   (`scripts/ci/test-evidence-unreported.sh`), after that block, when either
   step's outcome is `failure` ([below](#a-failed-step)).

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
- `target` is `target.json`, in the E2E tests and Browser specs jobs only
  ([above](#when-deploy-e2e-and-specs-are-separate-jobs)). Only the OS
  preview answers with its deployment (`/version`); the client apps answer
  `/healthz` with `ok`, so their deployments are not recorded.
- `source.commit` is the checked-out commit: on a pull request, the merge
  commit CI tests. `source.tree` is the tree of the files on disk when the
  manifest was written, uncommitted and untracked files included: a copy of
  the index gets `git add --all` and `git write-tree`, and the real index is
  untouched. `dirty` says it differs from the commit's tree. Ignored files,
  `test-results/` among them, are not in it. It is taken after the tests, so
  it shows what the run left, not what it started from.
- `runner` is the Depot job attempt and who started it (`GITHUB_EVENT_NAME`,
  `GITHUB_ACTOR`), plus the toolchain the job ran on. `trust` is `main` for a
  push or schedule on `refs/heads/main` that tested that commit (`source` not
  `dirty`, and `commit` the pushed head), and `pr` for everything else,
  dispatches included, since a dispatch can be told to test a pull request.
  A push to main whose tree was not the commit's is filed as `pr`, with a
  diagnostic saying why ([object keys](#object-keys)).
  Environment variables that change what the tests do (`CI`, the base URLs,
  `VIDEO_MODE`) are set in the runners' own steps, which this step cannot
  see, so the manifest does not record them.
- `timings` spans the first runner's start to the last runner's finish, by
  the runners' clocks; absent when no runner reported. Queue and setup time
  are Depot's and the CI trace's.
- `files` is every file but the manifest, sorted, with its size and sha256.

## Upload to R2

### One bucket

Everything CI keeps in R2 lives in one bucket, **`iterate-ci`**, on the
dev/preview account (`ciBucketEnvs.ci` in `envs.ts`):

| Prefix      | Holds                                                   | Expires                                     |
| ----------- | ------------------------------------------------------- | ------------------------------------------- |
| `evidence/` | Each test run's folder, under `evidence/ci/…`           | By lifecycle rule ([retention](#retention)) |
| `tables/`   | A copy of each run's `tests.parquet`, for later loading | Never                                       |

`evidence/local/` and `state/` are kept for laptop runs and the guards'
state, neither of which exists yet ([#3110](https://github.com/iterate/iterate/issues/3110)).

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
guard's own runs, until then. Bucket-wide settings are the other reason:
public access (an `r2.dev` URL, a custom domain) is per bucket, so this one
is never public, since that would expose every trace. Anything that must be
public gets a bucket of its own.

### Object keys

```text
evidence/ci/trust=<main|pr>/date=<YYYY-MM-DD>/job=<Depot job id>/<testRunId>/<path in the folder>
tables/tests/trust=<main|pr>/date=<YYYY-MM-DD>/job=<Depot job id>/<testRunId>.parquet
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
  with a pull request's (the lesson of Nx's CREEP vulnerability,
  CVE-2025-36852: a pull request's results landing where trusted builds
  read them). `main` is a push or
  schedule on `refs/heads/main` whose tree on disk is the pushed commit's;
  `pr` is everything else, dispatches included, and so is a `depot ci run`
  from a laptop: on 2026-09-24 one run from a clean `main` checkout got
  `GITHUB_EVENT_NAME=api` and `GITHUB_REF=refs/heads/main`, and one with
  local changes has them applied as a patch, so its tree is not the
  commit's either way.
- **Only what a Depot OIDC token's claims give.** The token carries `ref` and
  `event_name` (so `trust`), `iat` (the date), and `job_id`, but no job
  attempt id and no job name
  ([claims](https://depot.dev/docs/ci/oidc)). So a notary that mints
  credentials later ([#3110](https://github.com/iterate/iterate/issues/3110)) can derive everything down to
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
  run). A loader can list that prefix, one object per run, instead of every
  object under `evidence/` (about 7 million a year), and it never expires,
  so every run can be replayed, not only the last year's folders. The run's
  manifest, at the same `trust`, `date` and `job` under `evidence/`, is the
  commit point for the copy too: a copy whose manifest is not there is from
  a failed upload.

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

The per-test rows of many runs read as one table with DuckDB over the
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

The flake dashboard (`scripts/ci/flake-dashboard/evidence.ts`) lists
`evidence/ci/trust=<main|pr>/date=<day>/` for the last eight UTC days through
the S3 API, with the credentials the upload derives, and reads the
`flake-records/` files of the folders whose manifest is listed.

### Sizes and costs

Measured on real artifacts from 2026-09-24:

| Test run (passing) | Files | Unzipped | Of which                                                                                                                     |
| ------------------ | ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Test job attempt   | 18    | 3.8 MB   | raw telemetry 2.8 MB, flake suite summary 0.65 MB, `tests.parquet` 0.26 MB (about 2,300 rows), CTest's JUnit XML 0.01 MB     |
| Preview OS e2e     | 38    | 3.6 MB   | telemetry 1.4 MB, HTML report 0.7 MB, 18 screenshots 0.65 MB, JSON results 0.68 MB, `tests.parquet` 0.06 MB (about 370 rows) |

Each is one run's folder; the upload adds the manifest and the table's copy,
so 20 and 40 objects.

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
- `tables/` and `state/`: never deleted. Every run's rows, so a table built
  from them can always be rebuilt from R2.
- R2's own default rule aborts incomplete multipart uploads after 7 days; the
  upload makes none.
- **No bucket lock is set.** A [bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
  on `evidence/ci/trust=main/` and `tables/` for 30 days would keep anyone,
  CI's token included, from deleting or overwriting them; a lock takes
  precedence over a lifecycle rule, and 30 days is shorter than every
  expiry. Whether to set it is open ([#3110](https://github.com/iterate/iterate/issues/3110)).

Nothing in CI deletes objects.

### Credentials

- **CI: the token CI already has.** The upload uses Doppler
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
  acceptable once evidence can skip CI. Before then, jobs get credentials
  scoped to their own run's prefix, from Depot OIDC and a notary Worker
  ([#3110](https://github.com/iterate/iterate/issues/3110)). It is also why there is [one bucket](#one-bucket).
- **Traces.** A failing run's `playwright-output/<test>/trace.zip` holds the
  browser's network traffic, preview sign-in included, and the HTML report
  copies every trace byte for byte into `playwright-html/data/`. The bucket
  is private, but `public-playwright-report`, the same folder as a Depot
  artifact, is open to anyone with the viewer link, so it exposes them
  already.

## Tables

`tables/tests.parquet` has one row per test the runners reported, skipped
tests included. Its columns (`scripts/ci/test-results-parquet.ts`; a test
holds this table to that file):

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
row's `duration_ms` is not a clean sample: rank passed rows with no retry.

## Setup

All on the dev/preview account (`376ef7ed81b0573f93524de763666c15`), with
Doppler `_shared/preview`'s `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`.

1. **The bucket and its retention.** Done on 2026-09-24:

   ```sh
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket create iterate-ci
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle add iterate-ci evidence-main-after-365-days evidence/ci/trust=main/ --expire-days 365 --force
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle add iterate-ci evidence-pr-after-90-days evidence/ci/trust=pr/ --expire-days 90 --force
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle add iterate-ci evidence-local-after-30-days evidence/local/ --expire-days 30 --force
   # nothing expires tables/ or state/
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle list iterate-ci
   ```

   No bucket lock is set ([#3110](https://github.com/iterate/iterate/issues/3110) has the commands).

2. **The upload.** A step of `test.yml`, `preview-os.yml` and `main-os-e2e.yml`,
   with no new secret. Check a run
   ([reading it back](#reading-it-back)).
