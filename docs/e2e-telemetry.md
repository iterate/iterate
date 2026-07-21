# E2e Timing Telemetry

Preview CI sends complete e2e timing to PostHog. Use it to answer both “which
test is slow?” and the more important “where did its time go?” without reading
runner logs one run at a time.

## Event contract

Schema version 2 is emitted by `scripts/preview/e2e-posthog.ts`. Every event has
`repository`, `pull_request_number`, `head_sha`, `workflow_run_id`,
`workflow_run_attempt`, `operation`, and `schema_version`. `$insert_id` makes a
workflow attempt idempotent.

| Event                               | Grain                                            | What it explains                                                            |
| ----------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| `preview e2e run started/finished`  | workflow test operation                          | total wall time and failed delivery                                         |
| `preview e2e phase finished`        | app test command                                 | runner/install/orchestration overhead versus reported tests                 |
| `preview e2e test finished`         | logical test                                     | final no-retry duration, body versus hooks, scheduling delay                |
| `preview e2e test attempt finished` | Playwright attempt                               | retry cost separated from the first attempt                                 |
| `preview e2e test phase finished`   | Playwright step or Vitest `e2e-phase` annotation | the operation inside a compound test that consumed time                     |
| `preview e2e module finished`       | Vitest file                                      | environment, preparation, collection/import, queue, and execution wall time |

Vitest's historical `E2E_RETRY_TELEMETRY_FILE` name is retained, but the file
now contains **all** tests and modules, not only retries. Playwright's JSON
report supplies all attempts and nested steps. A green test command with a
missing or invalid structured report fails the preview proof as incomplete;
otherwise PostHog rankings would be silently biased toward reporting lanes.
PostHog delivery errors also fail a green preview proof.

Vitest cannot currently expose the duration of each retry attempt separately;
its test event sets `attempt_timing_available = false`, while retaining total
duration and retry count. Playwright exposes attempt timing. Do not use a
retried Vitest sample to answer a no-retry question.

## Find the slowest test without retries

Run `posthog-cli api --agent-help` first, then use the CLI's SQL query tool with
this HogQL. Always filter `schema_version = 2`: schema 1 was emitted briefly by
an older implementation and has aggregate duration only.

```sql
SELECT
  properties.test_name AS test,
  properties.test_module AS module,
  properties.lane AS lane,
  max(toFloat(properties.duration_ms)) AS worst_ms,
  avg(toFloat(properties.duration_ms)) AS mean_ms,
  count() AS samples
FROM events
WHERE event = 'preview e2e test finished'
  AND toInt(properties.schema_version) = 2
  AND toInt(properties.retry_count) = 0
  AND properties.head_sha = '<full head SHA>'
GROUP BY test, module, lane
ORDER BY worst_ms DESC
LIMIT 25
```

Use the full head SHA for one branch revision. For a trend across revisions,
replace that predicate with `properties.pull_request_number = <PR>` and include
`properties.head_sha` in the output.

## Explain why a test is slow

First inspect its named phases:

```sql
SELECT
  properties.phase_name AS phase,
  properties.phase_category AS category,
  avg(toFloat(properties.duration_ms)) AS mean_ms,
  max(toFloat(properties.duration_ms)) AS worst_ms,
  count() AS samples
FROM events
WHERE event = 'preview e2e test phase finished'
  AND toInt(properties.schema_version) = 2
  AND properties.test_name = '<exact test name>'
  AND properties.head_sha = '<full head SHA>'
GROUP BY phase, category
ORDER BY mean_ms DESC
```

Then classify the remainder:

- High `schedule_delay_ms`: worker saturation or slow tests ahead of this one.
- High `before_each_duration_ms` / `after_each_duration_ms`: fixture or cleanup.
- High `body_duration_ms` with a dominant named phase: the tested operation or
  an intentional timeout/window.
- High module `queue_duration_ms`: file scheduling/worker contention.
- High module `environment_setup_duration_ms`, `prepare_duration_ms`,
  `collect_duration_ms`, or `import_duration_ms`: runner/bootstrap/import cost.
- App `duration_ms` much larger than the union of test/module wall intervals:
  browser installation, subprocess startup, report writing, or orchestration.
- Retried samples: query `preview e2e test attempt finished`; never add their
  cost to the “without retries” ranking.

For compound Vitest tests, annotate meaningful operations so they become phase
events:

```ts
const startedAt = performance.now();
await operation();
await annotate(
  JSON.stringify({
    name: "project-worker: execute",
    category: "runtime",
    durationMs: performance.now() - startedAt,
  }),
  "e2e-phase",
);
```

For Playwright, use `test.step("meaningful phase", async () => ...)`; nested
steps are read directly from the JSON report.

## Current branch finding (2026-07-21)

On head `1619bb28d`, the longest observed Playwright test with no retry was
`feed resumes after the /api WebSocket goes half-open (no close frame)` at
about 1.6 minutes. The old test paid a fixed 35-second sleep after muting the
socket. The product protocol needs two 10-second liveness-probe strikes, but
the test did not trigger the real resume signal or wait on the actual eviction
invariant. It now dispatches the representative `visibilitychange`, polls until
the muted transport is closed, and records greeting, eviction, redial/delivery,
and composer-settlement steps. This removes roughly 15 seconds of guaranteed
idle time while preserving the production two-strike behavior.
