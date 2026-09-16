# Interactive CI traces

Preview PRs get an **Open interactive CI trace** link in their body after the
workflow finishes. The report shows jobs, setup/wait/test/finish phases, measured
shell steps and individual Playwright attempts. Expand rows, search for a test,
click a bar, or zoom to a selected span. Download the same trace as OTLP JSON.

`preview-run.yml` emits small lifecycle records into Depot logs using
`scripts/ci/trace-shell.sh` (`BASH_ENV`) and `trace-reporter.ts`. Keep explicit
step IDs: these join timings to the authored commands. Reports show those
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

Reports live on `codex/ci-trace-artifacts`, separately from application source.
Each execution adds an HTML file and OTLP JSON under `explainers/`. URLs pin the
artifact commit SHA and use the existing `iterate.iterate.app/explainers/` host;
no app deploy or third-party artifact viewer is required. Repeated publication
reuses the report. The managed `ci-trace` PR-body block preserves surrounding
text, checks the current PR head and refuses an older execution's link.

Only timings, status, source names and locations are published. No raw logs,
exception payloads or credentials are copied. Reports are public, like this
repository. Generated reports are retained on the artifact branch; there is no
automated pruning yet.

## Replay

The collector workflow accepts `source-workflow` (Depot's workflow ID, not its
run ID). Empty input runs reconciliation. Branch-only workflows can be tested
with a Depot dispatch before merge:

```sh
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow ci-trace.yml --ref <branch> --input source-workflow=<workflow-id>
```

Local commands require `DEPOT_CI_TELEMETRY_TOKEN`; publishing also needs
`GITHUB_TOKEN` with repository contents and PR write access. CI obtains the
Depot token from Doppler `_shared/preview`.

```sh
pnpm exec trpc-cli scripts/ci/trace.ts render <workflow-id> /tmp/ci-trace
pnpm exec trpc-cli scripts/ci/trace.ts publish <workflow-id>
```

## Timing limits

- Checkout and artifact actions currently remain within the enclosing job/phase;
  their individual start/end timestamps are not exposed by Depot's public API.
  Quiet shell commands have measured start/exit times, not stdout estimates.
- A missing completion marker produces a striped incomplete span bounded by the
  runner finish. It is not reported as an observed test duration or a pass.
- Playwright durations include fixtures. Retries appear as separate attempts.
  Vitest test internals and deployed request spans are outside this report.
- This is valid OTLP/JSON assembled after completion, not live SDK export. It
  can feed a collector later without changing the browser report's data model.
