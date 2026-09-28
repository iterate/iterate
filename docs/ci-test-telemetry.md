# CI And Test Telemetry

Two things, kept apart on purpose:

- **CI telemetry in PostHog**: one event per Depot workflow run and one per job attempt, from an
  hourly sync. Nothing per test: per-test events were over 70% of the PostHog project's ingestion,
  which is why #2494 cut them.
- **Test telemetry as CI artifacts**: every test runner writes a raw JSON artifact, a finalizer
  checks that every runner left one, and the job keeps them in its
  [test evidence folder](test-evidence.md), in a Depot artifact and in R2, beside the flake records
  the [flake dashboard](https://github.com/iterate/iterate/issues/2580) reads. Nothing from here
  goes to PostHog.

## CI events in PostHog

`.depot/workflows/ci-telemetry.yml` runs `scripts/ci/sync-ci-telemetry.ts` hourly. It reads
Depot's CI API (the Connect methods the Depot CLI uses,
[`ci.proto`](https://github.com/depot/cli/blob/main/proto/depot/ci/v1/ci.proto)) and GitHub's, and
posts to PostHog's [batch endpoint](https://posthog.com/docs/api/capture#batch-events) in the
iterate project (EU, project 115112) with the public project key `envs.ts` gives production. It is a
schedule, not a last step in every workflow, because a step cannot see its own workflow's outcome
or duration, and a cancelled workflow skips it.

- **Window.** A sync reports what finished between the previous successful scheduled sync's creation
  and its own, both less five minutes, so successful syncs tile time without a cursor and a failed
  one leaves its window to the next. A window over six hours is cut to the last six. Every cut logs
  a `ci-telemetry.unreported` warning with `from`, `until` and `reason`, and the sync still succeeds.
  Event UUIDs derive from Depot's IDs and PostHog deduplicates by them, so a replay does not double
  count.
- **Listing.** Depot's `ListWorkflows` returns at most the newest 200 with no paging, so the sync
  lists each workflow in `.depot/workflows` (on main) separately, plus one unnamed listing for
  branch-only workflows and one of failed workflows. Each has to reach two hours before the window
  (the longest a non-dispatch workflow runs); one that fills its 200 without reaching back moves the
  window's start, and the warning's `listings` names it.
- **Workflows Depot never started** (a PR that conflicts with main,
  [Depot CI](depot-ci.md#pull-requests-that-conflict-with-main)) send a `ci workflow run finished`
  with `conclusion: failure`, no `workflow_name`, `workflow_path` or `sha`, and Depot's reason in
  `error_message`. Any other run without a commit, or workflow without a name, fails the sync
  (`RunMetrics` in the script).
- **Late re-runs are not reported**: a re-run started more than two hours after its workflow was
  created sends no events, since Depot lists by creation only.

| Event                      | One per                                                  | Timestamp  |
| -------------------------- | -------------------------------------------------------- | ---------- |
| `ci workflow run finished` | settled workflow execution (a re-run is a new execution) | its finish |
| `ci job attempt finished`  | finished job attempt (a retried job is a new attempt)    | its finish |

A skipped job has no attempt and no event; its workflow run still has one.

Both carry `schema_version: 3` and:

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

Pull requests and branches come from GitHub, because Depot records only the ref it ran. The
PostHog dashboards from before #2494 (839069, 839068) read the old events and were not rebuilt.

Credentials: the Depot organization token `DEPOT_CI_TELEMETRY_TOKEN` in Doppler `_shared/preview`
(Depot has no read-only token, so it has organization API scope; never reuse a personal login;
rotate it at Depot if exposed, since deleting the Doppler secret does not revoke it), and the job's
`${{ github.token }}` (`contents: read`, `pull-requests: read`). See what a window would send, or
replay one (without `--dry-run`, a `--since` run delivers):

```bash
GITHUB_TOKEN="$(gh auth token)" \
  node scripts/ci/sync-ci-telemetry.ts --dry-run --since <ISO time> [--until …]
```

## Test telemetry artifacts

```text
Vitest (retry-telemetry-reporter.ts) / Playwright (playwright-telemetry-reporter.ts)
                    │
                    ▼
  test-results/ci-telemetry/raw/*.json      schema-validated, atomic, no network I/O
                    │
                    ▼  if: always()
  scripts/ci/test-evidence.ts finalize --flake-suites unit|specs|preview-e2e
     test-telemetry-finalizer.ts:
     checks every expected runner left a complete artifact
     writes test-results/ci-telemetry/manifest.json
     writes the job's suite's suite-summary.json beside its flake records
     then the test evidence manifest (test-evidence.md)
                    │
                    ▼  if: always(), if-no-files-found: error
  actions/upload-artifact: {unit,preview-os,main-os}-test-artifacts-attempt-<job attempt id>
     all of test-results/, the evidence folder (test-evidence.md)
```

The contract is `packages/shared/src/test-support/ci-telemetry.ts`, written by
`vitest-retry-telemetry-reporter` (every workspace's unit tests and the OS e2e suite) and
`playwright-telemetry-reporter` (the root browser specs) through `writeTestTelemetryArtifact()`,
which validates and renames atomically. Each runner writes a pessimistic sentinel from its first
real lifecycle hook and replaces it at normal shutdown, so a runner killed after it started leaves a
`TestTelemetryIncompleteError` artifact instead of nothing.

`TEST_TELEMETRY_ARTIFACT_DIR` (CI: `test-results/ci-telemetry/raw`) is the directory; without it a
reporter writes nothing. `TEST_TELEMETRY_HEAD_SHA`, `TEST_TELEMETRY_BRANCH` and
`TEST_TELEMETRY_PULL_REQUEST_NUMBER` pin the tested source when it differs from the workflow's ref.
A raw artifact's readers are the same job's finalizer and the health job (OS real model's, through
`scripts/monitors/e2e.ts`): change the schema in place together with them.

Each test is one record after all its attempts: its file and titles, tags, expected state and
(Playwright) outcome, final state, retry count and whether a retry rescued it, start and total
duration, its errors and first failure. A field nothing reads is not recorded. Vitest reports one
aggregate duration per test, not each attempt's: do not rank a retried row as a no-retry sample.

### The finalizer's completeness check

The finalizer fails the job, after writing the manifest and the summaries, when:

- an expected workspace left no artifact: the Test workflow passes `--expect-unit-workspaces`, read
  from the checkout (every workspace package with a `test` script, never a list in
  test.yml, [Which tree a pull request's CI tests](depot-ci.md#which-tree-a-pull-requests-ci-tests));
  Preview OS and Main OS e2e name theirs in `TEST_TELEMETRY_EXPECTED_WORKSPACES`;
- a sentinel was never replaced (a runner started and was killed);
- an artifact belongs to another CI run, attempt or job than the newest artifact's;
- two artifacts share an ID.

A superseded run passes `--cancelled`: its partial evidence is checked and kept, not reported as
failures. `manifest.json` lists the expected, observed and missing workspaces, the incomplete and
foreign artifact IDs, and each artifact's producer and test count. Download a job's artifact and
re-run the check:

```bash
depot_run_id="$(depot ci run list --org 0p91s0lz49 --repo iterate/iterate \
  --sha "$(git rev-parse HEAD)" --output json | jq -r '.[0].run_id')"
artifact_id="$(depot ci artifacts list "$depot_run_id" --org 0p91s0lz49 --output json \
  | jq -r '[.artifacts[] | select(.name | startswith("unit-test-artifacts-attempt-"))]
    | max_by(.attempt) | .artifact_id')"
depot ci artifacts download "$artifact_id" --org 0p91s0lz49 --output-file /tmp/unit.zip
unzip -q /tmp/unit.zip -d /tmp/unit
jq '.tests[] | {moduleId, fullName, durationMs, retryCount, firstFailure}' /tmp/unit/ci-telemetry/raw/*.json
node scripts/ci/test-telemetry-finalizer.ts --artifact-root /tmp/unit/ci-telemetry
```

### Adding or changing a reporter

1. Extend the Zod schema only with runner-neutral fields; a capability a runner lacks stays
   optional.
2. Write raw artifacts only; a reporter performs no network I/O.
3. Include every final test, its errors and the run's status; never drop a failed or incomplete
   result. Normalize runner placeholders (Playwright's negative duration for an attempt still active
   at interruption becomes zero).
4. Write the sentinel from the first real lifecycle hook.
5. Pin `TEST_TELEMETRY_WORKSPACE` in the command's environment; a preview job's runner goes in its
   workflow's `TEST_TELEMETRY_EXPECTED_WORKSPACES`.
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
row ran), which PR time to green splits pushes on ([Depot CI](depot-ci.md#pr-time-to-green)).

Each suite shows its latest complete main commit, run, test count and failure
count. An incomplete attempt keeps that provenance visible with a warning,
while any observed retry/failure still adds or resets its unknown-flake row.

Main's preview suites run in Main OS e2e (`main-os-e2e.yml`), on its own
preview redeployed with each main push. Their evidence, like the Test job's on a
main push, is filed under `trust=main`, which is what makes a run a main run for
the dashboard ([object keys](test-evidence.md#object-keys)).
