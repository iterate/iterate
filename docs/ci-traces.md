# Interactive CI traces

Preview runs get a **CI trace** commit status once their report is uploaded,
without waiting for cleanup.
Its **Details** link opens the report for that tested commit. The report shows
jobs, setup/wait/test/finish phases, measured shell steps and individual Playwright attempts and Vitest tests. Expand rows, search for a test,
click a bar, or zoom to a selected span. Download the same trace as OTLP JSON.

The summary shows **Time to green** for successful tests and **Time to red** for
failed tests or preparation. Green requires the acknowledged test-result check
update, after merged results and the expected test count have been validated.
Red uses the first failed producer job or failed result validation in the current
execution; recovered test or job attempts do not count. Missing failure timing
uses a labelled upper bound. Missing verdict evidence never invents green.

Planning appears first, followed by preparation, app tests and Playwright shards.
The entire `finish` job is excluded: there are no reporting or cleanup spans and
no separate wall-time statistic. Cleanup can still fail its GitHub check later;
this report preserves the earlier test result, not the final cleanup outcome.

Elapsed metrics start at the selected execution's creation, so they include time
waiting to start. A striped **Workflow queue** row appears before Plan, measured
from Depot execution `createdAt` to `startedAt`. Main previews serialize in the
`preview-main` concurrency group: a prior preview can account for this wait, but
Depot does not provide its reason, so the span keeps a generic label. Cancellation
before any recorded start ends the queue at the recorded cancellation time; it
does not invent a workflow start. Missing start metadata on a run that has runner
attempts does not create a queue span. Runner startup and checkout remain inside
their jobs, separate from workflow queuing.

Expand a **Wait** phase, then select its wait step (click/tap, or focus its bar
and press Enter) to show curved arrows from its prerequisites. Selection shows
only that span's own links, never links belonging to its children. The details list lets you reveal either
endpoint, even when collapsed, filtered out or outside the current zoom range. Yellow diagonal stripes indicate
waiting; grey stripes still mean incomplete evidence. A consumer whose runner
never started has no measured endpoint: its dependency is listed without a
timing arrow.

The status CLI records exact producer attempt IDs and successful milestone
publication. The collector exports standard OTLP `links` with a `ci.link.label`
attribute: preview waits require `preview-ready`. Missing milestone evidence links to the recorded
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

The `finish` job waits for every producer, downloads the results and runs
`ci-finish` to validate shard receipts and the expected test count. Only then
can `tests_passed` mark its check green. Trace collection and upload run next,
before cleanup, reusing the same runner and installed dependencies. Collection
also runs after failed tests, once all producers have settled; it has a five-minute
step limit. Cleanup uses `always()` so a report failure does not skip retirement.

The collector reads completed producer timings and lifecycle records. From
`finish` it uses only the green acknowledgement or failed test-result validation;
none of that job's spans appear. The workflow bar ends at the test verdict (or
last producer completion), not at cleanup/report completion. A report failure
can still fail the finalizer's GitHub check, without changing the recorded tests.

The same-runner verdict is passed through step outputs: `ci-trace-green` carries
the acknowledged check timestamp; `ci-trace-end` carries the measured shell exit.
The collector binds these records to its exact finish attempt. Depot's log API can
lag while that job is running, so waiting for it would add delay or lose the verdict.
Completed producer timings still come from Depot; manual replays use retained logs.

There is no separate collector job, dispatcher or scheduled repair. Cancellation
or a finalizer failure before its wait can prevent a report; those runs can be
rendered manually. Retrying only cleanup/reporting retains the execution that ran
the preview, including in the artifact name, so it cannot relabel old tests as new work.

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
job's artifacts. An early-green patch can emit the only completed webhook before
uploads exist. While the Depot job is still running, the publisher checks once a
minute for up to 30 minutes, covering the finalizer's 25-minute limit. It publishes
available reports immediately and keeps checking for later uploads, including the
Playwright report after cleanup. It publishes only an explicit allowlist:
`public-playwright-report` → **Playwright report** and
`public-ci-trace-<workflow>-<execution>` → **CI trace**. Retained `ci-trace-<workflow>-<execution>`
artifacts from the old `ci-trace.yml` workflow remain supported.
The handler verifies that the hosted HTML is reachable before adding the status.
CI does not run a publication command or need status-write permission.

Publication is serialized on the project's `/depot/artifacts` event stream.
The description stores the artifact's source execution time: retained artifacts
keep their original execution, and a late collector cannot overwrite a newer
preview's link. Duplicate deliveries do no work. External failures have three separate retries after
30, 60 and 120 seconds. Either budget's exhaustion appends a `depot/publication-failed`
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
  runner finish. An `always()` step can start after Depot records cancellation;
  an unfinished span then ends at its own start, with evidence that the enclosing
  finish precedes it. This means the end is unknown, not that the work was instant.
  Measured timestamps remain unchanged; invalid intervals still fail rendering.
- Depot job-finish timestamps have whole-second precision. A millisecond marker
  can fall just after that timestamp: preserve both recorded times and give the
  synthetic trailing Finish phase zero duration rather than a negative interval.
- Playwright durations include fixtures. Retries appear as separate attempts.
- Vitest emits test lifecycle markers through the existing retry telemetry reporter
  when `CI_TRACE_ENABLED=1`. Each span uses the runner's start time and duration,
  covering hooks and all retries together. Retried tests show their retry count;
  separate attempt timings are unavailable. Expected failures use Vitest's
  normalized outcome. Static skips have no span because they never ran. Missing
  completion markers remain incomplete, as with Playwright. Reporter callbacks
  are buffered by Vitest, so a hard kill can lose markers not yet delivered.
  Nested test operations and deployed request spans remain outside this report.
- This is valid OTLP/JSON assembled after completion, not live SDK export. It
  can feed a collector later without changing the browser report's data model.
