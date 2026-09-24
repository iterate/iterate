# Test results as Parquet in R2 (draft)

**Status: off.** The writer exists and is tested. CI runs it only when a
workflow sets `TEST_RESULTS_PARQUET: upload`, and nothing sets it yet. The
bucket and its credentials are created by hand ([owner steps](#owner-steps)).

Every CI job attempt that runs tests already keeps its per-test results as a
Depot artifact: the runners' raw telemetry and the flake record lines
([CI and test telemetry](ci-test-telemetry.md)). To answer a question across
runs ("which tests got slower this week", "every retry of this spec since
Monday"), someone has to download artifacts one run at a time.
`scripts/ci/test-results-parquet.ts` turns one job attempt's artifacts into
one Parquet file and puts it in an R2 bucket. That makes test history a SQL
query. Per-test events went to PostHog until they were over 70% of its
ingestion ([ci-test-telemetry.md](ci-test-telemetry.md)); objects in R2 cost
next to nothing ([volume and cost](#volume-and-cost)).

## What CI does

The Test job (`.depot/workflows/test.yml`) and the Preview OS `e2e` job
(`.depot/workflows/preview-os.yml`) each have a step
`Write test results as Parquet`, after the telemetry finalizer and before the
artifact uploads. The step is skipped unless the workflow's
`TEST_RESULTS_PARQUET` is `upload`, and in a cancelled run. When it runs, it:

1. reads `test-results/ci-telemetry/raw/*.json` (the finalizer's input) and
   every `*.jsonl` line below `test-results/flake-records/`;
2. writes `test-results/ci-telemetry/test-results.parquet`, which the job's
   telemetry artifact then keeps too;
3. PUTs that file to R2 through R2's
   [S3 API](https://developers.cloudflare.com/r2/api/s3/api/), with the keys of
   a bucket-scoped R2 API token from Doppler `_shared/preview`
   (`TEST_RESULTS_R2_ACCESS_KEY_ID`, `TEST_RESULTS_R2_SECRET_ACCESS_KEY`).

The step has `continue-on-error: true`: an R2 outage shows as a failed step,
and the job's outcome is still its tests'. It sends one request with no
retries. A failed upload is missing from R2 and still in the job's Depot
artifact.

The writer refuses input it cannot represent faithfully. A createFlake or
createFailing record that names no test, or more than one, fails the step.
So does an artifact from another job attempt, or telemetry with no Depot job
(a local run).

To try it on any CI run without R2, download the run's telemetry and flake
records (`depot ci artifacts`, [Depot CI](depot-ci.md#commands)) and run:

```sh
pnpm tsx scripts/ci/test-results-parquet.ts \
  --artifact-root <unzipped unit-test-telemetry-attempt-…> \
  --flake-records <unzipped flake-records-unit-attempt-…>
# writes <artifact-root>/test-results.parquet; --upload also PUTs it to R2
```

## Object keys

The bucket is `testResultsEnvs.ci.bucketName` in [`envs.ts`](../envs.ts)
(`ci-test-results`, on the dev/preview account). There is one object per job
attempt:

```
date=<YYYY-MM-DD>/workflow=<workflow>/<workflow_run_id>-<job_name>-<job_attempt_id>.parquet
```

- `date` is the UTC day the job attempt's first runner started.
- `workflow` is the workflow's name, lowercased, with runs of other
  characters replaced by `-` (`test`, `preview-os`).
- `job_attempt_id` comes from `DEPOT_JOB_URL`'s `attempt=`, the same id the
  job's artifact names end in
  ([per job attempt](depot-ci.md#artifacts-per-job-attempt)). A retried job
  therefore writes a second object beside the first.

The partitions are Hive-style (`key=value`), so DuckDB's `hive_partitioning`
reads them as `date` (a `DATE`) and `workflow` columns, and a filter on either
skips whole prefixes.

## Schema

There is one row per test the runners reported, including skipped tests.
Nothing is versioned: when the schema changes, old files keep their columns,
and a query over both reads with `union_by_name = true`.

| Column                  | Type      | Meaning                                                                                                                                                                          |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository`            | STRING    | `iterate/iterate`                                                                                                                                                                |
| `workflow_name`         | STRING    | Workflow display name (`Test`, `Preview OS`)                                                                                                                                     |
| `workflow_run_id`       | STRING    | `GITHUB_RUN_ID` as Depot sets it                                                                                                                                                 |
| `workflow_run_attempt`  | STRING    | `GITHUB_RUN_ATTEMPT`                                                                                                                                                             |
| `job_name`              | STRING    | `GITHUB_JOB` (`test`, `e2e`)                                                                                                                                                     |
| `job_attempt_id`        | STRING    | Depot's job attempt id, as in the key                                                                                                                                            |
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

Kind `unknown` flake records are not joined. They restate a plain test's
`passed_after_retry` and final `state`, which the row already has.

## Query

With [DuckDB](https://duckdb.org/docs/current/guides/network_cloud_storage/cloudflare_r2_import.html),
use an R2 API token with Object Read on the bucket (the CI token's keys work,
but a read-only token is better):

```sql
CREATE SECRET ci_test_results (
    TYPE r2,
    KEY_ID '<access key id>',
    SECRET '<secret access key>',
    ACCOUNT_ID '376ef7ed81b0573f93524de763666c15'
);

-- Retried or failed tests on main in the last 14 days, worst first.
SELECT module_path, full_name,
       count(*) AS runs,
       count(*) FILTER (WHERE passed_after_retry) AS rescued_by_retry,
       count(*) FILTER (WHERE state IN ('failed', 'timedout') AND expected_state = 'passed') AS failed,
       round(quantile_cont(duration_ms, 0.9)) AS p90_ms
FROM read_parquet('r2://ci-test-results/*/*/*.parquet', hive_partitioning = true, union_by_name = true)
WHERE date >= current_date - 14 AND branch = 'main'
GROUP BY ALL
HAVING rescued_by_retry + failed > 0
ORDER BY rescued_by_retry + failed DESC;
```

A local file works the same way:
`read_parquet('test-results/ci-telemetry/test-results.parquet')`. JSON columns
take DuckDB's JSON operators, for example `attempts->>'$[0].state'`.

**R2 SQL was checked and does not fit yet.** Cloudflare's
[R2 SQL](https://developers.cloudflare.com/r2-sql/) (open beta) queries only
Apache Iceberg tables in [R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/),
not loose Parquet objects
([limitations](https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/)).
To use it, the writer would append to an Iceberg table instead of putting
objects: through the catalog's Iceberg REST interface, or by sending rows to
[Pipelines](https://developers.cloudflare.com/pipelines/) (open beta), whose
sink writes Iceberg tables to R2 Data Catalog. That is worth doing only once a
query needs to run where no one has DuckDB, such as a dashboard Worker.

## Volume and cost

Measured on one PR's run (2026-09-24, `ntb262kdvq` / `2bm2s7p7m4`):

| Job              | Tests | Raw telemetry (JSON) | Parquet |
| ---------------- | ----- | -------------------- | ------- |
| Test `test`      | 2,258 | 2.4 MB               | 228 KB  |
| Preview OS `e2e` | 357   | 1.2 MB               | 60 KB   |

Depot ran 178 to 377 pull-request runs and 173 to 384 push runs a day from
2026-09-21 to 2026-09-23. Assume at most 500 Test and 300 Preview OS job
attempts a day. That is about 800 objects and 135 MB a day, roughly 4 GB a
month and 50 GB a year. At [R2 Standard pricing](https://developers.cloudflare.com/r2/pricing/)
($0.015 per GB-month after 10 GB free; Class A $4.50 per million after
1 million free; Class B $0.36 per million after 10 million free; no egress
fees):

- **Storage**: under $1 a month at a full year's retention.
- **Writes**: about 24,000 PUTs a month (Class A), inside the free million.
- **Queries**: DuckDB lists the matching prefixes (ListObjects, Class A,
  1,000 keys a page), then range-reads each file's footer and the columns it
  needs (GetObject, Class B, a few per file). A two-week query touches about
  11,000 files. Querying a year means about 290,000 small files. The request
  cost is still small, but the query is slow, bounded by per-file round trips.
  If that matters, add a monthly job that compacts a month into one file per
  workflow.

## Retention

Keep one year. An R2 [lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
deletes objects 365 days after upload, so nothing in CI deletes. Each job's
Depot artifact keeps its own copy for Depot's artifact retention.

## Owner steps

These steps create Cloudflare resources and credentials, so they are done by
hand and not in CI:

1. Create the bucket on the dev/preview account and add the retention rule
   (Doppler `_shared/preview` has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for that
   account; whether the token may create buckets is unverified):

   ```sh
   doppler run --project _shared --config preview -- \
     pnpm exec wrangler r2 bucket create ci-test-results
   doppler run --project _shared --config preview -- \
     pnpm exec wrangler r2 bucket lifecycle add ci-test-results expire-after-one-year --expire-days 365
   ```

2. In the dashboard, under R2 → Manage API tokens, create an **Account** API
   token with **Object Read & Write**, scoped to `ci-test-results` only
   ([R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)). Store
   its Access Key ID and Secret Access Key in Doppler `_shared/preview` as
   `TEST_RESULTS_R2_ACCESS_KEY_ID` and `TEST_RESULTS_R2_SECRET_ACCESS_KEY`.
   Optionally, create a second token with **Object Read** only, for queries.
3. Turn it on: set `TEST_RESULTS_PARQUET: upload` in the `env` of `test.yml`
   and `preview-os.yml`, and check the first objects with the query above.
