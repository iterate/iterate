# CI And Test Telemetry

PostHog is the historical query layer for test performance, failures, flakes,
CI queueing, Depot utilization, and automated-review outcomes. Retained CI
artifacts are the replayable source evidence. Vitest unit/e2e, Playwright e2e,
Node tests, and standalone smoke scripts all use one runner-neutral data model.

This page is linked from the repository README and is the canonical contract.

## Architecture

```text
Vitest / Playwright / node:test / smoke script
                    │
                    ▼
  test-results/ci-telemetry/raw/*.json
  (schema-validated, atomic, no network I/O)
                    │
                    ▼  if: always()
 scripts/ci/upload-test-telemetry.ts
     validate schema, IDs, and expected runner cardinality
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
 normalized/manifest.json   normalized/posthog-events.json
          │                    │
          └─────────┬──────────┘
                    ├── PostHog batch upload
                    └── actions/upload-artifact@v4 (always)
```

Reporters never know about PostHog and never perform network I/O. The single
finalizer in each CI job reads every canonical raw artifact, transmogrifies it
into schema-v2 events, writes the exact replayable batch, then uploads it. The
following artifact-upload step also uses `if: always()` and
`if-no-files-found: error`, so a failed test or failed PostHog delivery still
retains the evidence and missing evidence cannot look healthy.

Every CI finalizer explicitly runs under Doppler `_shared/prd`, the canonical
PostHog project used by the dashboards below. Test execution may use a
lane-specific config such as `test/dev`, but the finalizer must never inherit
that config's analytics key: doing so produces a successful capture response
in a different PostHog project and silently splits the dataset. Workflow tests
enforce the canonical finalizer command for unit, preview, and marathon runs.

The raw-artifact contract lives in
`packages/shared/src/test-support/ci-telemetry.ts`. Writers use
`writeTestTelemetryArtifact()`, which validates and atomically renames JSON so
a killed process cannot leave a valid-looking partial file. Each runner first
writes a pessimistic failure sentinel from its first real lifecycle hook and
replaces it at normal shutdown. Merely importing or constructing a reporter
must not write evidence. A watchdog kill after runner startup therefore leaves
an explicit `TestTelemetryIncompleteError` run/lane instead of disappearing
from the dataset. A reporter may set both outputs:

- `TEST_TELEMETRY_ARTIFACT_FILE` is a named immediate copy that the preview
  orchestrator can read for its PR retry summary.
- `TEST_TELEMETRY_ARTIFACT_DIR` is the durable directory consumed by the final
  CI step. Relative paths resolve from `GITHUB_WORKSPACE`, even when pnpm runs a
  reporter from a child workspace.

The named canonical file is not a runner-native report. Keep it at a distinct
path from outputs such as Playwright's `test-results/playwright-results.json`;
otherwise the reporters can overwrite one another during shutdown. Targeted
preview Playwright runs use
`test-results/preview-target-playwright-telemetry.json` for the canonical file
and retain `playwright-results.json` separately for runner-native inspection.

The preview orchestrator also supplies `TEST_TELEMETRY_HEAD_SHA`,
`TEST_TELEMETRY_BRANCH`, and `TEST_TELEMETRY_PULL_REQUEST_NUMBER`. That keeps
manually dispatched runner artifacts attached to the selected PR head instead
of the workflow-dispatch ref. Durable filenames contain a short hash of the
full artifact ID, avoiding collisions after path-unsafe characters are
normalized.

CI sets the directory to `test-results/ci-telemetry/raw`. A local reporter does
nothing when neither output is configured. There is deliberately no
`TEST_TELEMETRY_ENABLED` switch and no direct-send path.

Raw artifacts currently use `artifactSchemaVersion: 1`; normalized PostHog
events use `schema_version = 2`. Both are durable interfaces. Never change the
meaning of an existing field or version in place. A breaking raw-artifact
change must add a new discriminated schema version and an explicit migration in
the finalizer, with a fixture proving that retained artifacts from every older
supported version still produce the same normalized events. A breaking event
change must emit a new `schema_version` and keep dashboard queries pinned to
the version whose semantics they expect.

List and download an artifact from the Depot run that owns normal CI:

```bash
ci_head_sha="$(git rev-parse HEAD)"
depot_run_id="$(depot ci run list \
  --org 0p91s0lz49 \
  --repo iterate/iterate \
  --sha "$ci_head_sha" \
  --output json | jq -r '.[0].run_id')"
artifact_name=unit-test-telemetry
artifact_id="$(depot ci artifacts list "$depot_run_id" \
  --org 0p91s0lz49 \
  --output json | jq -r --arg name "$artifact_name" \
  '.artifacts[] | select(.name == $name) | .artifact_id')"
depot ci artifacts download "$artifact_id" \
  --org 0p91s0lz49 \
  --output-file "/tmp/$artifact_name.zip"
unzip -q "/tmp/$artifact_name.zip" -d "/tmp/$artifact_name"
```

