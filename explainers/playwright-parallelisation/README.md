# Playwright parallelisation experiment

Live branch page: https://iterate.iterate.app/explainers/playwright-parallelisation?sha=codex%2Fplaywright-full-parallel

PR: https://github.com/iterate/iterate/pull/2659

`../playwright-parallelisation.html` is a generated, self-contained page. It
works locally and through the Iterate project's existing branch-aware
explainer route. No deployment of the product is needed to publish this page. For a stable
review link, replace the branch in `?sha=` with the full report commit SHA;
branch-name requests can briefly serve a cached earlier revision.

## Experiment

The controlled series changes only the fixed `previewPlaywrightWorkers` value
in each recorded commit: 16, 32, 64 and 92, then control/finalist repeats.
A 24-worker follow-up checks a narrower compromise after all three measured
32-worker browser runs needed one retry and both 16-worker runs needed none.
The final configuration lives directly in `playwright.config.ts`; the unused
sharding code was removed after the controlled series. Keep
application code, test catalogue, worker machine size, retries, readiness and
cleanup unchanged. Each push must wait for the previous preview's cleanup to
finish. The normal single-runner workflow runs `pnpm preview run` and then
erases the slot. The sharded implementation remains reproducible at its
recorded commits (`2996ffc9c` and `ec079ad53`), rather than remaining unused in
the final CI code.

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

The final implementation differs from application baseline `611c3769b` only
in the root Playwright worker setting, two equivalent telemetry expressions
required by current lint rules, and documentation/evidence. The measured
application, package and spec trees are identical across the controlled trials.
Final validation after removing unused sharding code is recorded separately;
it does not replace any earlier failed measurement.

## Result

Keep 24 CI workers on one runner (local runs remain at one). Both measured
24-worker trials passed all 88 non-skipped browser bodies without retries in
120.5–123.0 seconds, before the concurrent OS Vitest suite. The report retains
all nine one-runner measurements and three historical traces, including the
failed 92-worker run. This small sample supports a performance tradeoff, not
a proven long-term failure rate. Later report-publication checks are linked
in the PR check history; the comparison data is a fixed measurement snapshot.
