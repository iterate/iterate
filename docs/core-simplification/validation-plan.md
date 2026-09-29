# Core simplification validation plan

This is the release evidence plan for the core-simplification draft. It preserves the existing public SDK, stream processor, React hook, and Cap'n Web client contracts while allowing the implementation and persistence model to change.

## Baseline recorded 2026-09-29

- Main was `ce251e06c1c3c5894aebdc674e57b2196be0ae08`; production `/version` returned Worker version `d69bb53b-378d-4b04-a05d-f9dc683affd1`.
- The production smoke endpoints were reachable: `os.iterate.com/version` returned 200 and the root pages for `iterate.com`, `garple.com`, `lispwoso.com`, and `templestein.com` returned 200 when sampled.
- The production deployment at this version completed its Worker deploy and core smokes, but its post-deploy project-host check observed 500s from `garple.com` and `lispwoso.com` at that instant. They later answered 200 in the baseline sample. This is a pre-existing intermittent symptom that must be explicitly compared, not silently attributed to the simplification.
- The read-only Workers Logs alarm window from `2026-09-29T21:20:48Z` to `2026-09-29T21:25:28Z` found no visitor 5xx, no unclassified errors, no socket-close resets, and no RPC-stub pager failures. It observed one each of the known recovery events `facet.platform-failure-retry` and `workers.platform-failure-retire`.
- The alarm state has an existing, quiet incident: 11 `ReadableStream received over RPC disconnected prematurely` errors since 10:50 UTC, quiet since 20:20 UTC. A candidate may not claim a clean log baseline without resolving or explicitly excluding this historical incident.
- The current health run has unrelated infrastructure/test debt. It cannot be
  used as evidence that a core candidate regressed latency delivery. The
  established Workers Logs path is the telemetry source of record for this
  validation plan.

## Required candidate evidence

1. **Static and unit contracts**

   Run from the candidate checkout:

   ```sh
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

   Do not treat a deleted test as a pass unless its covered behavior is deliberately removed or is exercised by a more direct replacement. State the old behavior, replacement coverage, and deletion reason in the PR.

2. **Preview correctness**

   The draft PR's normal `Preview OS` run supplies a fresh deployment, the e2e suite, and the browser-spec shards. Run slow rows whenever the candidate changes residency, facet lifetimes, alarms, claims, or Durable Object wake/hibernate behavior:

   ```sh
   depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
     --workflow preview-os.yml --ref <candidate-branch> \
     --input pull-request-number=<draft-pr> --input action=deploy --input slow-rows=run
   ```

   Record the deployment name, tested SHA, job attempt IDs, and test artifacts. The preview must have no new unclassified errors relative to the same Worker Logs query described below.

3. **Latency and throughput**

   Dispatch the isolated guard so the whole perf suite runs alone on its own deployment. It measures append, wake, processor cold start, 300-rule resolution, Cap'n Web MCP calls, ephemeral flood latency/throughput, and fan-out against the budgets in `apps/os/perf/latency.ts`:

   ```sh
   depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
     --workflow os-latency.yml --ref <candidate-branch>
   ```

   Download `os-latency-report` and compare every median with both its fixed budget and main's recent calibrations. A platform failure is evidence to investigate, not a waived measurement; `perf/setup.ts` records underlying causes and socket losses in the JSON report.

4. **Soak and lifecycle coverage**

   Use a branch that no one will push to during the run and a unique preview name. The soak performs each e2e run without retries and then a serial perf run, producing row-level counts and raw reports:

   ```sh
   depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
     --workflow os-e2e-soak.yml --ref <candidate-soak-branch> \
     --input runs=100 --input preview=soak-core-simplification
   ```

   If the candidate touches context residency or hibernation, add `--input residency-timing=1`. Use a separate `fresh-previews=true` soak when the change affects birth, deployment, migration, loader, or cold-start behavior. Every non-pass in `apps/os/output/soak/summary.json` needs a root cause or a deliberate test deletion.

5. **Worker Logs comparison**

   Query the existing alarm without posting or preserving state when recording a production baseline. Supply its previous state artifact when available so the comparison window is bounded:

   ```sh
   node scripts/ci/prd-fault-alarm.ts previous-state --out /tmp/prd-fault-state.json
   node scripts/ci/prd-fault-alarm.ts run --dry-run --state /tmp/prd-fault-state.json
   ```

   This reads the first-party production Workers Logs API and reports visitor 5xxs, known platform-recovery signals, unclassified errors, close resets, and RPC-stub pager failures. After the PR preview is published and exercised, compare its workers to main on the same dev/preview account over that exact interval:

   ```sh
   node scripts/ci/core-simplification-preview-logs.ts run \
     --preview pr<draft-pr>-<sha7> \
     --from <exercise-start-utc> --to <exercise-end-utc>
   ```

   The result contains only aggregate categories and candidate-minus-main counts; inspect a non-zero delta in Workers Logs with the listed worker names and time range. This is read-only evidence. Do not declare preview logs clean merely because production is quiet.

   The release note must name every delta from the baseline above. Known recoveries may remain only if their counts are flat or explainable; any new error, visitor 5xx, reset, or escalating existing error blocks the draft until explained and fixed.

6. **Read-only production baseline comparison only**

   Production rollout is not authorized by this validation plan. Capture
   /version, availability samples and a dry-run log-alarm comparison before
   and after a preview only to establish a read-only baseline. Do not deploy,
   mutate production state, or use production as a replacement for a preview,
   latency run, or soak. A separately authorized rollout would require its own
   deployment and post-deploy evidence plan.

## Evidence handoff

For each draft PR, attach or link the following in its description: tested SHA; normal preview URL and check results; slow-row decision; latency artifact and each metric's result; soak artifact and its zero/non-zero flake counts; Workers Logs before/after summaries; and any baseline exception with its issue or owner. Depot artifact names are the durable source for reports; its job-attempt IDs make retries auditable.
