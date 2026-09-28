# Interactive CI traces

Preview OS and Main OS e2e each end in a CI trace job (`trace`) that reports only: once
`deploy`, `e2e` and `specs` have settled, whatever their outcome, `scripts/ci/tracing/cli.ts
current` reads the run from Depot and writes `trace.html` and `trace.json`, uploaded as the
`public-ci-trace-<workflow>-<execution>` artifact (kept about a week,
[test evidence](test-evidence.md)). `cli.ts publish` then posts two commit statuses
(`statuses: write`), each linking a report in the viewer below:

- **CI trace**: success with the time to green, failure with the time to red,
  or error when the run has no verdict (cancelled).
- **Playwright report**: success whenever the Browser specs job uploaded one.

A status means the report exists; the run's own checks carry the verdict. The trace job is never a
gate. A PR that changes no preview path gets no trace.

## The viewer

`apps/ci-reports` is a Worker at
`https://ci-reports.iterate-dev-preview.workers.dev` (dev/preview account,
deployed by `deploy-ci-reports.yml`). `/<artifact-id>/` opens a public Depot
artifact of `iterate/iterate`: `trace.html` for a CI trace, the root
`index.html` for a Playwright report, the only file of a one-file artifact, or a
generated listing. `/<artifact-id>/<file>` serves that ZIP entry; append
`?download` to download it instead. Only artifacts named `public-…` are served.

It reads the artifact through Depot's API with the organization token CI telemetry uses (the
Worker's `DEPOT_CI_TELEMETRY_TOKEN` secret, from Doppler `_shared/preview`), with range reads of the
ZIP directory and the requested entry only. Each response's CSP confines the page to its own
artifact's path.

## What the trace shows

The report shows the workflow, its jobs, each test job's Setup, Test and Finish
phases, the measured shell steps, and individual Playwright attempts and Vitest
tests. The Browser specs shards ([Depot CI](depot-ci.md#browser-specs-in-shards)) are one
**Browser specs** row, from the first shard's start to the last one's end and red when any shard
failed; it opens into **Browser specs 1/10** to **10/10**, in order, each one row until opened.
Expand rows, search for a test, click a bar, or zoom to a selected span.
Download the same trace as OTLP JSON.

The summary shows **Time to green** at the last traced job's finish (the later
of the two suites, usually E2E tests) when none failed or was cancelled, and **Time to red** from the first failed job attempt
in the run; recovered test or job attempts do not count. Missing failure timing uses a
labelled upper bound.

This is the Preview OS or Main OS e2e workflow's own time to green. How long a
PR push waits for every check, Lint and Test included, is measured hourly across
all pushes by the health job's PR time to green
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
runner logs. Each test job's suite step, `suite` in E2E tests and Browser specs
(one definition), opens its **Test** phase. Since the suites start beside the
deploy, that phase begins with **Set up the suite** and **Wait for Deploy
preview**, spans of their own (`runSuite` in `apps/os/scripts/preview.ts`), and
its first test comes after them. The shell hook preserves
exit codes and ignores nested shells. It is plain bash that starts no process,
so it measures `pnpm install` too and adds about a millisecond to a step.

Expand the `pnpm preview deploy` step to see where its time went. Each span
starts once what it needs is there. **Write the deploying status**,
**Install wrangler** (then **Upload the Previews secrets**) and **Ensure the
Artifacts namespace** run beside **Build OS** and the client apps' parallel
**Build <app>** spans. **Deploy OS preview** starts once Build OS and those have
finished, and holds its **Readiness gate**, apps/os's only smoke. Each
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
sessions on that preview, which a PR's preview deletes when the PR closes and
main's keeps.

## Replay

The script reads the Depot organization token from Doppler `_shared/preview`, as in CI. Use the
Depot workflow ID, not its run ID.

```sh
node scripts/ci/tracing/cli.ts render <workflow-id> /tmp/ci-trace
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
