# CI And Test Telemetry

Two things, kept apart on purpose:

- **CI telemetry in PostHog**: one event per Depot workflow run and one per job
  attempt, from an hourly sync. It answers which workflow and job ran for which
  pull request, branch and commit, on which runner size, how long it queued and
  ran, and whether it succeeded. Nothing per test.
- **Test telemetry as CI artifacts**: every test runner writes a raw JSON
  artifact, a finalizer checks that every runner left one, and the job keeps
  them as a Depot artifact beside the flake records the
  [flake dashboard](https://github.com/iterate/iterate/issues/2580) reads from
  the test evidence in R2.
  Nothing from here goes to PostHog.

Both feed a third: the [test evidence folder](test-evidence.md), each job
attempt's `test-results/` with a manifest and one Parquet row per test, which
CI puts in the `iterate-ci` R2 bucket.

Per-test events were over 70% of the PostHog project's ingestion (millions a
month), which is why #2494 cut CI delivery to zero. The workflow and job events
are a few thousand a day.

## CI events in PostHog

`.depot/workflows/ci-telemetry.yml` runs `scripts/ci/sync-ci-telemetry.ts`
hourly. It reads Depot's CI API (the Connect methods the Depot CLI uses,
[`ci.proto`](https://github.com/depot/cli/blob/main/proto/depot/ci/v1/ci.proto))
and GitHub's, and posts to PostHog's
[batch endpoint](https://posthog.com/docs/api/capture#batch-events) in the
iterate project (EU, project 115112) with the project key `envs.ts` gives
production (`osEnvs.prd.posthogProjectKey`; a project key is public).

It is a schedule rather than a last step in every workflow because a step
inside a workflow cannot see that workflow's own outcome or duration, a
cancelled workflow skips it, and it would boot one more runner per workflow
run.

**Window.** A sync reports what finished between the previous successful
scheduled sync's creation and its own, both less five minutes (Depot can show
a job as running for a few seconds after its recorded finish). Successful syncs
therefore tile time without a stored cursor, and a failed sync leaves its
window to the next one. A window longer than six hours is cut to the last six.
Every cut, this one or the listing's below, logs a `ci-telemetry.unreported`
warning with the `from` and `until` of the time whose work goes unreported and
the `reason`, and the sync still succeeds, so the next one starts after it.
Every event's UUID derives from Depot's execution or attempt ID, and PostHog
deduplicates by it, so replaying an overlapping window does not double count.

**Listing.** Depot's `ListWorkflows` returns at most the newest 200 and has no
paging, so the sync lists each workflow named in `.depot/workflows` (on main)
separately, plus one unnamed listing for workflows that exist only on a branch
and one of failed workflows for those Depot never started, which have no name.
A workflow can finish up to two hours after it was created (the longest a push,
pull-request or scheduled workflow runs; `os-e2e-soak` is dispatch-only), so
each named listing, and the failed one, has to reach two hours before the
window. One that fills its 200 without reaching back holds every workflow of
its name (or every failed one) created since its oldest, and the window then
starts two hours after that; the warning's `listings` names each such workflow,
or `failed`, and the oldest time its listing reaches. The listings take no time
or branch filter to narrow them by.

**Workflows Depot never started.** A pull request push whose merge ref GitHub
has not updated, as for one that conflicts with main
([Depot CI](depot-ci.md#pull-requests-that-conflict-with-main)), gets a Depot
run with no commit and one failed workflow with no name, file or jobs. It sends
a `ci workflow run finished` with `conclusion: failure`, no `workflow_name`,
`workflow_path` or `sha`, and Depot's reason in `error_message`
(`Merge ref refs/pull/<n>/merge is stale: …`). Any other run without a commit,
or workflow without a name, is a shape the sync has not modelled (`RunMetrics`
in the script), and it fails the sync.

**Late re-runs are not reported.** A re-run keeps its workflow's original
creation time, and Depot's listings offer no update or finish time to list by,
so a re-run started more than two hours after its workflow was created sends
no events. Finding those would mean fetching every workflow a re-run could come
from, every hour.

| Event                      | One per                                                  | Timestamp  |
| -------------------------- | -------------------------------------------------------- | ---------- |
| `ci workflow run finished` | settled workflow execution (a re-run is a new execution) | its finish |
| `ci job attempt finished`  | finished job attempt (a retried job is a new attempt)    | its finish |

A skipped job has no attempt and no event; its workflow run still has one.

Both carry `schema_version: 3` (earlier CI events, from before #2494, have 2
and other properties) and:

| Property                                                                       | Meaning                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow_name`                                                                | The workflow's `name:` (`Preview OS`); absent for a workflow Depot never started                                                                                                                                                                                                                                                            |
| `workflow_path`                                                                | Its file (`preview-os.yml`); absent for a workflow file run with `depot ci run`                                                                                                                                                                                                                                                             |
| `workflow_id`                                                                  | Depot's workflow ID; `url` links to it on Depot                                                                                                                                                                                                                                                                                             |
| `depot_run_id`                                                                 | The Depot run (one GitHub event) the workflow belongs to                                                                                                                                                                                                                                                                                    |
| `trigger`                                                                      | `pull_request`, `push`, `schedule`, `workflow_dispatch`, `api` (`depot ci run`)                                                                                                                                                                                                                                                             |
| `sha` / `head_sha`                                                             | The commit Depot ran (a pull request's test merge) and the pushed head; no `sha` for a workflow Depot never started                                                                                                                                                                                                                         |
| `pull_request_number`                                                          | The pull request; for a push to main, the pull request whose merge made the commit. Absent for schedules and dispatches                                                                                                                                                                                                                     |
| `branch`                                                                       | The pull request's head branch, or the branch a merge landed on. Absent where Depot records no branch (schedules, dispatches by SHA)                                                                                                                                                                                                        |
| `attempt`                                                                      | Execution number (workflow runs) or attempt number (job attempts)                                                                                                                                                                                                                                                                           |
| `conclusion`                                                                   | `success`, `failure` or `cancelled`                                                                                                                                                                                                                                                                                                         |
| `error_message`                                                                | Workflow runs only: why Depot failed a workflow it never started                                                                                                                                                                                                                                                                            |
| `queued_at` / `started_at` / `finished_at`, `queue_duration_ms`, `duration_ms` | Depot's times; queue is created → started, duration is started → finished                                                                                                                                                                                                                                                                   |
| `job_name`, `job_id`, `attempt_id`                                             | Job attempts only: the job's key in its file (`e2e`, `build-firmware:matrix-5`) and Depot's IDs                                                                                                                                                                                                                                             |
| `runner_size`                                                                  | Job attempts only: the job's `runs-on` in the workflow file at `sha` (`4x16`, or a label such as `depot-ubuntu-24.04`)                                                                                                                                                                                                                      |
| `test_run_id`, `test_evidence_uploaded`, `test_evidence_prefix`                | Job attempts of the jobs that upload a [test evidence](test-evidence.md) folder (Test, and the e2e jobs of Preview OS and Main OS e2e) only: the folder's `testrun_<attempt id>`, whether the upload step's line in the attempt's Depot summary names a prefix in `iterate-ci`, and that prefix. `false` whatever kept the folder out of R2 |

Pull requests and branches come from GitHub because Depot records only the ref
it ran: `refs/pull/<n>/merge` for a pull request, the merge commit for a pull
request's `closed` event, a bare SHA for a push and nothing for a schedule.

Credentials: the Depot organization token `DEPOT_CI_TELEMETRY_TOKEN` in Doppler
`_shared/preview` (Depot has no read-only token, so it has organization API
scope; never reuse a personal login), and the job's `${{ github.token }}`
(`contents: read`, `pull-requests: read`). Rotate the Depot token at Depot if it
is ever exposed; deleting the Doppler secret does not revoke it.

See what a window would send without sending it, or replay a window:

```bash
DEPOT_CI_TELEMETRY_TOKEN="$(doppler secrets get DEPOT_CI_TELEMETRY_TOKEN --plain --project _shared --config preview)" \
GITHUB_TOKEN="$(gh auth token)" \
  pnpm tsx scripts/ci/sync-ci-telemetry.ts --dry-run --since 2026-09-24T00:00:00Z [--until …]
```

Without `--dry-run` a `--since` run delivers. On 2026-09-24, a night with about
25 merged pull requests, it counted about 4,800 events a day between 18:30 and
23:30 UTC and about 7,000 a day between 23:30 and 05:30.

The PostHog dashboards from before #2494 (CI reliability & performance,
839069; Test reliability & performance, 839068) were built on the old events
and have not been rebuilt for these.

## Test telemetry artifacts

```text
Vitest (retry-telemetry-reporter.ts) / Playwright (playwright-telemetry-reporter.ts)
                    │
                    ▼
  test-results/ci-telemetry/raw/*.json      schema-validated, atomic, no network I/O
                    │
                    ▼  if: always()
  scripts/ci/upload-test-telemetry.ts --flake-suites unit|specs|preview-e2e
     checks every expected runner left a complete artifact
     writes test-results/ci-telemetry/manifest.json
     writes the job's suite's suite-summary.json beside its flake records
                    │
                    ▼  if: always(), if-no-files-found: error
  actions/upload-artifact: {unit,preview,main}-test-telemetry-attempt-<job attempt id>
```

The contract is `packages/shared/src/test-support/ci-telemetry.ts`. Two
producers write it: `vitest-retry-telemetry-reporter` (every workspace's unit
tests and the OS e2e suite) and `playwright-telemetry-reporter` (the root
browser specs). Writers use `writeTestTelemetryArtifact()`, which validates and
atomically renames, so a killed process cannot leave a valid-looking partial
file. Each runner first writes a pessimistic sentinel from its first real
lifecycle hook and replaces it at normal shutdown; merely importing or
constructing a reporter writes nothing. A runner killed after it started
therefore leaves an explicit `TestTelemetryIncompleteError` artifact instead of
nothing.

`TEST_TELEMETRY_ARTIFACT_DIR` (CI sets `test-results/ci-telemetry/raw`) is the
directory the finalizer reads; relative paths resolve from `GITHUB_WORKSPACE`.
`TEST_TELEMETRY_ARTIFACT_FILE` adds a named copy. With neither set a reporter
writes nothing. File names carry a short hash of the full artifact ID.
`TEST_TELEMETRY_HEAD_SHA`, `TEST_TELEMETRY_BRANCH` and
`TEST_TELEMETRY_PULL_REQUEST_NUMBER` pin the tested source when it differs from
the workflow's ref.

A raw artifact lives for one CI run: the same job's finalizer reads it, and so
does Main OS e2e's failing-rows step (`scripts/ci/main-e2e-alert.ts`). Change
its schema in place, together with those readers; there is no versioned
migration.

What the artifacts hold, by runner:

| Runner     | Attempts                   | Detail                                                                                                              |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Playwright | every attempt              | every nested step including hooks, fixtures, expects and API calls; worker and parallel index; errors; output sizes |
| Vitest     | aggregate retry count only | before/after-each and body time, `e2e-phase` annotations, module lifecycle and import costs                         |

Vitest's public reporter receives one final `onTestCaseResult` with aggregate
duration and retry count, not each attempt's duration: do not rank a retried
Vitest row as a no-retry sample or manufacture attempt durations. Playwright
nested steps overlap their parents, so group or rank them rather than summing.
Playwright only creates steps for its own APIs, hooks, fixtures, assertions and
explicit `test.step` calls; wrap long domain helpers in a stable `test.step`
name or their time stays unattributed (`helpers.createFixture` does this for
every spec). The reporters follow the runners' reporter APIs
([Playwright](https://playwright.dev/docs/api/class-reporter),
[Vitest](https://vitest.dev/api/advanced/reporters)) rather than parsing
console text.

### The finalizer's completeness check

The finalizer fails the job, after writing the manifest and the summaries, when:

- an expected workspace left no artifact. The Test workflow passes
  `--expect-unit-workspaces`, which reads them from the checkout: every
  pnpm-workspace package with a `test` or `test:unit` script. It is not a list
  in test.yml: while the job checked out a PR's head under its merge ref's
  workflow file, main's list failed every PR opened before a workspace was
  added ([Which tree a pull request's CI tests](depot-ci.md#which-tree-a-pull-requests-ci-tests)).
  Preview OS and Main OS e2e name `iterate-root,os` in
  `TEST_TELEMETRY_EXPECTED_WORKSPACES`. This is what catches a runner that
  never started;
- a sentinel was never replaced (a runner started and was killed);
- an artifact belongs to another CI run, attempt or job than the newest
  artifact's (a stale or foreign file);
- two artifacts share an ID.

A superseded run passes `--cancelled`: its partial evidence is checked and kept
but not reported as failures, and a run cancelled before any reporter started
keeps an empty manifest. `manifest.json` lists the expected, observed and
missing workspaces, the incomplete and foreign artifact IDs, and each
artifact's producer and test count.

List and download a job's artifact from its Depot run (the upload action prints
a GitHub-looking URL that `gh run download` cannot fetch):

```bash
depot_run_id="$(depot ci run list --org 0p91s0lz49 --repo iterate/iterate \
  --sha "$(git rev-parse HEAD)" --output json | jq -r '.[0].run_id')"
artifact_id="$(depot ci artifacts list "$depot_run_id" --org 0p91s0lz49 --output json \
  | jq -r '[.artifacts[] | select(.name | startswith("unit-test-telemetry-attempt-"))]
    | max_by(.attempt) | .artifact_id')"
depot ci artifacts download "$artifact_id" --org 0p91s0lz49 --output-file /tmp/unit.zip
unzip -q /tmp/unit.zip -d /tmp/unit
jq '.tests[] | {moduleId, fullName, durationMs, retryCount, phases}' /tmp/unit/raw/*.json
```

Re-run the check on a downloaded artifact with
`pnpm tsx scripts/ci/upload-test-telemetry.ts --artifact-root /tmp/unit`.

### Adding or changing a reporter

1. Extend the Zod schema only with runner-neutral fields; a capability a
   runner lacks stays optional.
2. Write raw artifacts only; a reporter performs no network I/O.
3. Include every final test, failed attempt and error, partial phase, module
   and run status. Never drop a failed or incomplete result. Normalize runner
   placeholders before validation: Playwright reports negative durations for
   steps still active at interruption, so the reporter records zero duration
   and a `PlaywrightIncompleteStepError`.
4. Write the sentinel from the first real lifecycle hook.
5. Pin `TEST_TELEMETRY_WORKSPACE` in the command's environment. A unit
   workspace is expected once it has a `test` script; a preview job's runner
   goes in its workflow's `TEST_TELEMETRY_EXPECTED_WORKSPACES`.
6. Keep the finalizer and the artifact upload as `if: always()` steps.

## Current unknown flakes

Any test that fails then passes on retry on **main** enters Unknown flakes,
including when the rest of its suite is interrupted. It stays until **20
consecutive clean main passes** in that suite. Another retry or final failure
resets the streak. If it is absent from the full test list of the newest
complete main run after its last failure, the row goes at once. PR results,
skips and incomplete runs cannot advance its streak or prove its deletion.
Adding a wrapper on main moves it to Flakes or Failures.

The dashboard recomputes all of this every hour from the runs it reads, in the
order their evidence reached R2 (`scripts/ci/flake-dashboard/`), so a result
that arrives late is simply placed where it belongs. The passes come from the
per-test results of each suite's newest 30 main runs.

Known `createFlake` tests suggest removing their wrapper after the same 20 main
passes, without a minimum elapsed time. They remain wrapped until someone
changes the code. Sentinels never propose unwrapping; `createFailing` proposals
retain their separate thresholds.

Full CI finalizers write `suite-summary.json` alongside the flake JSONL,
including zero-flake runs. Summaries include each test's bare title and result;
the reporters use that same title for retries and wrappers. Multiple instances
sharing a title count as one run, and all must pass to advance it. Missing
reporters, unexecuted tests, wrong commits, interrupted runs and damaged/missing
records cannot certify a clean result. Focused local runs do not publish complete
suite summaries. The preview e2e suite's summary also says whether it ran the
rows tagged `slow` (`slowRows: "ran" | "skipped"`; absent when no row is tagged `slow`, so every
row ran), which the PR time to green guard splits pushes on ([Depot CI](depot-ci.md#pr-time-to-green)).

Each suite shows its latest complete main commit, run, test count and failure
count. An incomplete attempt keeps that provenance visible with a warning,
while any observed retry/failure still adds or resets its unknown-flake row.

Main's preview suites run in Main OS e2e (`main-os-e2e.yml`), on its own
preview redeployed with each main push. Their evidence, like the Test job's on a
main push, is filed under `trust=main`, which is what makes a run a main run for
the dashboard ([object keys](test-evidence.md#object-keys)).
