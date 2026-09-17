# Interactive CI traces

Preview runs get a **CI trace** commit status after cleanup and report upload.
Its **Details** link opens the report for that tested commit. The report shows
jobs, setup/wait/test/finish phases, measured shell steps and individual Playwright attempts. Expand rows, search for a test,
click a bar, or zoom to a selected span. Download the same trace as OTLP JSON.

The summary shows **Time to green** for successful runs and **Time to red** for
failed runs. Red uses the first failed job completion in the current execution;
recovered test or job attempts do not count. Without a failed job timestamp,
workflow completion supplies a labelled upper bound. An earlier green milestone
remains visible if cleanup later fails. Planning appears first in the waterfall,
followed by preparation, app tests, Playwright shards and cleanup.

Expand a **Wait** phase, then select its wait step (click/tap, or focus its bar
and press Enter) to show curved arrows from its prerequisites. Selection shows
only that span's own links, never links belonging to its children. The details list lets you reveal either
endpoint, even when collapsed, filtered out or outside the current zoom range. Yellow diagonal stripes indicate
waiting; grey stripes still mean incomplete evidence. A consumer whose runner
never started has no measured endpoint: its dependency is listed without a
timing arrow.

The status CLI records exact producer attempt IDs and successful milestone
publication. The collector exports standard OTLP `links` with a `ci.link.label`
attribute: preview waits require `preview-ready`; cleanup waits for consumer jobs
to settle, including failures. Missing milestone evidence links to the recorded
producer attempt with “not observed”, never to a later replacement attempt.
Links supplement the existing parent tree. They describe explicit prerequisites,
not an inferred critical path; old runs without these records have no links.

Expand the `pnpm preview ci-prepare` step to compare **Provision and deploy
preview** with **Shared readiness: rollout, agent smoke and TUI**. Deployment
contains slot acquisition/cleanup and each app's parallel build/deploy command
and HTTP readiness check. Build/deploy command timings include any smoke checks
owned by that app's deploy script; the subsequent shared readiness span includes
the remaining rollout wait and concurrent smoke/TUI work. Overlapping app spans
must not be added together as wall time.

`traceOperation()` records these nested operations at their actual start/end
points, preserving async parents across parallel work. Thrown errors and
explicit failed command results mark the operation failed; missing end records
remain visibly incomplete. Names and status are recorded, not exception text.

`preview-run.yml` emits small lifecycle records into Depot logs using
`scripts/ci/tracing/shell.sh` (`BASH_ENV`) and `TraceReporter` in
`scripts/ci/tracing/tracing.ts`. Keep explicit step IDs: these join timings to the authored commands. Reports show
the step's name, falling back to its ID and then its normalized run command.
Hover the label or bar to see all three. Commands have the Doppler wrapper stripped
and come from the workflow YAML at the run's triggering SHA (the merge revision on PR runs),
never expanded runner logs. `wait_for_preview`, `consumers`,
`playwright` and `app_tests` also define the phase boundaries. The shell hook
preserves exit codes and ignores nested shells. It requires only the Node
already installed in the runner image, so it measures `pnpm install` too.

The `trace` job in `preview-run.yml` runs after preparation, app tests, browser
shards and cleanup, with `if: always()`. It reads their completed Depot timings
and lifecycle records, then uploads the report. The trace excludes this report
job: **preview wall time** ends when the last producer job settles, while the
outer workflow remains active for collection/upload. Test/cleanup failures remain
visible; a collector failure fails its own check without changing the measured
preview outcome.

There is no dispatcher or scheduled repair. A workflow cancellation can prevent
the report job from completing; such runs can be rendered manually. The explicit
producer dependencies also handle cleanup failing before it waits for tests.
Rerunning only the collector retains the execution that ran the preview, including
in the artifact name, so collection retries cannot relabel old results as new work.

Reports are Depot artifacts containing `trace.html` and `trace.json`, uploaded
with `actions/upload-artifact`. No generated files or per-run commits go into Git.
The public `iterate/config` worker serves `https://depot-<artifact-id>--iterate.iterate.app/`:
it uses the existing `/secrets/depot-ci-token` secret and ZIP range reads to
serve the requested file. Named CI traces from `iterate/iterate`'s `ci-trace.yml`
workflow remain accepted; other reports opt in with a `public-` artifact name.
Each artifact owns its app origin, separate from the project's
cookies/storage. `/` opens the report and `/foo` serves ZIP entry `foo`. Older
`/depot/artifacts/<id>/...` links redirect here. CSP confines requests to that artifact.
See [browser reports](./depot-ci.md#browser-reports-from-artifacts) for root
index selection, attachments and Playwright reports.

The config project receives Depot `check_run.completed` webhooks and scans the
completed job's artifacts. It publishes only an explicit allowlist:
`public-playwright-report` → **Playwright report** and
`public-ci-trace-<workflow>-<execution>` → **CI trace**. Retained `ci-trace-<workflow>-<execution>`
artifacts from the old `ci-trace.yml` workflow remain supported.
The handler verifies that the hosted HTML is reachable before adding the status.
CI does not run a publication command or need status-write permission.

Publication is serialized on the project's `/depot/artifacts` event stream.
The description stores the artifact's source execution time: retained artifacts
keep their original execution, and a late collector cannot overwrite a newer
preview's link. Duplicate deliveries do no work. External failures retry after
30, 60 and 120 seconds; exhausted retries append a `depot/publication-failed`
event and log the cause without blocking GitHub webhook delivery. Replaying a
completed-job webhook safely retries publication.

A successful report status means HTML is available; the preview checks carry
the test outcome. PR bodies are never edited.

Trace artifacts contain only timings, status, source names and locations. No raw logs,
exception payloads, credentials or signed URLs are copied. Reports are public,
like this repository. Uploads request 30-day retention from Depot; links depend
on the artifact remaining available and return 404 after it expires or is deleted.
HTML and JSON responses can be cached for an hour. This is report hosting, not
permanent archival storage.

## Replay

Local rendering requires `DEPOT_CI_TELEMETRY_TOKEN`. CI obtains it from Doppler
`_shared/preview`. Use the Depot workflow ID, not its run ID. The config project
publishes uploaded report links using its existing GitHub integration.

```sh
pnpm exec trpc-cli scripts/ci/tracing/cli.ts render <workflow-id> /tmp/ci-trace
```

## Timing limits

- Checkout and artifact actions currently remain within the enclosing job/phase;
  their individual start/end timestamps are not exposed by Depot's public API.
  Quiet shell commands have measured start/exit times, not stdout estimates.
- A missing completion marker produces a striped incomplete span bounded by the
  runner finish. After cancellation, cleanup can start after Depot's recorded
  finish; an unfinished span then ends at its own start, with evidence that the
  enclosing finish precedes it. This zero duration means the end is unknown,
  not that the work completed instantly. Recorded Depot and lifecycle timestamps
  remain unchanged; invalid measured intervals still fail rendering. The chart's
  full range includes cleanup after cancellation; workflow wall time still uses
  Depot's recorded finish.
- Depot job-finish timestamps have whole-second precision. A millisecond marker
  can fall just after that timestamp: preserve both recorded times and give the
  synthetic trailing Finish phase zero duration rather than a negative interval.
- Playwright durations include fixtures. Retries appear as separate attempts.
  Vitest test internals and deployed request spans are outside this report.
- This is valid OTLP/JSON assembled after completion, not live SDK export. It
  can feed a collector later without changing the browser report's data model.
