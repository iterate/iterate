# Interactive CI traces

Preview runs get a **CI trace** commit status after the workflow finishes.
Its **Details** link opens the report for that tested commit. The report shows
jobs, setup/wait/test/finish phases, measured shell steps and individual Playwright attempts. Expand rows, search for a test,
click a bar, or zoom to a selected span. Download the same trace as OTLP JSON.

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
`scripts/ci/tracing/tracing.ts`. Keep explicit step IDs: these join timings to the authored commands. Reports show those
commands with the Doppler wrapper stripped; the friendly step name is in the
details. Commands come from the workflow YAML at the run's triggering SHA (the merge revision on PR runs),
never expanded runner logs. `wait_for_preview`, `consumers`,
`playwright` and `app_tests` also define the phase boundaries. The shell hook
preserves exit codes and ignores nested shells. It requires only the Node
already installed in the runner image, so it measures `pnpm install` too.

The last finish step dispatches `ci-trace.yml`. This independent collector waits
for the source workflow to settle, reads Depot's workflow/attempt timestamps
and lifecycle records, and publishes the report. A 15-minute scheduled pass
repairs missed callbacks from the latest 200 workflows within 24 hours,
including cancellations. Collector failures fail that workflow visibly.

Reports are Depot artifacts containing `trace.html` and `trace.json`, uploaded
with `actions/upload-artifact`. No generated files or per-run commits go into Git.
The public `iterate/config` worker serves `/depot/artifacts/<artifact-id>`:
it uses the existing `/secrets/depot-ci-token` secret and ZIP range reads to
serve the requested file. Named CI traces from `iterate/iterate`'s `ci-trace.yml`
workflow remain accepted; other reports opt in with a `public-` artifact name.
Each artifact redirects to its own app origin, separate from the project's
cookies/storage. CSP limits executable content to that artifact's paths.
See [browser reports](./depot-ci.md#browser-reports-from-artifacts) for root
index selection, attachments and Playwright reports.

The collector verifies that the public report is viewable before setting the
**CI trace** commit status. Its description stores the source execution time,
so reconciliation skips already-published executions and older runs cannot
replace newer links on the same commit. A scheduled repair dispatches the same
render/upload/link workflow for missing traces, or repairs a missing Playwright
report status independently when the trace already exists. Collectors are serialized.
A successful status means the report is available; preview checks carry the
test outcome. Publication failures fail the collector visibly. Permissions
are `contents: read` and `statuses: write`; PR bodies are never edited.

Trace artifacts contain only timings, status, source names and locations. No raw logs,
exception payloads, credentials or signed URLs are copied. Reports are public,
like this repository. Uploads request 30-day retention from Depot; links depend
on the artifact remaining available and return 404 after it expires or is deleted.
HTML and JSON responses can be cached for an hour. This is report hosting, not
permanent archival storage.

## Replay

The collector workflow accepts `source-workflow` (Depot's workflow ID, not its
run ID). Empty input runs reconciliation. Branch-only workflows can be tested
with a Depot dispatch before merge:

```sh
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow ci-trace.yml --ref <branch> --input source-workflow=<workflow-id>
```

Local rendering requires `DEPOT_CI_TELEMETRY_TOKEN`. CI obtains it from Doppler
`_shared/preview`. Publication runs after the upload action inside the collector
and also needs `GITHUB_TOKEN` with commit-status write access.

```sh
pnpm exec trpc-cli scripts/ci/tracing/cli.ts render <workflow-id> /tmp/ci-trace
```

## Timing limits

- Checkout and artifact actions currently remain within the enclosing job/phase;
  their individual start/end timestamps are not exposed by Depot's public API.
  Quiet shell commands have measured start/exit times, not stdout estimates.
- A missing completion marker produces a striped incomplete span bounded by the
  runner finish. It is not reported as an observed test duration or a pass.
- Depot job-finish timestamps have whole-second precision. A millisecond marker
  can fall just after that timestamp: preserve both recorded times and give the
  synthetic trailing Finish phase zero duration rather than a negative interval.
- Playwright durations include fixtures. Retries appear as separate attempts.
  Vitest test internals and deployed request spans are outside this report.
- This is valid OTLP/JSON assembled after completion, not live SDK export. It
  can feed a collector later without changing the browser report's data model.