Depot owns artifacts produced by its workflows. The upload action can print a
GitHub-looking actions URL, but `gh run download` or the GitHub Actions
artifact API may return 404 for it. Use `depot ci artifacts` for Depot runs;
use `gh run download` only for a real GitHub Actions run.

Replay or inspect the downloaded artifact without sending it:

```bash
pnpm tsx scripts/ci/upload-test-telemetry.ts \
  --artifact-root "/tmp/$artifact_name" \
  --dry-run

jq '.tests[] | {moduleId, fullName, durationMs, retryCount, phases}' \
  "/tmp/$artifact_name"/raw/*.json
```

`--dry-run` still writes `normalized/manifest.json` and
`normalized/posthog-events.json`. To intentionally replay the same retained
evidence to the canonical project, use:

```bash
doppler run --project _shared --config prd -- \
  pnpm tsx scripts/ci/upload-test-telemetry.ts \
  --artifact-root "/tmp/$artifact_name"
```

Every event has both a readable stable `$insert_id` property and a
deterministic top-level `uuid`; PostHog deduplicates retries and replays by the
UUID. A repeated normalized batch is therefore idempotent.

The unit job also sets `TEST_TELEMETRY_EXPECTED_WORKSPACES` to all ten test
workspaces. Preview cannot use a static workspace list because its selected app
set varies. Before it starts an app command, its orchestration artifact instead
records one exact expected source per sub-runner: producer, framework, test
kind, lane, and workspace. The finalizer compares source **cardinality** across
all artifacts, so two expected marathon invocations require two artifacts and
a lookalike producer or stale artifact from another run/attempt/job cannot
satisfy the contract. Foreign artifacts are retained and fail the finalizer.
Commands pin
`TEST_TELEMETRY_WORKSPACE` rather than relying on pnpm's ambient package name.

The finalizer writes the normalized evidence and manifest, delivers every valid
artifact plus one `ci test telemetry finalized` completeness event, then fails
if a workspace/source is absent or a pessimistic sentinel was never replaced.
One crashed runner therefore cannot suppress the other runners' queryable
evidence, while incomplete telemetry can never leave a green job. The retained
manifest keeps exhaustive expected, observed, and missing workspaces and
sources; the PostHog event keeps counts and compact source labels. A
superseded/cancelled CI run uses
`--cancelled`: any partial evidence (or an explicit empty manifest when
cancellation preceded runner startup) is normalized and retained but not sent
as a test failure; `ci workflow finished` owns that cancelled outcome.
`--dry-run` remains the strict no-delivery mode for local inspection and replay
validation.

## One Test Model

Every test event has `schema_version = 2`. Framework and test type are
dimensions, never separate event families.

| Dimension           | Values / examples                                                                      |
| ------------------- | -------------------------------------------------------------------------------------- |
| `framework`         | `vitest`, `playwright`, `node-test`, `script`; orchestration aggregates may be `mixed` |
| `test_kind`         | `unit`, `integration`, `e2e`                                                           |
| `workspace` / `app` | pnpm package and deployed application                                                  |
| `lane`              | `unit`, `vitest`, `playwright`, `onboarding-smoke`, `tui`, `preview`                   |
| source              | repository, SHA, branch, pull request                                                  |
| execution           | workflow/run/attempt/job URLs, runner provider, preview slot, test project             |
| identity            | stable artifact, test-run, logical-test, and execution IDs                             |

