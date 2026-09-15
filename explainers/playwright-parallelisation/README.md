# Playwright parallelisation experiment

Live branch page: https://iterate.iterate.app/explainers/playwright-parallelisation?sha=codex%2Fplaywright-full-parallel

PR: https://github.com/iterate/iterate/pull/2659

`../playwright-parallelisation.html` is a generated, self-contained page. It
works locally and through the Iterate project's existing branch-aware
explainer route. No deployment of the product is needed to publish this page.

## Experiment

Change only the fixed `previewPlaywrightWorkers` value for each measured
configuration: 16, 32, 64 and 92, then useful control/finalist repeats. Keep
application code, test catalogue, worker machine size, retries, readiness and
cleanup unchanged. Each push must wait for the previous preview's cleanup to
finish. The normal single-runner workflow runs `pnpm preview run` and then
erases the slot; it does not call the six-shard reusable workflow.

All worker experiments use the same named Depot image tag, but we cannot prove
the resolved image digest is identical. Log the exact commit, run, slot,
deployment reuse and observed setup costs. Compare the concurrent OS Vitest
suite as well as Playwright. Keep red runs in the record.

## Collect a completed one-runner run

Keep raw inputs outside the repo: they contain full logs and test artifacts.
The collector writes only selected timing, resource, test-name and outcome
fields. It does not copy raw errors, auth data or signed artifact URLs.

```sh
depot ci metrics --run RUN --org 0p91s0lz49 --output json > /tmp/worker-metrics.json
depot ci metrics ATTEMPT --org 0p91s0lz49 --output json > /tmp/worker-resources.json
depot ci logs ATTEMPT --org 0p91s0lz49 --timestamps > /tmp/worker.log
depot ci artifacts list RUN --org 0p91s0lz49 --output json
# Download preview-os-test-artifacts using its ID, then unzip outside the repo.
depot ci artifacts download ARTIFACT_ID --org 0p91s0lz49 --output-file /tmp/worker.zip
unzip /tmp/worker.zip -d /tmp/worker-artifacts

python3 explainers/playwright-parallelisation/collect.py \
  --metrics /tmp/worker-metrics.json \
  --resources /tmp/worker-resources.json \
  --logs /tmp/worker.log \
  --artifacts /tmp/worker-artifacts \
  --workers 32 --key workers-32 --label '32 workers'
```

Inspect the output, add the key to `order.json`, and add a short factual
`findings` note in the run JSON. Preserve failed runs rather than overwriting
them with retries. Check that `catalogueHash` matches the other worker runs.
Update `verdict.html` only as the evidence permits, then render:

```sh
python3 explainers/playwright-parallelisation/build.py
```

The renderer uses Python's standard library and the repo's existing formatter.
Do not hand-edit the generated page. The historical three traces were imported
from the original investigation; their measured, sanitized span records are
retained in `runs/`. The new collector was checked against the historical
unsharded run's known workflow, install, Playwright, Vitest and retry totals.

## Reading the evidence

- Parent spans include child spans. Overlapping times are not additive.
- Workflow, job and command boundaries come from Depot timestamps/logs.
- Test start/end and retry attempts come from reporter telemetry, not buffered
  stdout. Expand an attempt for a small allowlist of fixed fixture/setup phase
  names (at least 100 ms); dynamic URLs and raw errors are not published. Phase timestamps outside the
  reported attempt interval are noted rather than forced into a false parent
  span. A browser attempt occupies one worker until it ends, even while idle.
- Missing browser-install timestamps stay explicitly untimed.
- CPU/memory are whole-runner samples during the Playwright reporter interval,
  including concurrent Vitest and Expo. A sample mean is not a precise CPU-time
  integral; brief peaks can fall between samples.
- Quarantined tests deliberately throw when their underlying body passes.
  That expected wrapper outcome is distinguished from a real body failure.
- Historical runs use the same catalogue but differ in PR/slot and deployment
  reuse. They motivate the experiment; they are not a controlled comparison.
