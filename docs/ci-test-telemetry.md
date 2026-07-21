# CI And Test Telemetry

PostHog is the historical source for test performance, failures, retries, CI
queueing, Depot utilization, and automated review outcomes. It uses one test
data model: Vitest unit tests, Vitest e2e tests, Playwright specs, Node unit
tests, and standalone smoke tests are rows in the same event family.

## Dashboards

- [Test reliability & performance](https://eu.posthog.com/project/115112/dashboard/839068)
  ranks no-retry tests, failures/retries, module startup, and named phases.
- [CI reliability & performance](https://eu.posthog.com/project/115112/dashboard/839069)
  shows GitHub/Depot workflow and job reliability, queue/execution latency,
  Depot CPU/memory saturation, and review-bot outcomes.

The dashboards are the quick view. HogQL is the source for a branch, SHA,
workspace, lane, test, or unusual time window.

## One test model

All test events use `schema_version = 2` and these dimensions:

| Dimension           | Values / examples                                                                 |
| ------------------- | --------------------------------------------------------------------------------- |
| `framework`         | `vitest`, `playwright`, `node-test`, `script`; run/lane aggregates may be `mixed` |
| `test_kind`         | `unit`, `e2e` (and `integration` when a distinct lane is added)                   |
| `workspace` / `app` | package name for unit tests; deployed app for preview e2e                         |
| `lane`              | `unit`, `vitest`, `playwright`, `onboarding smoke`, etc.                          |
| source identity     | `repository`, `head_sha`, `branch`, `pull_request_number`                         |
| run identity        | `workflow_run_id`, `workflow_run_attempt`, `workflow_run_url`                     |
| execution           | `execution_context` is `ci` or explicitly enabled `local` validation              |

Do not add framework-specific event names. Add an optional property to the
shared event when a runner exposes additional evidence.

Production dashboards filter to `execution_context = 'ci'`; explicitly enabled
local telemetry is useful for validating reporters, but must not change CI
failure or latency baselines.

| Event                          | Grain                                   | Important properties                                                      |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------------- |
| `ci test run started/finished` | one test operation or workspace run     | status, wall duration, test/failure/retry counts                          |
| `ci test lane finished`        | one app/lane command                    | status, wall duration, exit code, collection errors                       |
| `ci test finished`             | one logical test's final result         | state, total/body/hooks/schedule duration, retry count, first error       |
| `ci test attempt finished`     | one attempt where the runner exposes it | attempt index, retry flag, state, duration, worker                        |
| `ci test phase finished`       | Playwright step or explicit named phase | phase name/category and duration                                          |
| `ci test module finished`      | one Vitest module                       | environment, prepare, collect, setup, import, queue, and execution timing |

Vitest currently exposes final total duration and retry count, but not each
attempt's duration. Playwright and Node's test runner expose attempts. Never
use a retried Vitest row in a no-retry duration ranking. Playwright nested
steps overlap their parents; do not sum parent and child phase rows.

Unit Vitest packages load
`packages/shared/src/test-support/e2e-policy/retry-telemetry-reporter.ts`.
The auth package uses `scripts/ci/node-test-telemetry-reporter.ts`. Preview e2e
collects complete Vitest JSON and Playwright JSON in `scripts/preview/preview.ts`
and sends it through `scripts/preview/e2e-posthog.ts`. The standalone onboarding
smoke writes the same structured test/module shape and records its internal
project creation, agent readiness, and greeting phases.

When `TEST_TELEMETRY_ENABLED=1`, a missing PostHog config or failed delivery
fails the test command. A green preview lane with a missing/empty report also
fails. Otherwise the historical dataset would silently omit precisely the
runs most likely to explain a regression.

## CI, Depot, GitHub Actions, and review bots

`scripts/ci/sync-ci-telemetry.ts` rereads a rolling window every 15 minutes.
Deterministic `$insert_id` values make backfills idempotent.

| Event                     | Source                                | Questions answered                                             |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `ci workflow finished`    | GitHub Actions API and Depot CLI/API  | workflow failure rate; queue, run, and total wall time         |
| `ci job finished`         | GitHub Actions API and Depot CLI/API  | slow/failing job and failed-step rate                          |
| `ci job attempt finished` | Depot metrics                         | retry attempts, queue/run time, CPU/memory average and peak    |
| `ci review finished`      | GitHub checks + review-thread GraphQL | review-bot duration, completion, findings, unresolved findings |

CI requires a dedicated read-only Depot organization token in the
`DEPOT_CI_TELEMETRY_TOKEN` Depot secret. The scheduled workflow intentionally
fails if it is missing. Create the token in Depot, then provision it without
putting the value in shell history:

```bash
read -rs DEPOT_TELEMETRY_VALUE
printf '%s' "$DEPOT_TELEMETRY_VALUE" | \
  depot ci secrets add DEPOT_CI_TELEMETRY_TOKEN --org 0p91s0lz49
unset DEPOT_TELEMETRY_VALUE
```

Local backfill uses `gh` auth and the developer's Depot CLI login:

```bash
GH_TOKEN="$(gh auth token)" \
  doppler run --project _shared --config prd -- \
  pnpm tsx scripts/ci/sync-ci-telemetry.ts --dry-run

# Remove --dry-run to send; repeated windows are safe.
```

## Analyse with `posthog-cli`

Follow the PostHog discovery contract before querying:

```bash
posthog-cli api --agent-help
posthog-cli api skill list
posthog-cli api search 'schema events SQL HogQL'
posthog-cli api info read-data-schema
posthog-cli api call read-data-schema '{"query":{"kind":"event_properties","event_name":"ci test finished"}}'
posthog-cli api info execute-sql
```

Find the longest test at a SHA without retries, across every framework and
kind (add a `test_kind` or `framework` predicate only when intentionally
narrowing the population):

```bash
posthog-cli api call execute-sql '{"query":"SELECT properties.framework AS framework, properties.test_kind AS kind, properties.test_name AS test, properties.test_module AS module, max(toFloat(properties.duration_ms)) AS worst_ms, avg(toFloat(properties.duration_ms)) AS mean_ms, count() AS samples FROM events WHERE event = '\''ci test finished'\'' AND toInt(properties.schema_version) = 2 AND toInt(properties.retry_count) = 0 AND properties.head_sha = '\''<full SHA>'\'' GROUP BY framework, kind, test, module ORDER BY worst_ms DESC LIMIT 25"}'
```

Failure and retry rates over a bounded window:

```sql
SELECT
  properties.framework AS framework,
  properties.test_kind AS kind,
  count() AS executions,
  countIf(properties.test_state = 'failed') AS failures,
  round(100 * failures / executions, 2) AS failure_rate,
  countIf(toInt(properties.retry_count) > 0) AS retried,
  round(100 * retried / executions, 2) AS retry_rate
FROM events
WHERE event = 'ci test finished'
  AND toInt(properties.schema_version) = 2
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY framework, kind
ORDER BY failure_rate DESC, retry_rate DESC
```

To explain a slow test, query `ci test phase finished` for its exact name,
then `ci test module finished` for its module. Interpret the remainder:

- high `schedule_delay_ms` or module `queue_duration_ms`: worker contention;
- high hook duration: fixture or cleanup;
- high environment/prepare/collect/import duration: runner/bootstrap/import;
- dominant named phase: the product operation or intentional wait in that phase;
- lane wall time much larger than test/module intervals: install, subprocess,
  reporting, or orchestration overhead;
- high Depot queue with low CPU/memory: infrastructure queueing, not slow tests;
- high execution with low CPU and a dominant phase: external/network waiting.

Every ad-hoc query must bound `timestamp` (normally 7 or 30 days) or select an
exact `head_sha` / workflow run. Inspect the schema before assuming a property
exists; Depot workflow outcome is `status`, while GitHub uses `conclusion`.

## Analyse through the PostHog MCP server

Use the MCP server's three-stage tool flow; do not guess tool arguments:

1. `search` for `schema events SQL HogQL`.
2. `info` for `read-data-schema`, then call it for `ci test finished`.
3. `info` for `execute-sql`, then call it with the HogQL above.

For example, the MCP `call` payload after discovery is conceptually:

```json
{
  "name": "execute-sql",
  "arguments": {
    "query": "SELECT properties.framework, properties.test_kind, properties.test_name, max(toFloat(properties.duration_ms)) AS worst_ms FROM events WHERE event = 'ci test finished' AND timestamp >= now() - INTERVAL 7 DAY AND toInt(properties.retry_count) = 0 GROUP BY properties.framework, properties.test_kind, properties.test_name ORDER BY worst_ms DESC LIMIT 25"
  }
}
```

Use the same process for `ci workflow finished`, `ci job finished`,
`ci job attempt finished`, and `ci review finished`. The dashboard URLs above
are also stable hand-off points for humans.

## Current branch finding (2026-07-21)

On head `1619bb28d`, the longest observed no-retry Playwright test was
`feed resumes after the /api WebSocket goes half-open (no close frame)` at
about 1.6 minutes. It paid a fixed 35-second sleep. The product requires two
10-second liveness-probe strikes, but the test neither triggered the returning
tab's real `visibilitychange` signal nor waited on the transport-eviction
invariant. The test now dispatches that signal, polls the muted socket closure,
and names greeting, eviction, redial/delivery, and composer-settlement steps.
That removes roughly 15 seconds of guaranteed idle time while preserving the
real two-strike behavior. A zero-retry direct run against preview-7 after the
change passed in 48.6 seconds (51.2 seconds including runner startup), versus
about 96 seconds for the observed branch run. The extra improvement beyond the
removed 15-second idle floor is run-to-run greeting/recovery variance; the
named phases now make that variance attributable instead of speculative.

The CI dashboard also separates test execution from infrastructure delay. In
the sampled data, Depot's `Test` job had roughly two minutes of p95 queue time
in addition to its execution, while its average memory utilization was low.
Do not attribute that queue time to the test suite.