| Event                          | Grain                                  | Evidence                                                                                                                             |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ci test run started/finished` | runner or orchestration operation      | status, wall duration, test/failure/retry/module/lane counts, incomplete-telemetry flag                                              |
| `ci test lane finished`        | app/lane command                       | status, exit code, wall duration, collection errors and incomplete-telemetry flag                                                    |
| `ci test finished`             | logical test                           | source location, raw state, expected outcome, total/body/hooks/schedule time, timeout, retries, heap, tags, annotations, first error |
| `ci test attempt finished`     | concrete attempt                       | index, state, duration, schedule delay, worker, attachments, stdout/stderr bytes, error                                              |
| `ci test phase finished`       | explicit operation or Playwright step  | nested title, category, start/duration, source, attachments, error                                                                   |
| `ci test module finished`      | Vitest module                          | environment, prepare, collect, setup, import, queue, and execution timing                                                            |
| `ci test import finished`      | imported module within a Vitest module | self and total import duration                                                                                                       |
| `ci test telemetry finalized`  | one finalizer job                      | expected/observed/missing workspaces and runner sources, incomplete artifacts, runner-event count, final status                      |

`attempt_detail` is `complete` when all attempts are present and
`aggregate-only` when only the runner's aggregate retry count/duration exists.
`started_at_source` is `runner`, `reporter-clock`, or `inferred`; never compare
inferred Node scheduling latency as if it were a native runner timestamp.
Run/lane status keeps `timedout`, `interrupted`, and `cancelled` separate from
`failed`. For Playwright, `test_state` is the final raw runner result while
`test_outcome` says whether that result was expected, unexpected, flaky, or
skipped. Expected failures therefore remain visible without inflating the
failure rate.

Raw artifacts retain every Playwright phase and Vitest import. The PostHog
normalizer bounds each parent to its 100 most diagnostic detail events,
prioritizing errors, user-authored `test.step`s, and duration. Parent events
carry total/emitted/omitted counts (`phase_*` and `import_*`), so truncation is
explicit; retained raw JSON remains available if a deeper one-run audit needs
the full graph.

### Runner Capability Matrix

| Runner           | Complete attempts              | Native start time | Root-cause detail                                                                                                                                                  |
| ---------------- | ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Playwright       | yes                            | yes               | all nested steps including hooks, fixtures, expects, and API calls; worker/parallel index; errors; output/attachment sizes; timeout/tags/annotations               |
| Node `test`      | yes                            | no                | runner attempt duration and error; reporter infers start from observation time minus duration and labels it `inferred`                                             |
| Vitest           | no: aggregate retry count only | yes               | before/after-each duration, body remainder, explicit `e2e-phase` annotations, heap/slow/repeat diagnostics when enabled, module lifecycle, individual import costs |
| Onboarding smoke | yes                            | reporter clock    | explicit project creation, agent readiness, greeting, and failure phases, including partial phases on a failed attempt                                             |

Vitest's public reporter receives one final `onTestCaseResult`; its diagnostic
contains aggregate duration/retry count but not each attempt's duration. Do not
rank a retried Vitest row as a no-retry sample, and do not manufacture attempt
durations. Playwright nested steps can overlap their parents, so group or rank
them; do not sum every parent and child row. Playwright only creates native
steps for its own APIs, hooks, fixtures, assertions, and explicit `test.step`
calls. Wrap long domain helpers or plain asynchronous operations in stable,
low-cardinality `test.step` names or the time between native steps remains
unattributed. The shared `helpers.createFixture` does this for every spec.

The implementation follows the runners' supported reporter surfaces rather
than parsing console text: [Playwright Reporter API](https://playwright.dev/docs/api/class-reporter),
[Playwright JSON/blob reports](https://playwright.dev/docs/test-reporters), and
[Vitest advanced reporter lifecycle](https://vitest.dev/api/advanced/reporters).
GitHub artifacts are intended for retained test output and cross-step/job data
([GitHub workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)).
The run/job/result/URL vocabulary also follows the direction of OpenTelemetry's
[CI/CD semantic conventions](https://opentelemetry.io/docs/specs/semconv/cicd/),
while PostHog events remain the query representation used by this repository.

## GitHub Actions, Depot, And Review Bots

`.depot/workflows/ci-telemetry.yml` runs
`scripts/ci/sync-ci-telemetry.ts` every 15 minutes over a rolling window.
Stable insert IDs make overlapping windows and manual backfills of immutable
completion events idempotent. Review-state events are periodic snapshots and
therefore use the sync's actual observation time. Event timestamps are the
provider's completion time or the snapshot's observation time, not an
unrelated PR-updated timestamp.

The scheduled collector reads `github-actions`, `github-reviews`, and `depot` as
independent sources. A failed provider cannot erase healthy events from either
of the others: the collector sends every successful source plus one health
event per source, then fails the job. All three health rows share
`telemetry_sync_id`; CI rows also share `collector_head_sha`. Each records
status, event count, lookback, duration, and a bounded error name/message.
PostHog delivery failure still fails the job, and the dashboard then becomes
stale rather than claiming the collection was healthy. The two GitHub sources
run serially on their shared token while Depot collects concurrently.

| Event                               | Source                        | Questions answered                                                        |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `ci workflow finished`              | GitHub Actions and Depot APIs | failure/cancellation rate, queue/run/total wall time by workflow/provider |
| `ci job finished`                   | GitHub Actions and Depot APIs | slow/failing jobs and failed-step rate                                    |
| `ci job attempt finished`           | Depot metrics                 | retries, availability, queue/run time, average/peak CPU and memory        |
| `ci review finished`                | GitHub checks/reviews         | immutable completion/duration for Cursor Bugbot and Iterate Review        |
| `ci review state observed`          | GitHub review threads         | current findings and unresolved findings by provider and PR head          |
| `ci telemetry source sync finished` | scheduled collector           | freshness, success/failure, event count, error, and collector version     |

Finding counts are mutable and therefore belong only to the state snapshot;
they are not rewritten into immutable review-completion events. Iterate Review
is captured from submitted GitHub App reviews even when it has no check-run.
Thread authors are normalized to the correct provider before counting.

CI needs a dedicated [Depot organization API token](https://depot.dev/docs/cli/authentication#organization-tokens) named
`DEPOT_CI_TELEMETRY_TOKEN`. Depot does not currently expose a read-only token
limited to CI metrics, so this credential has broad organization API scope.
Never reuse a developer's personal Depot login token. Create a dedicated token
named `CI telemetry` in Depot Organization Settings, then store it as a secret
variant restricted to this repository and workflow. The scheduled job
intentionally fails if it is missing:

```bash
read -rs DEPOT_TELEMETRY_VALUE
printf '%s' "$DEPOT_TELEMETRY_VALUE" | \
  depot ci secrets set DEPOT_CI_TELEMETRY_TOKEN ci-telemetry \
    --from-stdin \
    --org 0p91s0lz49 \
    --repo iterate/iterate \
    --workflow ci-telemetry.yml \
    --description "Dedicated Depot organization API token for historical CI telemetry"
