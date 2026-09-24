# Test evidence

Every test run leaves evidence: raw telemetry, flake records, Playwright traces,
screenshots, videos and reports, logs, the CI trace. Today it sits under four
roots (`test-results/`, `apps/os/output/`, `ci-trace.ignoreme/` and the Depot
job logs), with no manifest, and reaches readers as Depot artifacts that expire
after 30 days or less. Asking "which tests got slower this week" means
downloading artifacts one run at a time.

The design: **one folder per test run, with one manifest, uploaded straight to
R2. Everything else reads R2.** That includes per-test analytics, which run as
SQL over R2 (DuckDB now, [R2 SQL](https://developers.cloudflare.com/r2-sql/)
next), and later a way for CI to skip a job that a trusted run already proved.

**Status.** This PR implements the first part: the folder layout, the manifest,
the per-test Parquet rows, and the R2 upload behind `TEST_EVIDENCE_UPLOAD`,
which is `off` in every workflow until the bucket exists
([owner steps](#owner-steps)). Sections marked _next_ are design only.

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
├── manifest.json                   written last; lists every other file with its sha256
├── tables/tests.parquet            one row per test, the analytics input
├── ci-telemetry/
│   ├── raw/<runner>.json           each runner's telemetry: one per Vitest workspace, one for Playwright
│   └── manifest.json               the finalizer's completeness check (upload-test-telemetry.ts)
├── flake-records/[<suite>/]*.jsonl createFlake / createFailing / retry lines, plus suite-summary.json
├── playwright-output/<test>/       trace.zip, test-failed-*.png, error-context.md, videos, spec screenshots
├── playwright-html/                Playwright's HTML report
└── playwright-results.json         Playwright's JSON reporter
```

### How each producer writes into it

| Producer                                                                          | Writes                                                              | How it gets there                                                                                       | Status      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------- |
| Vitest, every unit workspace and the OS e2e suite (`retry-telemetry-reporter.ts`) | `ci-telemetry/raw/`                                                 | `TEST_TELEMETRY_ARTIFACT_DIR`, set by the workflows                                                     | today       |
| Playwright telemetry reporter                                                     | `ci-telemetry/raw/`                                                 | the same variable                                                                                       | today       |
| createFlake, createFailing, retried plain tests                                   | `flake-records/`                                                    | `FLAKE_RECORD_DIR`: test.yml, and `apps/os/scripts/preview.ts` per suite (now from `testEvidencePaths`) | today       |
| Playwright output, HTML and JSON reporters                                        | `playwright-output/`, `playwright-html/`, `playwright-results.json` | `playwright.config.ts`, now from `testEvidencePaths`                                                    | today       |
| The telemetry finalizer                                                           | `ci-telemetry/manifest.json`, `suite-summary.json`                  | `scripts/ci/upload-test-telemetry.ts`                                                                   | today       |
| The evidence writer                                                               | `tables/tests.parquet`, then `manifest.json`                        | `scripts/ci/test-evidence.ts write`                                                                     | **this PR** |
| Kit firmware host tests (CTest)                                                   | `ctest/` (JUnit XML)                                                | `ctest --output-junit`; today they write only to `apps/kit/firmware/.build/host/Testing/`               | next        |
| Perf, soak, bench and real-model reports                                          | `os/`                                                               | move `apps/os/output/{perf-report,real-model-report}.json` and `soak/` here                             | next        |
| Step logs                                                                         | `logs/<step>.log`                                                   | fetched from Depot's API after the job; the bucket is private and the viewer never serves them          | next        |
| The CI trace                                                                      | `ci-trace/trace.{json,html}`, `tables/spans.parquet`                | the trace job, as its own test run folder                                                               | next        |

Videos are off in CI: `playwright.config.ts` keeps them only under
`VIDEO_MODE=1` or on local failures, because retained videos left ffmpeg
workers holding the job open. When on, they land in `playwright-output/` and
travel with the folder like everything else.

The Vitest e2e suite, the Playwright specs and the telemetry reporters record
nothing unless `TEST_TELEMETRY_ARTIFACT_DIR` and `FLAKE_RECORD_DIR` are set, so
a laptop run records nothing today.

### What CI does

In each of the three jobs, after the telemetry finalizer:

1. **Write the test evidence manifest** (`pnpm tsx scripts/ci/test-evidence.ts write`,
   `if: !cancelled()`, `continue-on-error`). It builds `tables/tests.parquet`
   from the raw telemetry and flake records, then hashes every file in the
   folder and writes `manifest.json`. In this change's own Preview OS run it
   took 0.56 s for 37 files (3.5 MB); on a Test attempt's real artifacts (17
   files, 3.3 MB) it took about half a second.
2. **Upload the test evidence to R2**, only when the workflow's
   `TEST_EVIDENCE_UPLOAD` is `r2` and a manifest exists (`continue-on-error`,
   Doppler `_shared/preview` for the keys).
3. The Depot artifacts as before. The Test job also keeps the whole folder as
   `unit-test-evidence-attempt-<id>`; the e2e jobs already kept it as
   `{preview,main}-os-test-artifacts-attempt-<id>`.

Neither step decides the job. The tests' own steps and the finalizer do.

### The manifest

`TestEvidenceManifest` (the same module) is the schema; readers parse with it.
The one this change's own Preview OS run wrote, abbreviated to one runner and
two of its 37 files:

```json
{
  "manifestSchemaVersion": 1,
  "testRunId": "testrun_1tf879r75h",
  "createdAt": "2026-09-24T13:15:47.062Z",
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
    "workflowName": "Preview OS",
    "workflowRunId": "227491187545774",
    "workflowRunAttempt": "1",
    "jobName": "e2e",
    "jobAttemptId": "1tf879r75h",
    "jobUrl": "https://depot.dev/orgs/0p91s0lz49/workflows/tnvgwdc563?job=7zncg7grdw&attempt=1tf879r75h",
    "trigger": "pull_request",
    "actor": "jonastemplestein",
    "node": "v24.21.0",
    "platform": "linux",
    "arch": "x64"
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
  and the `test_run_id` of every row in the folder's tables.
- `source.commit` is the checked-out commit: on a pull request, the merge
  commit CI tests. `source.tree` is the tree of the files on disk when the
  manifest was written, uncommitted and untracked files included: a copy of
  the index gets `git add --all` and `git write-tree`, and the real index is
  untouched. `dirty` says it differs from the commit's tree. Ignored files,
  `test-results/` among them, are not in it. The tree plus the lockfile hash
  is the start of the [input key](#skipping-ci-when-a-trusted-run-proves-it).
- `runner` is the Depot job attempt and who started it (`GITHUB_EVENT_NAME`,
  `GITHUB_ACTOR`), plus the toolchain the job ran on. Environment variables
  that change what the tests do (`CI`, the base URLs, `VIDEO_MODE`) are set in
  the runners' own steps, which this step cannot see; recording them is the
  reporters' job and part of the input key work, not this manifest's.
- `timings` spans the first runner's start to the last runner's finish, by
  the runners' clocks. Queue and setup time are Depot's and the CI trace's.
- `files` is every file but the manifest, sorted, with its size and sha256.

## Upload to R2

### Buckets

Two buckets on the dev/preview account (`envs.ts` has the first as
`testEvidenceEnvs.ci`), kept apart on purpose:

- **`ci-test-evidence`**: plain objects, the folders. It has lifecycle rules.
- **`ci-test-analytics`** (_next_): R2 Data Catalog enabled, the Iceberg
  tables. It never gets a lifecycle rule: a rule that deletes an Iceberg data
  file corrupts its table, and Cloudflare warns against manual deletes in a
  catalog bucket ([changelog](https://developers.cloudflare.com/changelog/product/r2-data-catalog/)).
  Retention there is snapshot expiration plus row deletes.

### Object keys

```text
ci/date=<YYYY-MM-DD>/workflow=<workflow>/job=<job>/<testRunId>/<path in the folder>
```

For example
`ci/date=2026-09-24/workflow=preview-os/job=e2e/testrun_90jkrkl44h/playwright-html/index.html`.
The date is the UTC day the first runner started; workflow and job are
lowercased with other characters replaced by `-`. The `key=value` segments are
Hive-style, so DuckDB's `hive_partitioning` turns them into `date`, `workflow`
and `job` columns and skips whole prefixes by them. Laptop runs get
`local/date=<day>/user=<github login>/<testRunId>/` (_next_), a separate top
prefix so they can have their own retention and never mix with CI's.

### Addressed by run, verified by content

Files keep their paths under the run's prefix rather than living at
`sha256/<hash>` keys, because the folder has to work as a folder: Playwright's
HTML report loads its traces and screenshots by relative path, and a viewer
serving `…/playwright-html/` from R2 needs them beside it. Deduplicating by
content would save little: Playwright's report already names its attachments
by hash, and nothing else repeats between runs.

Content still decides what is accepted:

- Every PUT signs the manifest's sha256 as the SigV4 payload hash
  (`x-amz-content-sha256`), so R2 refuses a file that changed after the
  manifest listed it
  ([SigV4](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html)).
- Every PUT is write-once (`If-None-Match: *`,
  [supported by R2](https://developers.cloudflare.com/r2/api/s3/api/)): an
  existing key fails with 412 and is never replaced.
- The manifest goes last. A folder whose manifest is in R2 is complete, and
  the manifest's own sha256 is the content address of the whole run: anyone
  holding it can re-hash every file.

The upload sends one request per object, eight at a time, and does not retry.
A failure fails the step, the folder stays in the job's Depot artifact, and
without a manifest nothing downstream picks the partial folder up.

### Sizes and costs

Measured on real artifacts from 2026-09-24:

| Test run (passing) | Files | Unzipped | Of which                                                                                                               |
| ------------------ | ----- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| Test job attempt   | 17    | 3.3 MB   | raw telemetry 2.6 MB, flake suite summary 0.43 MB, `tests.parquet` 0.25 MB (2,258 rows)                                |
| Preview OS e2e     | 37    | 3.3 MB   | telemetry 1.3 MB, HTML report 0.7 MB, 18 screenshots 0.65 MB, JSON results 0.55 MB, `tests.parquet` 0.06 MB (371 rows) |

A failing spec adds its `trace.zip` (retained on failure), typically a few
megabytes. Depot ran 178 to 377 pull-request runs and 173 to 384 push runs a
day from 2026-09-21 to 2026-09-23; assume at most 500 Test and 300 e2e job
attempts a day. At [R2 Standard pricing](https://developers.cloudflare.com/r2/pricing/)
($0.015 per GB-month after 10 GB free, Class A $4.50 per million after 1
million free, no egress fees):

- **Volume**: about 2.6 GB a day before failures, 80 GB a month.
- **Storage**: about 1 TB at a full year's retention, about $15 a month.
- **Writes**: about 20,000 PUTs a day, 600,000 a month, inside the free
  million.

Raw telemetry JSON compresses about 16× (a Test attempt's 2.6 MB zips to
165 KB). Storing it gzipped would cut storage by two thirds but make every
reader decompress; not worth it at $15 a month.

### Retention

- `ci/`: deleted 365 days after upload by a lifecycle rule. Per-test rows
  outlive it in the catalog.
- `local/` (_next_): 30 days.
- Optional tamper evidence: a [bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
  on `ci/` for 30 days, so nobody, CI's token included, can delete a fresh
  run's evidence.

Nothing in CI deletes objects.

### Credentials

- **CI**: an Account API token scoped to `ci-test-evidence` with Object Read &
  Write ([R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)).
  Its S3 keys are `TEST_EVIDENCE_R2_ACCESS_KEY_ID` and
  `TEST_EVIDENCE_R2_SECRET_ACCESS_KEY` in Doppler `_shared/preview`, which every
  CI job holding `DOPPLER_TOKEN` can read. Write-once keys limit what a leaked
  key can do to adding objects; it cannot replace a run's evidence.
- **Laptops and agents** (_next_) never get those keys. `apps/ci-reports`
  (already a Worker on the dev account) gets a credentials endpoint: it checks
  the caller's GitHub token belongs to an iterate org member, then mints
  [temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
  by local signing with the parent key (an HS256 JWT; no API call), scoped to
  `PutObject` on `local/…/user=<login>/<testRunId>/` for one hour. An agent on
  someone's laptop uses that person's `gh` login, so it can write only under
  their prefix, and its manifest says `local`, never CI.

## Downstream of R2

| Reader                                                    | Today                                                                                   | Reading R2 (_next_)                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ci-reports viewer (`apps/ci-reports`)                 | Proxies `public-*` Depot artifacts with range reads; links die with the 30-day artifact | A read-only R2 binding serves `…/<testRunId>/playwright-html/` and the CI trace. It serves only those two paths (the rest may hold browser traffic and logs), and links live as long as the evidence                                                                         |
| PR body and the "Playwright report" / "CI trace" statuses | Link the viewer by Depot artifact                                                       | Link it by test run id                                                                                                                                                                                                                                                       |
| PostHog job events (`sync-ci-telemetry.ts`)               | Job-level only, from Depot's API                                                        | Still job-level. `ci job attempt finished` gains `test_run_id` and the manifest's test counts, so an event links to its evidence. Per-test rows never go to PostHog (they were 70% of its ingestion)                                                                         |
| The flake dashboard (`flake-dashboard/update.ts`)         | Lists `flake-records-*` Depot artifacts hourly                                          | Lists the day's manifests by `ci/date=<today>/` prefix and reads their `flake-records/`; the fold is unchanged                                                                                                                                                               |
| Main OS e2e's alert (`main-e2e-alert.ts`)                 | Reads the folder inside the job                                                         | Unchanged                                                                                                                                                                                                                                                                    |
| Depot artifacts                                           | Every reader's source                                                                   | Kept while R2 proves itself. Once every job attempt's manifest has reached R2 for two weeks, drop the duplicates (the separate telemetry and flake-record artifacts, `public-playwright-report`), then keep one folder artifact per attempt as the fallback for an R2 outage |

## Analytics: per-test rows, map-reduced over R2

The goal is questions like "p95 of every test over two weeks" or "flake rate
of every Playwright spec on main", down to the individual test, without
downloading anything.

### Options

| Option                                                                                                                                                                                                            | For                                                                                             | Against                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DuckDB over the folders' `tables/tests.parquet`**                                                                                                                                                               | Works the day the bucket exists; no other service                                               | Someone runs DuckDB; a year is about 290,000 small files, slow to list and open; no Worker can run it                                                                                                    |
| **[R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/) (Iceberg) + [R2 SQL](https://developers.cloudflare.com/r2-sql/), rows sent by [Pipelines](https://developers.cloudflare.com/pipelines/)** | Managed; compaction keeps file counts down; a Worker or the dashboard's SQL editor can query it | Public/open beta; heavy queries may time out and `MEDIAN`/`PERCENTILE_CONT`/window functions are memory-gated ([limits](https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/)) |
| Register the folders' Parquet files in Iceberg with PyIceberg `add_files`                                                                                                                                         | No copy                                                                                         | The files must live in the catalog bucket, which cannot have lifecycle rules; needs Python; no mature JavaScript Iceberg writer                                                                          |

**Choice: R2 Data Catalog with R2 SQL, fed by Pipelines. DuckDB over the
folders works from day one and stays as the fallback.** R2 SQL reads only
Iceberg tables in a catalog, never loose Parquet
([limitations](https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/)),
so the rows have to be written into one. Pipelines is the only writer, which
avoids 800 jobs a day committing to the same table; its catalog sink creates
the table, rolls files at least every 60 seconds and delivers exactly once
([sink](https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2-data-catalog/)).

### The path (_next_)

```text
CI job: test-results/ ──PUT──▶ ci-test-evidence  …/<testRunId>/manifest.json (last)
                                      │ R2 event notification: object-create, prefix ci/, suffix manifest.json
                                      ▼
                             Queue ci-test-evidence-manifests
                                      │
                                      ▼
                    apps/ci-reports queue consumer
                      reads manifest.json and tables/tests.parquet (hyparquet runs in Workers)
                                      │ JSON rows, Pipelines stream binding
                                      ▼
            streams ci_tests, ci_runs ──▶ pipelines ──▶ sinks: ci-test-analytics, namespace ci
                                                            tables ci.tests, ci.runs (compaction on)
                                      │
                                      ▼
             R2 SQL: wrangler r2 sql query, the REST API from a Worker, the dashboard SQL editor
```

A backfill or a rebuild is a replay: list manifests by date prefix and queue
them again. A replay can duplicate a run's rows, so each row carries
`test_run_id` and a query that must be exact keeps one per test with `QUALIFY`.

### Tables

`ci.runs`: one row per manifest (`test_run_id`, the `source`, `runner` and
`timings` fields flattened). `ci.tests`: the rows of `tables/tests.parquet`,
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
fails the writer rather than being dropped.

Vitest reports one aggregate duration and retry count per test, not each
attempt's ([ci-test-telemetry.md](ci-test-telemetry.md)), so a retried Vitest
row's `duration_ms` is not a clean sample. The queries below rank passed rows
with no retry.

Later tables (_next_): `ci.test_attempts` (Playwright attempts and their
steps), `ci.modules` (Vitest module import and collect costs) and `ci.spans`
(the CI trace's jobs, phases and steps, one row per span).

### Example queries (R2 SQL)

Slowest tests on main, p95 over 14 days:

```sql
SELECT module_path, full_name, test_project,
       count(*) AS runs,
       approx_percentile_cont(duration_ms, 0.95) AS p95_ms,
       approx_median(duration_ms) AS median_ms
FROM ci.tests
WHERE started_at >= now() - INTERVAL '14 days'
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
WHERE started_at >= now() - INTERVAL '14 days'
  AND branch = 'main' AND (expected_state IS NULL OR expected_state = 'passed')
GROUP BY module_path, full_name, test_project
HAVING sum(CASE WHEN passed_after_retry OR state IN ('failed', 'timedout') THEN 1 ELSE 0 END) > 0
ORDER BY flake_pct DESC
LIMIT 25;
```

Where a Preview OS run's time to green goes, per phase, over 14 days (needs
`ci.spans`, _next_; the phases are the CI trace's: workflow queue, each job's
Setup and Test, its steps):

```sql
SELECT job_name, phase,
       approx_median(duration_ms) / 1000 AS median_s,
       approx_percentile_cont(duration_ms, 0.9) / 1000 AS p90_s,
       count(DISTINCT workflow_run_id) AS runs
FROM ci.spans
WHERE workflow_name = 'Preview OS'
  AND started_at >= now() - INTERVAL '14 days'
  AND workflow_run_id IN (SELECT workflow_run_id FROM ci.spans WHERE span = 'workflow' AND verdict = 'green')
GROUP BY job_name, phase
ORDER BY median_s DESC;
```

Run one with `wrangler r2 sql query <warehouse> "<sql>"` and a token in
`WRANGLER_R2_SQL_AUTH_TOKEN`, or `POST
https://api.sql.cloudflarestorage.com/api/v1/accounts/<account>/r2-sql/query/ci-test-analytics`
with a Bearer header ([query data](https://developers.cloudflare.com/r2-sql/query-data/)).
R2 SQL is in beta and its grammar may change; `approx_percentile_cont`,
`approx_median`, `now()` and `INTERVAL` literals are in its
[reference](https://developers.cloudflare.com/r2-sql/sql-reference/).

The same questions work today, before any of that, with DuckDB over the
folders (an R2 API token with Object Read on the bucket):

```sql
CREATE SECRET ci_test_evidence (TYPE r2, KEY_ID '<id>', SECRET '<secret>', ACCOUNT_ID '376ef7ed81b0573f93524de763666c15');

SELECT module_path, full_name, count(*) AS runs, quantile_cont(duration_ms, 0.95) AS p95_ms
FROM read_parquet('r2://ci-test-evidence/ci/*/*/*/*/tables/tests.parquet', hive_partitioning = true, union_by_name = true)
WHERE date >= current_date - 14 AND branch = 'main' AND state = 'passed' AND retry_count = 0
GROUP BY ALL ORDER BY p95_ms DESC LIMIT 25;
```

A downloaded folder works too: `read_parquet('test-results/tables/tests.parquet')`.

### Volume and cost

About 1.3 million rows a day (500 Test attempts of 2,258 to 2,485 tests, 300
e2e attempts of about 370). A row is about 1.2 KB as JSON (measured on a Test
attempt's rows), so Pipelines takes about 1.5 GB a day, 45 GB a month: just
inside the 50 GB of transforms and sinks Workers Paid includes, and about
$0.10 per GB beyond it
([Pipelines pricing](https://developers.cloudflare.com/pipelines/platform/pricing/)).
As Parquet it is about 140 MB a day. A 14-day query reads at most about 2 GB,
usually a fraction since it reads only its columns: under half a cent at $2.50
per TB scanned, with 10 GB a month free
([R2 SQL pricing](https://developers.cloudflare.com/r2-sql/platform/pricing/)).
Catalog operations and compaction stay inside their free tiers at this volume
([catalog pricing](https://developers.cloudflare.com/r2/data-catalog/platform/pricing/)).

## Local and agent runs

_Next._ `pnpm evidence <command>` (for example `pnpm evidence pnpm spec`) sets
`TEST_TELEMETRY_ARTIFACT_DIR` and `FLAKE_RECORD_DIR`, runs the command, and
writes a manifest with `runner.provider: "local"`: the user, host, and the
agent when one ran it (Claude Code sets `CLAUDECODE=1`). With a GitHub login it
uploads under `local/` with [temporary credentials](#credentials). Plain
`pnpm test` and `pnpm spec` stay as they are.

Locally, the notes, voice and dash specs skip rather than fail when their base
URLs are unset. A local manifest records that, and it is one reason a local
run proves less than CI.

## Skipping CI when a trusted run proves it

_Future work._ The groundwork this PR lays: every CI manifest records the
commit, the tree on disk, the lockfile hash, the runner and every file's hash.
Before trusting anything, measure: how often does a pull request push's tree
match a tree that already passed? That is a query over `ci.runs`.

### The input key

A proof is keyed by what went into the run, recomputed by the verifier, never
taken from the claimant:

- **The tree CI would test**: the pull request merged into main, not its head
  (`git merge-tree --write-tree origin/main HEAD` computes it without a
  checkout), or the working tree through a temporary index. It covers
  `pnpm-lock.yaml`, `.depot/workflows`, the test configs and the tests. Nx's
  CREEP vulnerability (CVE-2025-36852) came from a cache key that left the CI
  workflow out ([Nx](https://nx.dev/blog/creep-vulnerability-build-cache-security)).
- **An environment digest**: Node, pnpm, OS and architecture, the Playwright
  browser revision, the command and the suite selection (no `-t`, `--project`
  or `.only`), and the names and values of the variables that change behaviour
  (`CI`, `DEMO_BASE_URL`, `NOTES_BASE_URL`, `VOICE_BASE_URL`, `DASH_BASE_URL`,
  `VIDEO_MODE`, `E2E_REAL_MODELS`), never secret values.
- **The deployed target**, for suites that run against a preview: its Worker
  version id. That is why the first target is the hermetic ones: the Test
  job's unit and workers projects, and the Kit host tests.

### The proof

The manifest becomes an [in-toto](https://github.com/in-toto/attestation/blob/main/spec/predicates/test-result.md)
Statement: subject the tree, predicate `test-result/v0.1` with the result, the
input digest, the runner, the times, the full test inventory and the files'
hashes. CI checks completeness cheaply: `vitest list` and
`playwright test --list` on the same tree must match the manifest's inventory,
as the finalizer already checks workspaces today.

**Who signs:**

- **A Depot-hosted run**, including one an agent starts with
  [`depot ci run`](https://depot.dev/docs/ci/overview) on its local, unpushed
  tree: no new cryptography. The verifier asks Depot's API whether that run
  succeeded on that tree. This is the strongest near-term route.
- **A laptop or agent run**: a key the agent process cannot read. Either an
  SSH signing key behind the 1Password agent that asks a person on every use,
  or a local attestor daemon that runs the suite itself and signs its own
  result, so an agent can ask for a run but cannot write the result. A plain
  key on disk, Turborepo's model
  ([remote caching](https://turborepo.com/docs/core-concepts/remote-caching)),
  proves who holds the key, not that tests ran.

**Tamper evidence:** write-once objects under an `attestations/` prefix with
a bucket lock, keyed by input digest and signer, never replaced (Nx's fix for
CREEP); the manifest's digest anchored in a commit status posted by the
signer; and CI re-running a random 10% of accepted proofs, and everything from
a signer after one mismatch. That makes lying expensive rather than
impossible.

### Threat model

| Actor                                 | Trust                    | Main risks                                                                                                                                                                                                      | Policy                                                                                              |
| ------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A person or agent on a laptop, honest | High intent, error-prone | A stale or dirty tree; the head tested instead of the merge; filtered or skipped suites (unset base URLs); another Node or browser; a local worker instead of the deployed one; an overloaded laptop's timeouts | CI recomputes the key and checks completeness                                                       |
| An agent on the owner's machine       | Mostly trusted           | Pressure to go green, so a fabricated or edited manifest; it can reach the owner's credentials                                                                                                                  | The signer is out of its reach (attestor or approval-gated key); spot checks; prefer `depot ci run` |
| An external contributor               | Untrusted                | Forged proofs; poisoning a shared key                                                                                                                                                                           | Never accepted; always runs in CI                                                                   |
| Anyone holding the R2 write key       | None                     | Planted or replaced objects                                                                                                                                                                                     | Write-once objects, a signer allowlist, temporary credentials scoped to one prefix                  |

### Phases

1. **Record** (this PR, then the upload switched on): every CI run's manifest
   with its tree and lockfile, in R2. Nothing is skipped.
2. **Reuse Depot-hosted results**: skip a CI job when a successful Depot run,
   including an agent's `depot ci run`, exists for the same input key.
3. **Signed laptop and agent proofs**, for trusted authors and hermetic suites
   only, with spot checks.

## Owner steps

The upload stays off until 1 to 3 are done; 4 to 6 come with the PR that adds
the queue consumer. All on the dev/preview account. Doppler `_shared/preview`
supplies `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; that token lists
R2 buckets and preview deploys create buckets with it, so 1 should work with
it, but its catalog and Pipelines calls fail with "Authentication error [code:
10000]".

1. **The evidence bucket and its retention**:

   ```sh
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket create ci-test-evidence
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle add ci-test-evidence ci-after-365-days ci/ --expire-days 365 --force
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lifecycle add ci-test-evidence local-after-30-days local/ --expire-days 30 --force
   # optional: nobody can delete a CI run's evidence for its first 30 days
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket lock add ci-test-evidence ci-locked-30-days ci/ --retention-days 30 --force
   ```

2. **CI's upload keys.** In the dashboard, R2 → Manage API tokens → Create
   Account API token: **Object Read & Write**, applied to `ci-test-evidence`
   only. Store its S3 keys (Doppler prompts for each value):

   ```sh
   doppler secrets set TEST_EVIDENCE_R2_ACCESS_KEY_ID --project _shared --config preview
   doppler secrets set TEST_EVIDENCE_R2_SECRET_ACCESS_KEY --project _shared --config preview
   ```

   Optionally a second token with **Object Read** only, for DuckDB queries.

3. **Turn it on**: set `TEST_EVIDENCE_UPLOAD: r2` in the `env` of `test.yml`,
   `preview-os.yml` and `main-os-e2e.yml`, then check the first folders:

   ```sh
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 object get "ci-test-evidence/ci/date=$(date -u +%F)/workflow=test/job=test/testrun_<attempt id>/manifest.json" --remote --pipe
   ```

4. **The catalog bucket.** Create an R2 API token with **Admin Read & Write**
   (the Pipelines catalog sink requires it) and add the Pipelines edit
   permission; the `_shared/preview` token has neither the catalog nor the
   Pipelines permissions. Use it as `CATALOG_TOKEN` below:

   ```sh
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket create ci-test-analytics
   CLOUDFLARE_API_TOKEN="$CATALOG_TOKEN" CLOUDFLARE_ACCOUNT_ID=376ef7ed81b0573f93524de763666c15 pnpm --dir apps/os exec wrangler r2 bucket catalog enable ci-test-analytics
   CLOUDFLARE_API_TOKEN="$CATALOG_TOKEN" CLOUDFLARE_ACCOUNT_ID=376ef7ed81b0573f93524de763666c15 pnpm --dir apps/os exec wrangler r2 bucket catalog compaction enable ci-test-analytics --target-size 128 --token "$CATALOG_TOKEN"
   CLOUDFLARE_API_TOKEN="$CATALOG_TOKEN" CLOUDFLARE_ACCOUNT_ID=376ef7ed81b0573f93524de763666c15 pnpm --dir apps/os exec wrangler r2 bucket catalog snapshot-expiration enable ci-test-analytics --older-than-days 7 --retain-last 10 --token "$CATALOG_TOKEN"
   ```

   Never add a lifecycle rule to `ci-test-analytics`.

5. **The manifest queue and notification**:

   ```sh
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler queues create ci-test-evidence-manifests
   doppler run --project _shared --config preview -- pnpm --dir apps/os exec wrangler r2 bucket notification create ci-test-evidence --event-type object-create --prefix ci/ --suffix manifest.json --queue ci-test-evidence-manifests
   ```

6. **The streams, sinks and pipelines**, with the stream schema files that PR
   adds (`--roll-interval` is at least 60 seconds for a catalog sink):

   ```sh
   export CLOUDFLARE_API_TOKEN="$CATALOG_TOKEN" CLOUDFLARE_ACCOUNT_ID=376ef7ed81b0573f93524de763666c15
   pnpm --dir apps/os exec wrangler pipelines streams create ci_tests --schema-file <tests schema> --http-enabled=false
   pnpm --dir apps/os exec wrangler pipelines sinks create ci_tests_sink --type r2-data-catalog --bucket ci-test-analytics --namespace ci --table tests --catalog-token "$CATALOG_TOKEN" --roll-interval 300
   pnpm --dir apps/os exec wrangler pipelines create ci_tests --sql "INSERT INTO ci_tests_sink SELECT * FROM ci_tests"
   # the same three for ci_runs → ci.runs
   ```

   For queries, a token with **Workers R2 SQL Read**, **Workers R2 Data
   Catalog Read** and **Workers R2 Storage Bucket Item Read** as
   `WRANGLER_R2_SQL_AUTH_TOKEN`. The R2 SQL page still asks for storage read
   and write, which predates read-only catalog tokens (2026-07-13); try
   read-only first
   ([query data](https://developers.cloudflare.com/r2-sql/query-data/),
   [catalog tokens](https://developers.cloudflare.com/r2/data-catalog/manage-catalogs/)).
   The warehouse name is in `wrangler r2 bucket catalog get ci-test-analytics`.

## Decisions to confirm

- The names: buckets `ci-test-evidence` and `ci-test-analytics`,
  `testEvidenceEnvs` in `envs.ts`, the workflow switch `TEST_EVIDENCE_UPLOAD`
  (`off` | `r2`), and the Doppler keys `TEST_EVIDENCE_R2_ACCESS_KEY_ID` and
  `TEST_EVIDENCE_R2_SECRET_ACCESS_KEY`.
- Keeping today's paths inside `test-results/` rather than a new layout.
- `continue-on-error` on both steps: evidence never decides a job.
- Retention: 365 days for CI evidence (about $15 a month at steady state),
  30 days for local runs, rows kept in the catalog.
- The Test job's extra folder artifact until readers move to R2.
