# Test evidence

Depot keeps artifacts about a week, though the workflows ask for 30 days (on 2026-09-24 main's runs
from 8 to 35 days old listed none), so a ci-reports link, a "Playwright report" status or a flake
record is gone after a week. So each test run in CI also writes **one folder, with one manifest,
uploaded straight to R2, into one bucket, `iterate-ci`**. The one reader built is the
[flake dashboard](https://github.com/iterate/iterate/issues/2580) ([reading it back](#reading-it-back));
the others (analytics, local runs, skipping CI on a trusted run) are designed in
[#3110](https://github.com/iterate/iterate/issues/3110).

## The evidence folder

A **test run** is one CI job attempt that runs tests: the Test job, and the E2E tests and Browser
specs jobs of Preview OS and Main OS e2e. Each is its own run with its own folder, `testRunId`,
manifest and R2 prefix. A laptop run writes none, nor do the latency and real-model guards (each
would need the write, upload and report steps and a line in `testEvidenceJobs`). The folder is
`test-results/`, its paths `testEvidencePaths` in
[`packages/shared/src/test-support/test-evidence.ts`](../packages/shared/src/test-support/test-evidence.ts):

```text
test-results/
├── manifest.json                   written last; the result, and every other file with its sha256
├── target.json                     the e2e jobs: the preview and the deployment the suites ran against
├── ctest/junit.xml                 the Test job: Kit's firmware host tests
├── ci-telemetry/
│   ├── raw/<runner>.json           each runner's telemetry: one per Vitest workspace, one for Playwright
│   └── manifest.json               the finalizer's completeness check (test-telemetry-finalizer.ts)
├── flake-records/<suite>/*.jsonl   createFlake / createFailing / retry lines, plus suite-summary.json
├── playwright-output/<test>/       trace.zip, test-failed-*.png, error-context.md, videos, spec screenshots
├── playwright-html/                Playwright's HTML report
└── playwright-results.json         Playwright's JSON reporter
```

### When deploy, e2e and specs are separate jobs

Each test job of Preview OS and Main OS e2e expects its own workspace in
`TEST_TELEMETRY_EXPECTED_WORKSPACES` (`os` for E2E tests, `iterate-root` for Browser specs), passes
its own `TEST_EVIDENCE_STEPS` (`e2e=…`, `specs=…`), and writes and uploads only once its suite read
the deployed target. The suite jobs start beside the deploy and wait for it
([Depot CI](depot-ci.md#suites-start-with-the-run)); `runSuite` (`scripts/os/preview.ts`)
writes `target.json` once there is a preview, before the suite: the preview, the OS deployment
`/version` named, and the apps' URLs. So a job whose deploy failed or was cancelled, or that never
had a preview, keeps no folder. A `target.json` it cannot write fails the job before the suite, so
no suite passes with its evidence unchecked. A dispatch against a preview already deployed can test
a different tree than the deploy built: compare `target.deploymentId` with the deploy's own
`preview.json`.

### How each producer writes into it

| Producer                                                                          | Writes                                                              | How it gets there                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Vitest, every unit workspace and the OS e2e suite (`retry-telemetry-reporter.ts`) | `ci-telemetry/raw/`                                                 | `TEST_TELEMETRY_ARTIFACT_DIR`, set by the workflows                                                    |
| Playwright telemetry reporter                                                     | `ci-telemetry/raw/`                                                 | the same variable                                                                                      |
| createFlake, createFailing, retried plain tests                                   | `flake-records/`                                                    | `FLAKE_RECORD_DIR`: test.yml, and `scripts/os/preview.ts` per suite (from `testEvidencePaths`)         |
| Playwright output, HTML and JSON reporters                                        | `playwright-output/`, `playwright-html/`, `playwright-results.json` | `test/playwright.config.ts`, from `testEvidencePaths`                                                  |
| The telemetry finalizer                                                           | `ci-telemetry/manifest.json`, `suite-summary.json`                  | `scripts/ci/test-evidence.ts finalize`, which runs `scripts/ci/test-telemetry-finalizer.ts`            |
| The evidence writer                                                               | `manifest.json`                                                     | `scripts/ci/test-evidence.ts finalize`, after the finalizer                                            |
| Kit firmware host tests (CTest)                                                   | `ctest/junit.xml`                                                   | `--output-junit`, which `pnpm --dir apps/kit firmware:test:host` passes to CTest; not in the telemetry |
| The deployed target (e2e jobs)                                                    | `target.json`                                                       | `runSuite`, before the suite: the preview, the OS deployment `/version` names, the apps' URLs          |

Videos are off in CI (retained videos left ffmpeg workers holding the job open). Without
`TEST_TELEMETRY_ARTIFACT_DIR` and `FLAKE_RECORD_DIR` nothing is recorded, so a laptop run records
nothing.

### What CI does

In each of those jobs, after the steps that run tests (the Test job's Vitest and Kit's CTest side by
side, a suite job's suite):

1. **Check test telemetry, write the suite summary and the test evidence manifest**
   (`node scripts/ci/test-evidence.ts finalize --flake-suites <suite>`, `--cancelled` when the job
   was, two minutes at most). The Test job runs it `if: always()`; a suite job whenever its suite
   step ran, with `--only-with-target`, so it keeps a folder only once the suite read the deployed
   target. One step and one Node process, with Node's compile cache (`NODE_COMPILE_CACHE` in the runner's temporary directory), which the
   upload's Node starts from. First the telemetry finalizer
   ([CI telemetry](ci-test-telemetry.md#test-telemetry-artifacts)), then the manifest: the
   workflow passes the outcome of every step that runs tests in `TEST_EVIDENCE_STEPS`
   (`tests=… kit-host-tests=…` in the Test job), and it hashes every file and writes
   `manifest.json`. Its outputs say what the folder holds, each once it is true: `evidence=kept`,
   `manifest=written`, and `playwright-report=written`. The steps after it read those instead of
   `hashFiles()`, which costs the runner about 0.2 s per condition, one at a time
   ([parallel steps](depot-ci.md#parallel-steps)). A suite job's Depot artifact uploads (results
   and flake records) also run when this step failed, so a Node that failed before `evidence=kept`
   still keeps a failed suite's traces and flake lines.
2. **Upload the test evidence to R2** (`node scripts/ci/test-evidence.ts upload`, `if: always()`
   once the manifest is written, `continue-on-error`, three minutes at most), in one `parallel:`
   block beside the Depot artifact uploads. Its token (Doppler `_shared/preview`'s
   `CLOUDFLARE_API_TOKEN`) comes without a request: an earlier step, "Fetch the evidence upload's
   secrets" (`node scripts/ci/test-evidence.ts fetch-upload-secrets`), saved the config into
   Doppler's encrypted fallback file in the runner's temporary directory, and the upload reads it
   from there (scripts/lib/env-context.ts `dopplerSecret`'s `fallback`). In the Test job that step
   runs beside the tests, in a suite job before the suite, while the deploy it waits for runs.
   Without that file (a failed fetch is a warning there) the upload fetches the token itself. Up to 32 files at once, the largest first, holding at most 128 MiB of them, then the manifest; a job's folder of 10 to 53
   files is one or two waves of about half a second each and the manifest's. A cancelled job's
   folder goes too, its manifest saying `cancelled`. The step prints the run's prefix, the object
   count and how long the upload and the process took
   (`[test-evidence] r2://iterate-ci/evidence/ci/trust=pr/date=…/job=…/testrun_…/ (22 objects in …)`)
   and writes the prefix to the job's summary.
3. **Report a test evidence step that could not** (`scripts/ci/test-evidence-unreported.sh`), after
   that block, when either step's outcome is `failure`.

The write fails only when the job has no Depot job attempt to name the run after, git cannot
record the source, a runner's fields do not fit the schema, or it is not done within a minute (a
second or two is usual), which keeps a stuck manifest from running the step into its timeout.
Everything else it cannot read goes into the manifest's `diagnostics`, and the manifest is written
anyway: the run whose runner crashed is the one whose evidence matters most.

Neither the manifest nor the upload decides the job; the tests' own steps and the finalizer do. The
first step fails when the finalizer does (missing, incomplete or foreign telemetry, once the
manifest is written), not when the manifest cannot be written. A failure is made visible instead:
the script's own warning annotation and summary line ("Test evidence not in R2", "No test evidence
manifest"); the plain-shell fallback step for a step that failed before it could report (Node or
Doppler failing, the step's own timeout), which reports the write only when the step left no
manifest; and `test_evidence_uploaded` on each attempt's `ci job attempt finished` event in PostHog
([CI telemetry](ci-test-telemetry.md#ci-events-in-posthog)), which counts attempts whose folder
never reached R2.

### The manifest

`TestEvidenceManifest` (the same module) is the schema; readers parse with it.

- `testRunId` is `testrun_<Depot job attempt id>`, the id every artifact name of that attempt ends
  in ([per job attempt](depot-ci.md#artifacts-per-job-attempt)). The job's identity comes from its
  environment (`DEPOT_JOB_URL`, `GITHUB_*`, `TEST_TELEMETRY_*`), so a job whose runners never
  started still has one.
- `result`: `cancelled`; `incomplete` when the finalizer found a workspace missing, a runner cut
  short or another attempt's artifact, or a step that runs tests was skipped or passed no outcome;
  `failed` when such a step failed or a runner reported a failure (a failed Kit CTest step counts,
  though it reports no telemetry); otherwise `passed`.
- `completeness` is the finalizer's own check, copied.
- `target` is `target.json`, in the e2e jobs only. The client apps answer `/healthz` with `ok`, so
  only the OS deployment is recorded.
- `source.commit` is the checked-out commit (a pull request's merge commit); `source.tree` is the
  tree of the files on disk after the tests, uncommitted and untracked files included; `dirty` says
  it differs from the commit's.
- `runner` is the Depot job attempt, who started it, and the toolchain. `trust` is `main` for a push
  or schedule on `refs/heads/main` that tested that commit (not `dirty`), and `pr` for everything
  else, dispatches included.
- `timings` spans the first runner's start to the last runner's finish; `files` is every file but
  the manifest, with its size and sha256.

## Upload to R2

### One bucket

Everything CI keeps in R2 lives in **`iterate-ci`**, on the dev/preview account
(`ciBucketEnvs.ci` in `envs.ts`), under `evidence/`. `evidence/local/` and `state/` are reserved
for laptop runs and the guards' state ([#3110](https://github.com/iterate/iterate/issues/3110)).
No prd data: every CI job can read this bucket, so the context sweep's backups of prd's orphan
contexts, their whole durable logs, live in `iterate-prd-backups` on the prd account, written with
prd's own token (`backupBucketEnvs` in `envs.ts`,
[`scripts/ci/context-sweep.ts`](../scripts/ci/context-sweep.ts)). `backups/context-sweep/` here holds
only preview contexts' backups from the sweep's trial runs, expiring under their rule below.

One bucket, because an R2 API token scopes to buckets, never to a prefix, and CI has one
credential that reaches every bucket anyway ([credentials](#credentials)); lifecycle rules and
bucket locks match by prefix. Split a bucket off when jobs get credentials scoped to what they write
(the guards' state first: a pull request's job must never reset a guard's memory, which is why that
state stays in Depot artifacts until then), or for anything public: public access is per bucket, so
this one is never public.

### Object keys

```text
evidence/ci/trust=<main|pr>/date=<YYYY-MM-DD>/job=<Depot job id>/<testRunId>/<path in the folder>
```

(`testEvidencePrefix` in `scripts/ci/test-evidence.ts`.)

- **`evidence/` first**, so no rule on it can reach `state/`.
- **Then `trust`**, because lifecycle rules and bucket locks match by prefix only, and a run of
  main's workflow must never share a namespace with a pull request's (Nx's CREEP vulnerability,
  CVE-2025-36852). `main` is a push or schedule on `refs/heads/main` whose tree on disk is the
  pushed commit's; everything else is `pr`, a laptop's `depot ci run` included.
- **Only what a Depot OIDC token's claims give** (`ref`, `event_name`, `iat`, `job_id`), so a notary
  that mints credentials later can derive everything down to `job=<job_id>/` itself
  ([#3110](https://github.com/iterate/iterate/issues/3110)).
- The `key=value` segments are Hive-style, for DuckDB's `hive_partitioning`.

### Addressed by run, verified by content

Files keep their paths under the run's prefix, because Playwright's HTML report loads its traces and
screenshots by relative path. Content still decides what is accepted:

- The upload re-hashes each file as it reads it, refuses one that no longer matches the manifest,
  and signs that sha256 as the SigV4 payload hash, so R2 refuses a body that changed on the way.
- Every PUT is write-once (`If-None-Match: *`): an existing key answers 412. A 412 on a key already
  holding the same bytes (its ETag is their MD5) is this upload's own earlier try; other bytes fail
  it.
- The manifest goes last, so a folder whose manifest is in R2 is complete, and the manifest's sha256
  addresses the whole run.
- Keys carry `=` percent-encoded (`trust%3Dpr`), as S3 clients sign them; R2 stores them decoded.

The upload sends eight requests at a time. A Cloudflare 5xx, a 429 or no answer is sent again on
`CI_HTTP`'s schedule ([failures and retries](engineering-invariants.md#failures-and-retries)), each
retry logging `test-evidence.platform-failure-retry`. A request times out after 60 s, and 90 s into
the upload no retry starts: this evidence decides nothing, so a degraded R2 costs the e2e job at most
about a minute and a half. Anything else, or a fourth failure, fails the step.

### Reading it back

The upload step's log and the job's summary give the run's prefix. With the same token, from the
repository root:

```sh
doppler run --project _shared --config preview -- pnpm --dir core/os exec wrangler r2 object get "iterate-ci/<prefix>manifest.json" --remote --pipe
doppler run --project _shared --config preview -- pnpm --dir core/os exec wrangler r2 object get "iterate-ci/<prefix>playwright-html/index.html" --remote --file index.html
```

Every file the manifest lists is at `<prefix><path>`, its bytes hashing to the listed sha256. Each
runner's tests are one JSON record apiece in `ci-telemetry/raw/*.json` (`TestTelemetryArtifact` in
`packages/shared/src/test-support/ci-telemetry.ts`). The flake dashboard
(`scripts/ci/flake-dashboard/evidence.ts`) lists `evidence/ci/trust=<main|pr>/date=<day>/` for the
last eight UTC days through the S3 API and reads the `flake-records/` of the folders whose manifest
is listed.

### Sizes and costs

Passing runs of [#3247](https://github.com/iterate/iterate/pull/3247) on 2026-09-26:

| Job attempt (passing) | Objects | Bytes   | Of which                                                                                   |
| --------------------- | ------- | ------- | ------------------------------------------------------------------------------------------ |
| Test                  | 21      | 3.0 MB  | raw telemetry 2.1 MB (3,554 tests), flake suite summary 0.84 MB, CTest's JUnit XML 0.01 MB |
| E2E tests             | 11      | 0.33 MB | raw telemetry 0.23 MB, flake suite summary 0.09 MB                                         |
| Browser specs         | 29      | 2.4 MB  | JSON results 0.92 MB, HTML report 0.77 MB, 16 screenshots 0.66 MB, raw telemetry 0.03 MB   |

A failing Preview OS attempt was 68 files and 9.9 MB, about half of it the HTML report's copies of
the traces. Assuming at most 500 Test and 300 each of E2E tests and Browser specs attempts a day, at
[R2 Standard pricing](https://developers.cloudflare.com/r2/pricing/): about 2.3 GB a day; at the
retention below about 525 GB at steady state, **about $8 a month**; about 675,000 PUTs a month,
**about $3 a month**. Gzipping the raw telemetry (13×) would halve storage and make every reader
decompress: not worth it at these prices.

### Retention

Lifecycle rules on `iterate-ci`, set when it was created ([setup](#setup)):

- `evidence/ci/trust=main/`: 365 days (`evidence-main-after-365-days`).
- `evidence/ci/trust=pr/`: 90 days (`evidence-pr-after-90-days`).
- `evidence/local/`: 30 days (`evidence-local-after-30-days`).
- `backups/context-sweep/`: 365 days (`backups-context-sweep-after-365-days`); nothing writes it
  any more.
- `state/`: never deleted. Nothing in CI deletes objects.
- **No bucket lock is set** (30 days on `trust=main/` would stop even CI's token deleting them);
  whether to set it is open ([#3110](https://github.com/iterate/iterate/issues/3110)).

### Credentials

- **CI uses the token it already has**: Doppler `_shared/preview`'s `CLOUDFLARE_API_TOKEN`, the
  token preview deploys use. An API token with R2 permissions is also an S3 key pair: its id
  (from `GET /user/tokens/verify`) is the access key id and the SHA-256 of its value the secret
  ([R2 authentication](https://developers.cloudflare.com/r2/api/tokens/#get-s3-api-credentials-from-an-api-token)).
  The upload speaks S3, not the object endpoint `wrangler r2 object put` uses, which on 2026-09-24
  ignored `If-None-Match: *`, stored a body with a wrong `Content-MD5`, and counted against the
  token's 1,200 requests per five minutes that preview deploys share.
- **What that token can do**: every bucket on the account, deletes included, and every CI job
  holding `DOPPLER_TOKEN` can read it, pull request jobs included. Write-once PUTs are no defence
  against it. That is acceptable while evidence proves nothing; before evidence can skip CI, jobs
  get credentials scoped to their own prefix, from Depot OIDC and a notary Worker
  ([#3110](https://github.com/iterate/iterate/issues/3110)).
- **Traces**: a failing run's `trace.zip` holds the browser's network traffic, preview sign-in
  included. The bucket is private, but `public-playwright-report`, the same folder as a Depot
  artifact, already shows it to anyone Cloudflare Access lets into the viewer.

## Setup

All on the dev/preview account (`376ef7ed81b0573f93524de763666c15`), with
Doppler `_shared/preview`'s `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`.

1. **The bucket and its retention.** Done on 2026-09-24:

   ```sh
   doppler run --project _shared --config preview -- pnpm --dir core/os exec wrangler r2 bucket create iterate-ci
   doppler run --project _shared --config preview -- pnpm --dir core/os exec wrangler r2 bucket lifecycle add iterate-ci evidence-main-after-365-days evidence/ci/trust=main/ --expire-days 365 --force
   doppler run --project _shared --config preview -- pnpm --dir core/os exec wrangler r2 bucket lifecycle add iterate-ci evidence-pr-after-90-days evidence/ci/trust=pr/ --expire-days 90 --force
   doppler run --project _shared --config preview -- pnpm --dir core/os exec wrangler r2 bucket lifecycle add iterate-ci evidence-local-after-30-days evidence/local/ --expire-days 30 --force
   doppler run --project _shared --config preview -- pnpm --dir core/os exec wrangler r2 bucket lifecycle add iterate-ci backups-context-sweep-after-365-days backups/context-sweep/ --expire-days 365 --force
   # nothing expires state/
   doppler run --project _shared --config preview -- pnpm --dir core/os exec wrangler r2 bucket lifecycle list iterate-ci
   ```

   No bucket lock is set ([#3110](https://github.com/iterate/iterate/issues/3110) has the commands).

2. **The upload.** A step of `test.yml`, `preview-os.yml` and `main-os-e2e.yml`,
   with no new secret. Check a run
   ([reading it back](#reading-it-back)).