unset DEPOT_TELEMETRY_VALUE
```

Confirm the variant scope with `depot ci secrets list --org 0p91s0lz49`.
Rotate or revoke the organization token immediately if it is ever exposed;
deleting the secret alone does not revoke the token at Depot.

Local collection uses `gh` auth and the developer's Depot CLI login:

```bash
GH_TOKEN="$(gh auth token)" \
  doppler run --project _shared --config prd -- \
  pnpm tsx scripts/ci/sync-ci-telemetry.ts --dry-run
```

## Dashboards

- [Test reliability & performance](https://eu.posthog.com/project/115112/dashboard/839068)
  ranks no-retry tests, failure/flake rates, module/import startup, scheduling,
  hooks/body, named phases, and incomplete/missing runner evidence. The first
  two tables make finalizer completeness explicit for both unit jobs (expected
  workspaces) and preview jobs (expected runner sources).
- [CI reliability & performance](https://eu.posthog.com/project/115112/dashboard/839069)
  covers GitHub/Depot workflow and job reliability, queue/execution latency,
  Depot saturation, telemetry-source freshness, and Cursor/Iterate review
  outcomes and unresolved state.

Both dashboards default to 30 days and honor the dashboard date filter. A
healthy zero never renders as a blank table:

- test finalizers say `HEALTHY` or `INCOMPLETE`;
- review snapshots say `HEALTHY`, `ACTION REQUIRED`, or
  `NO SNAPSHOTS RECEIVED`;
- source health says `HEALTHY`, `EMPTY COLLECTION`, `STALE`,
  `ACTION REQUIRED`, or `NO HEALTH EVENT`.

`EMPTY COLLECTION` means the provider call succeeded but returned no events;
inspect it whenever repository activity was expected. `STALE` means the newest
health event is more than 30 minutes old (twice the schedule interval). Blank,
missing, stale, unknown, incomplete, and foreign evidence are never success
states.

Workflow, job, and review tables keep failures, cancellations,
skipped/neutral outcomes, and unknown outcomes in separate columns. Failure
rate is `failures / (successes + failures)`; cancellation rate is
`cancellations / all observations`. Any non-zero `unknown_outcomes` is a data
model defect to investigate, not a bucket to normalize away.

Dashboards answer routine questions. Use HogQL for one SHA, run, branch, test,
or unusual time window. Production test insights filter
`execution_context = 'ci'` where that property applies.

### Dashboard acceptance check

After changing ingestion or a saved insight, force every tile to execute. The
command must return every listed tile with no query error. Seeded health tiles
must return their documented status rows; pure aggregations may have zero rows
for a legitimately quiet filtered window. Then read once through the cache
path used by the UI:

```bash
posthog-cli api info dashboard-insights-run
posthog-cli api call dashboard-insights-run \
  '{"id":839068,"refresh":"force_blocking"}'
