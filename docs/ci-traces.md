# Interactive CI traces

The Preview OS workflow (`.depot/workflows/preview-os.yml`) and Main OS e2e
(`.depot/workflows/main-os-e2e.yml`) each end in a CI trace job (`trace`),
reporting only. It runs once the jobs it `needs` have settled, whatever their
outcome: Preview OS's Deploy preview, E2E tests and Browser specs (`deploy`,
`e2e`, `specs`), main's `parent` and the same three (main's `alert` runs beside
it and waits for none of it). A PR that changes no preview path deploys nothing
and gets no trace. `scripts/ci/tracing/cli.ts current` reads
the run from Depot and writes `trace.html` and `trace.json` for exactly those
jobs; the job uploads them as the `public-ci-trace-<workflow>-<execution>`
artifact (it asks for 30 days; Depot keeps artifacts about a week, see
[test evidence](test-evidence.md)). Then `cli.ts publish` finds that artifact
and the Browser specs job's `public-playwright-report` in Depot and posts two commit statuses
(`statuses: write`), each linking the report in the viewer below:

- **CI trace**: success with the time to green, failure with the time to red,
  or error when the run has no verdict (cancelled).
- **Playwright report**: success whenever the Browser specs job uploaded one.

A status means the report exists; the run's own checks carry the verdict. The
trace job is never a gate: nothing waits for it but the PR's next Preview OS
run, which waits for the previous run to finish.

## The viewer

`apps/ci-reports` is a Worker at
`https://ci-reports.iterate-dev-preview.workers.dev` (dev/preview account,
deployed by `deploy-ci-reports.yml`). `/<artifact-id>/` opens a public Depot
artifact of `iterate/iterate`: `trace.html` for a CI trace, the root
`index.html` for a Playwright report, the only file of a one-file artifact, or a
generated listing. `/<artifact-id>/<file>` serves that ZIP entry; append
`?download` to download it instead. Only artifacts named `public-…` are served.

It reads the artifact through Depot's API with the organization token CI
telemetry uses (Doppler `_shared/preview`, shipped as the Worker's
`DEPOT_CI_TELEMETRY_TOKEN` secret), and fetches only the ZIP directory and the
requested entry with range reads, so opening one page of a large report does
not download its traces. Each response's CSP confines the page to its own
artifact's path. Misha built it for the `iterate/config` project, where each
artifact had its own `*.iterate.app` origin; it went with that project in #2837,
and came back here on one workers.dev origin, one path per artifact. Links expire
with the artifact, about a week after the run.

## What the trace shows

The report shows the workflow, its jobs, each test job's Setup, Test and Finish
phases, the measured shell steps, and individual Playwright attempts and Vitest
tests.
Expand rows, search for a test, click a bar, or zoom to a selected span.
Download the same trace as OTLP JSON.

The summary shows **Time to green** at the last traced job's finish (the later
of the two suites, usually E2E tests) when none failed or was cancelled, and **Time to red** from the first failed job attempt
in the run; recovered test or job attempts do not count. Missing failure timing uses a
labelled upper bound.

This is the Preview OS or Main OS e2e workflow's own time to green. How long a
PR push waits for every check, Lint and Test included, is measured hourly across
all pushes by the PR time to green guard
([Depot CI](depot-ci.md#pr-time-to-green)), from the same clock.

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
runner logs. Each test job's suite step, `e2e` in E2E tests and `specs` in
Browser specs, opens its **Test** phase. The shell hook preserves
exit codes and ignores nested shells. It requires only the Node already
installed in the runner image, so it measures `pnpm install` too.

Expand the `pnpm preview deploy` step to see where its time went. Each span
starts once what it needs is there. **Write the deploying status**,
**Install wrangler** (then **Upload the Previews secrets**) and **Ensure the
Artifacts namespace** run beside **Build OS** and the client apps' parallel
**Build <app>** spans. **Deploy OS preview** starts once Build OS and those have
finished, and holds its **Smoke /version** and its **Readiness gate**. Each
**Deploy <app>**, its app's smoke included, starts once its own build and the
wrangler install have finished, beside Deploy OS preview. After the gate,
**Seed sign-in** and **Write the PR section** run side by side. Overlapping
spans must not be added together as wall time.

`traceOperation()` records these nested operations at their actual start/end
points, preserving async parents across parallel work. Thrown errors and
explicit failed command results mark the operation failed; missing end records
remain visibly incomplete. Names and status are recorded, not exception text.

## Privacy

The collector keeps only `@@ci-trace` lines from the logs: trace artifacts
contain timings, status, source names and locations. No raw logs, exception
payloads, credentials or signed URLs are copied. Reports are public, like this
repository, and return 404 once the artifact expires or is deleted.

A Playwright report is public too, and a failed spec's trace in it records
that test's browser traffic against its preview: the throwaway test users'
sessions on that preview, which main deletes after the run and a PR's preview
deletes when the PR closes.

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
