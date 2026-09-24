# Interactive CI traces

The Preview OS workflow's `trace` job (`.depot/workflows/preview-os.yml`)
collects a trace once its `deploy` and `e2e` jobs have settled, whatever their
outcome. `scripts/ci/tracing/cli.ts current` reads the run from Depot and writes
`trace.html` and `trace.json`; the job uploads them as the
`public-ci-trace-<workflow>-<execution>` artifact (kept 30 days), and
`cli.ts publish` posts the **CI trace** commit status (`statuses: write`) with
the time to green or red, linked to the job on Depot, where the artifact
downloads. Download it and open `trace.html`. The trace job itself and the
PR-close deletion are left out of the trace.

The report shows the workflow, its jobs, each job's Setup and Test phases, the
measured shell steps, and individual Playwright attempts and Vitest tests.
Expand rows, search for a test, click a bar, or zoom to a selected span.
Download the same trace as OTLP JSON.

The summary shows **Time to green** at the last traced job's finish when none
failed or was cancelled, and **Time to red** from the first failed job attempt
in the run; recovered test or job attempts do not count. Missing failure timing uses a
labelled upper bound.

Elapsed metrics start at the run's creation, so they include time waiting to
start. A striped **Workflow queue** row appears first, measured from Depot
execution `createdAt` to `startedAt`; Depot does not say why a run queued, so
the span keeps a generic label. Cancellation before any recorded start ends the
queue at the recorded cancellation time; it does not invent a workflow start.
Runner startup and checkout remain inside their jobs.

## Steps and phases

`BASH_ENV` (`scripts/ci/tracing/shell.sh`) writes each run step's start and
exit as `@@ci-trace` lines into the Depot logs, and `TraceReporter` in
`scripts/ci/tracing/tracing.ts` writes the test reporters' lifecycle records
the same way (`CI_TRACE_ENABLED=1`). Keep explicit step IDs: they join timings
to the authored commands. Reports show the step's name, falling back to its ID
and then its normalized run command; hover the label or bar to see all three.
Commands have the Doppler wrapper stripped and come from the workflow YAML at
the run's triggering SHA (the merge revision on PR runs), never from expanded
runner logs. The `e2e` step opens the **Test** phase. The shell hook preserves
exit codes and ignores nested shells. It requires only the Node already
installed in the runner image, so it measures `pnpm install` too.

Expand the `pnpm preview deploy` step to see the client apps' parallel
**Build <app>** spans beside **Build OS**, then **Deploy OS preview** (which
includes its `/version` smoke), then the parallel **Deploy <app>** spans, each
including its app's smoke. Overlapping spans must not be added together as wall
time.

`traceOperation()` records these nested operations at their actual start/end
points, preserving async parents across parallel work. Thrown errors and
explicit failed command results mark the operation failed; missing end records
remain visibly incomplete. Names and status are recorded, not exception text.

## Privacy

The collector keeps only `@@ci-trace` lines from the logs: trace artifacts
contain timings, status, source names and locations. No raw logs, exception
payloads, credentials or signed URLs are copied. Reports are public, like this
repository, and return 404 once the artifact expires or is deleted.

## Replay

Local rendering requires `DEPOT_CI_TELEMETRY_TOKEN`. CI obtains it from Doppler
`_shared/preview`. Use the Depot workflow ID, not its run ID.

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