posthog-cli api call dashboard-insights-run \
  '{"id":839069,"refresh":"force_blocking"}'
posthog-cli api call dashboard-insights-run \
  '{"id":839068,"refresh":"force_cache"}'
posthog-cli api call dashboard-insights-run \
  '{"id":839069,"refresh":"force_cache"}'
```

Finally open both links in PostHog and verify the rendered tables with the same
date filter. API success is necessary but does not prove that the saved tile
renders or that the browser is using the intended project.

## Analyse With `posthog-cli`

Use the repository's PostHog workflow before guessing a schema or tool:

```bash
posthog-cli api --agent-help
posthog-cli api skill list
posthog-cli api search 'schema events SQL HogQL'
posthog-cli api info read-data-schema
posthog-cli api call read-data-schema \
  '{"query":{"kind":"event_properties","event_name":"ci test finished"}}'
posthog-cli api info execute-sql
```

Longest test without a retry at an exact SHA, across all runners:

```bash
posthog-cli api call execute-sql '{"query":"SELECT properties.framework AS framework, properties.test_kind AS kind, properties.test_name AS test, properties.test_module AS module, max(toFloat(properties.duration_ms)) AS worst_ms, avg(toFloat(properties.duration_ms)) AS mean_ms, count() AS samples FROM events WHERE event = '\''ci test finished'\'' AND toInt(properties.schema_version) = 2 AND toInt(properties.retry_count) = 0 AND properties.head_sha = '\''<full SHA>'\'' GROUP BY framework, kind, test, module ORDER BY worst_ms DESC LIMIT 25"}'
```

Failure and flake rate by runner over 30 days:

```sql
SELECT
  properties.framework AS framework,
  properties.test_kind AS kind,
  count() AS executions,
  countIf(properties.failed = true) AS failures,
  round(100 * failures / executions, 2) AS failure_rate_pct,
  countIf(toInt(properties.retry_count) > 0) AS retried,
  round(100 * retried / executions, 2) AS retry_rate_pct
FROM events
WHERE event = 'ci test finished'
  AND timestamp >= now() - INTERVAL 30 DAY
  AND properties.execution_context = 'ci'
GROUP BY framework, kind
ORDER BY failure_rate_pct DESC, retry_rate_pct DESC
```

Find missing/interrupted runner evidence before trusting an apparently
green/fast sample. This job-grain event still exists when one expected runner
artifact is wholly absent:

```sql
SELECT properties.workflow_name AS workflow,
  properties.job_name AS job,
  count() AS finalizer_count,
  countIf(properties.telemetry_incomplete = true) AS incomplete_count,
  sum(toInt(properties.expected_workspace_count)) AS expected_workspaces,
  sum(toInt(properties.observed_workspace_count)) AS observed_workspaces,
  sum(toInt(properties.missing_workspace_count)) AS missing_workspaces,
  sum(toInt(properties.expected_artifact_source_count)) AS expected_sources,
  sum(toInt(properties.observed_artifact_source_count)) AS observed_sources,
  sum(toInt(properties.matched_expected_artifact_source_count)) AS matched_sources,
  sum(toInt(properties.missing_artifact_source_count)) AS missing_source_count,
  sum(toInt(properties.incomplete_artifact_count)) AS incomplete_artifact_count,
  sum(toInt(properties.foreign_artifact_count)) AS foreign_artifact_count
FROM events
WHERE event = 'ci test telemetry finalized'
  AND timestamp >= now() - INTERVAL 30 DAY
  AND toInt(properties.schema_version) = 2
  AND properties.execution_context = 'ci'
GROUP BY workflow, job
ORDER BY incomplete_count DESC, missing_source_count DESC, finalizer_count DESC
```

Unit finalizers enforce workspace cardinality and can legitimately have zero
expected runner sources. Preview finalizers enforce exact runner-source
cardinality and can legitimately have zero expected workspaces. Always inspect
both sets of columns; source counts alone make healthy unit evidence look
incomplete.

Check whether the historical CI dataset itself is trustworthy before using its
rates or latency:

```sql
SELECT properties.telemetry_source AS telemetry_source,
  argMax(properties.status, timestamp) AS latest_status,
  max(timestamp) AS last_observed_at,
  dateDiff('minute', last_observed_at, now()) AS age_minutes,
  argMax(toInt(properties.event_count), timestamp) AS event_count,
  argMax(properties.telemetry_sync_id, timestamp) AS telemetry_sync_id,
  argMax(properties.collector_head_sha, timestamp) AS collector_head_sha,
  argMax(properties.error_name, timestamp) AS error_name,
  argMax(properties.error_message, timestamp) AS error_message
FROM events
WHERE event = 'ci telemetry source sync finished'
  AND timestamp >= now() - INTERVAL 7 DAY
  AND toInt(properties.schema_version) = 2
GROUP BY telemetry_source
ORDER BY telemetry_source
```

Expect one fresh row each for `github-actions`, `github-reviews`, and `depot`.
Do not trust a provider's downstream tiles when its row is missing, failed, or
older than 30 minutes.

`telemetry_incomplete = true` means reporter shutdown did not finish and the
dataset may omit test details, or an expected runner artifact is wholly absent.
Inspect `normalized/manifest.json`, then the retained raw artifact and any
`TestTelemetryIncompleteError`, before drawing a performance conclusion.
`collection_error_count` on `ci test run finished` separately records completed
runner/global failures that could not be attributed to one test. Those errors
can fail a lane, but do not by themselves mean its telemetry evidence is
incomplete.

Explain one slow execution by joining its phases and attempts via
`test_execution_id`:

```sql
SELECT event, properties.phase_category, properties.phase_name,
  properties.attempt_index, properties.duration_ms,
  properties.schedule_delay_ms, properties.error_message
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND properties.test_execution_id = '<execution id>'
  AND event IN ('ci test finished', 'ci test attempt finished', 'ci test phase finished')
ORDER BY timestamp
```

Find import/bootstrap culprits rather than blaming test bodies:

```sql
SELECT properties.test_module, properties.imported_module,
  quantile(0.95)(toFloat(properties.self_duration_ms)) AS p95_self_ms,
  max(toFloat(properties.total_duration_ms)) AS worst_total_ms,
  count() AS samples
FROM events
WHERE event = 'ci test import finished'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY properties.test_module, properties.imported_module
ORDER BY p95_self_ms DESC
LIMIT 50
```

Separate infrastructure queueing from execution:

```sql
SELECT properties.automation_platform, properties.job_name,
  quantile(0.95)(toFloat(properties.queue_duration_ms)) AS p95_queue_ms,
  quantile(0.95)(toFloat(properties.duration_ms)) AS p95_run_ms,
  avg(toFloat(properties.average_cpu_utilization)) AS avg_cpu,
  avg(toFloat(properties.average_memory_utilization)) AS avg_memory
FROM events
WHERE event IN ('ci job finished', 'ci job attempt finished')
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY properties.automation_platform, properties.job_name
ORDER BY p95_queue_ms DESC
```

Current unresolved automated-review findings:

```sql
SELECT review_provider,
  count() AS pull_requests,
  sum(finding_count) AS findings,
  sum(unresolved_finding_count) AS unresolved
FROM (
  SELECT properties.review_provider AS review_provider,
    toInt(properties.pull_request_number) AS pull_request_number,
    properties.head_sha AS head_sha,
    argMax(toInt(properties.finding_count), timestamp) AS finding_count,
    argMax(toInt(properties.unresolved_finding_count), timestamp) AS unresolved_finding_count
  FROM events
  WHERE event = 'ci review state observed'
    AND timestamp >= now() - INTERVAL 30 DAY
    AND toInt(properties.schema_version) = 2
  GROUP BY review_provider, pull_request_number, head_sha
)
GROUP BY review_provider
ORDER BY unresolved DESC
```

Review state is a snapshot. Never sum every observation directly: the rolling
sync sees the same PR more than once. Select the latest snapshot with `argMax`
per provider/PR/head first, as above. Review completion events are immutable;
filter them to `review_provider IN ('cursor', 'iterate')` so historical rows
from an older broad check-name collector cannot pollute review-bot rates.

Every exploratory query must use a bounded timestamp or an exact SHA/run ID.
Inspect the event schema first: Depot workflow outcome uses `status`; GitHub
Actions uses `conclusion`.

## Analyse Through The PostHog MCP Server

The CLI is preferred when available. In an MCP-only client, follow the same
discovery sequence rather than inventing tool arguments:

1. Search for `schema events SQL HogQL`.
2. Inspect `read-data-schema`, then call it for the event being queried.
3. Inspect `execute-sql`, then pass one of the bounded HogQL queries above.
4. For a dashboard, discover and inspect `dashboard-insights-run`, then run
   dashboard `839068` or `839069` with `refresh = force_blocking`. Every tile
   must return no error; seeded health tiles must return status rows, while a
   pure aggregation may be empty in a legitimately quiet filtered window.
   Repeat with `force_cache` to verify the UI cache path.

Conceptual call payload after discovery:

```json
{
  "name": "execute-sql",
  "arguments": {
    "query": "SELECT properties.framework, properties.test_kind, properties.test_name, max(toFloat(properties.duration_ms)) AS worst_ms FROM events WHERE event = 'ci test finished' AND timestamp >= now() - INTERVAL 7 DAY AND toInt(properties.retry_count) = 0 GROUP BY properties.framework, properties.test_kind, properties.test_name ORDER BY worst_ms DESC LIMIT 25"
  }
}
```

Use the identical sequence for workflow, job, attempt, import, phase, and
review-state events. The dashboard links above are stable human hand-offs.

## How To Read A Slow Run

- High test `schedule_delay_ms` or module `queue_duration_ms`: runner-worker
  contention.
- High before/after-each duration or Playwright `hook`/`fixture` phase:
  fixture setup or cleanup.
- High environment/prepare/collect/setup/import duration: runner bootstrap or
  module graph; inspect `ci test import finished` next.
- Dominant named phase: product operation, external call, polling invariant,
  or intentional wait in that phase.
- High stdout/stderr bytes: logging or diagnostic volume may itself be slowing
  the test.
- Lane wall time much larger than its test/module intervals: install,
  subprocess startup, browser launch, collection, reporting, or orchestration.
- High Depot queue time with low utilization: infrastructure queueing, not
  slow test execution.
- Low CPU plus a long runtime/network phase: waiting on external state rather
  than compute saturation.

## Investigation Case Studies

These are dated examples of how telemetry changed a diagnosis, not live
performance baselines. Keep a case only while it explains an enduring test or
analysis technique; replace superseded snapshots instead of appending a run
log. Use the dashboards and exact-head queries above for current measurements.

The first 2026-07-21 PostHog sample (eight executions per test) changed the
original diagnosis. The longest no-retry test was Vitest e2e
`a 10MB script result spills to a workspace file the agent can page through`,
at about 125 seconds p95. The earlier Playwright half-open WebSocket test was
about 48 seconds after its first shrink.

The spill test was doing four expensive things in one assertion: waiting for
the asynchronously seeded project repository, transferring and serializing a
10 MB result across the agent DO and workspace DO into R2, waiting for the
agent processor to render the spill reference, then downloading and parsing
the full file. Ten megabytes was not a product boundary. The workspace spill
boundary is about 1.5 MB, while the agent context boundary is 30,000
characters. The test now uses 2 MB, which still crosses both boundaries with a
safe margin, and records these phases separately:

- create test project;
- create agent;
- wait for project repository seed;
- append oversized result and trigger spill processing;
- wait for spill context;
- read and verify the complete spilled result.

The next preview run will therefore distinguish lifecycle/processor waiting
from payload transfer and readback instead of attributing the entire duration
to an opaque Vitest body. Use the named-phase dashboard, then join one
`test_execution_id` with the phase query above before changing another timeout
or payload.

The investigation that started this work found the no-retry Playwright test
`feed resumes after the /api WebSocket goes half-open (no close frame)` taking
about 96 seconds. Its test code imposed a fixed 35-second sleep even though the
product invariant was two 10-second liveness-probe strikes. It also failed to
trigger the returning tab's real `visibilitychange` signal or wait directly on
transport eviction. The test now dispatches that signal, polls the muted socket
closure, and names greeting, eviction, redial/delivery, and composer-settlement
steps. A direct zero-retry preview run passed in 48.6 seconds (51.2 seconds with
runner startup). The named phases make future variance attributable instead of
speculative.

After those reductions, an exact-head query across the artifact-finalized unit
and preview lanes identified the Playwright `repo-edit-file` REPL catalogue
case as the next longest zero-retry execution at 67.8 seconds. Its emitted
native Playwright API phases explained only 17.9 seconds; hooks and fixtures
explained about 0.1 seconds. The remaining time crossed a plain
`helpers.createFixture` await and the catalogue operation itself, which native
Playwright instrumentation cannot label. That observation found a telemetry
gap, not a retrospective cause. `helpers.createFixture`, project REPL opening,
the catalogue run, and cleanup now emit stable `test.step` parents. A direct
zero-retry `preview_19` validation did not reproduce the outlier: it passed in
16.3 seconds, split into 7.3 seconds of fixture creation, 3.9 seconds of page
navigation/readiness, 5.0 seconds of catalogue execution, and no cleanup time.
Future recurrences will therefore distinguish project bootstrap, page
readiness, the example operation, and cleanup instead of leaving an opaque gap.

The completed PR #2237 preview artifact at historical branch head
`4556d58d12d6ed4d0f4864ade32270671a890950` (2026-07-22) then made the new
longest Playwright result unambiguous: `feed resumes after page freeze + socket
death` took 63.4 seconds, including two sequential, named `Wait for timeout`
phases of 25.0 seconds each. The first was an arbitrary frozen-page hold even
though the test explicitly kills the socket; a timer probe then proved its
experimental `Page.setWebLifecycleState` command did not actually suspend the
current headless CI browser. The second slept for a guessed probe window before
beginning the actual delivery assertion. The test now uses
`Emulation.setScriptExecutionDisabled`, verifies the two-second suspension with
an armed page-timer gap, appends its durable marker immediately after resume,
and polls marker delivery for the existing bounded 90-second recovery window.
A healthy run can finish as soon as recovery is observed, while the historical
permanent wedge still exhausts the same ceiling and fails with its runtime
evidence. This verification is required because the CDP lifecycle command is
experimental and only promises to _try_ the transition; see the official
[Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-setWebLifecycleState)
and [Emulation domain](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setScriptExecutionDisabled).

The longest Vitest result in that artifact was the concurrency proof at 60.7
seconds. Its phases account for the time: 11.9 seconds creating the project,
48.8 seconds executing the scripts, and an intentional 30-second remote hold
inside that execution phase. The remaining 18.8 seconds is actual orchestration
and completion overhead. This is why named phases matter: the dashboard can
separate a test's contractual wait from runner contention and product latency
without inferring a cause from one aggregate duration.

The PR #2241 deployment-shaped validation at historical branch head
`382a2e7d95c00215345d92cb8eeba321de8192c4` (2026-07-22) then completed the
shortened suspend test in 18.2 seconds with zero retries, down 71% from 63.4
seconds. Its largest phases were 10.2 seconds of project-fixture creation, 3.0
seconds waiting for real post-thaw delivery, and the one-second suspend
stimulus. The same run also showed why lane timing must stay separate from
individual test timing: Playwright took 140.8 seconds because an unrelated
project-creation test spent 60 seconds waiting for its composer and then passed
its retry. That test recorded 85.6 seconds total, including 66.7 seconds of
retry work, while the preview test orchestrator recorded 148.8 seconds for the
whole OS lane. With the fixed sleeps gone, the longest no-retry e2e on that code
head became the Vitest sandbox-deadline proof at 55.1 seconds. All 55.1 seconds
were test body time with no hook or retry work. That duration is contractual:
the test sets a 60-second absolute script deadline and proves that a requested
20-minute sandbox timeout is capped to it. The next result was the concurrency
proof at 53.9 seconds, including its explicit 30-second remote hold. Neither
should be reported as unexplained runner idle time.

The finalizer retained seven raw artifacts, normalized 5,732 events, matched
all six expected preview runner sources, and reported no missing, incomplete,
or foreign artifacts. The seventh artifact was the preview orchestrator's own
artifact, which declared the six expected runner sources. The full SHAs above
are historical PostHog `head_sha` values rather than promises that their branch
refs or retained raw artifacts live forever. Query them with the CLI examples
above while they remain in the configured PostHog retention window.

## Adding Or Changing A Reporter

1. Extend the canonical Zod schema only with runner-neutral fields; missing
   runner capabilities stay optional or are explicitly quality-labelled. For
   a breaking change, add a new discriminated raw version plus an explicit
   finalizer migration; never reinterpret retained version-1 artifacts.
2. Write raw artifacts only. Do not import PostHog delivery into a reporter.
3. Include every final test, failed attempt/error, partial phase, module, and
   run status. Never silently drop a failed or incomplete result.
4. Add a unit test that validates the artifact, its timestamps/quality labels,
   and absence of network calls.
5. Add/retain the reporter alongside the human console reporter.
6. If a dynamic orchestrator starts it, declare its exact
   `expectedArtifactSources` entry before process startup and pin the matching
   workspace in the command environment.
7. Keep the CI finalizer and artifact upload as strict `if: always()` steps.
8. Add a finalizer test proving the new raw field reaches the common PostHog
   event, then update this capability matrix and event table.

A green test with missing telemetry, an invalid artifact, duplicate artifact
ID, missing PostHog configuration, or failed delivery is an observability
failure and fails the finalizer. The subsequent artifact step still runs so
the failure remains diagnosable. Normalize runner placeholders before schema
validation: for example, Playwright uses negative durations for steps that were
still active at interruption, so the reporter records zero duration plus an
explicit `PlaywrightIncompleteStepError` instead of losing the whole artifact.
