# EXPERIMENT: unique Worker names behind a stable preview hostname

This tests whether a new Worker/DO identity for each run can avoid the rollout
failures reproduced in `../durable-object-rollout`. It does not change OS deployment,
Semaphore policy, or the 90-second CI wait. Passing samples are not a global rollout
guarantee. Failed first operations stay red. See [measured results](RESULTS.md).

Run from this worktree root:

```sh
RUN_WORKER_PER_RUN=1 WORKER_PER_RUN_ROUNDS=3 \
  doppler run --project _shared --config prd -- \
  pnpm exec vitest run --config experiments/preview-worker-per-run/vitest.config.ts
```

`_shared/prd` supplies authentication for the production lease service only.
After acquiring a free slot, the fixture reads that slot's OS Doppler config and
uses **only its preview Cloudflare credentials** for deploys and route changes.
It asserts the preview account ID. It never evicts another holder or modifies
Doppler values. Without the opt-in, all cases skip without acquiring resources.
Use `-t 'keep-old'` (or `direct`, `park-old`) to select one scenario.
Set `WORKER_PER_RUN_SETTLE_MS=15000` to compare a 15-second delay after exact-version
readiness with the default immediate writes. The chosen delay is saved in evidence.
Rounds are bounded to 1–10, settling to 0–90 seconds, and read polling to 90 seconds
(plus at most one 5-second request). Polling returns on the first match; it does not
wait 90 seconds unconditionally. This longer measurement window was added after the
first run exhausted its original 30-read/~15-second cap while still seeing old code.
`WORKER_PER_RUN_SETTLE_MS=90000` provides an aged-deployment control: after 30-second
runs also reset fresh objects, this checks whether waiting the existing CI gate's
length avoids the same failure. It still uses fresh DO names for every operation.
Operation assertions are soft so a failure does not discard later rounds; the test
still fails if any first operation fails. No work request is retried.

| Scenario   | What changes                                                                                                                         | What must happen                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `direct`   | New Worker and namespace each round, addressed through its own workers.dev hostname                                                  | After first exact Worker+DO readiness, all 12 fresh operations complete on that version.                                                   |
| `keep-old` | The leased slot's actual `os.iterate-preview-N.com/*` route switches between unique Workers; older Workers remain live until cleanup | After exact-version readiness, fresh writes must reach and complete on the new Worker/DO. A completed write on an old Worker is a failure. |
| `park-old` | Same route handoff, with old Worker retirement started concurrently with readiness/work                                              | Parking must not break new writes, send them to 503, or hide an interrupted operation.                                                     |

Each case leases its own slot and owns its resources through `await using`.
Each round uses a real changed build marker and new script name, such as
`os-preview-8-exp-<experiment-id>-after-1`. The embedded Worker repeatedly writes
progress to DO SQLite for 15 seconds; no write is retried. The one readiness DO
is distinct from the 12 measured DOs. Readiness and state reads retain every
attempt; the final state is read through the new Worker's own hostname, so a
stale route cannot conceal which namespace received the work.

The route is updated through Cloudflare's Workers Routes API. OS itself uses
Workers Routes, not the separate Custom Domains API. Existing DNS and the
original Worker are left in place. The route's original owner is recorded before
any mutation; its API state and public response are checked after restoration.
The fixture renews its lease using the lease ID before route/deploy mutations.

Cleanup restores the original route, retires the test DO classes, checks each
experimental Worker returns 503, then releases the lease. Workers are never
deleted. Failed cleanup retains the lease and writes recovery information; do
not release it until restoration succeeds. A hard-killed process cannot run
`asyncDispose`, so consult the checkpointed evidence before recovering its slot.

`evidence.ignoreme/<experiment-id>/evidence.json` contains the lease and original
route, deploy output, cutovers, readiness attempts, all operation responses and
final records, Cloudflare ray/colo information, cleanup verification and Worker
Logs queries. Probe tokens and Cloudflare credentials are not written there.
Generated JSON and logs are never committed. The logs query runs after cleanup;
no live `wrangler tail` is attached because it can update running DOs.

## Limits and OS integration questions

This is a real Cloudflare routing/storage experiment with a minimal workload,
not an OS agent-smoke run. OS's name currently also determines R2 buckets,
Artifacts namespace, typechecker and bundler sidecars, self identity, and container
applications. In addition, a brand-new OS Worker gets a **container-class bootstrap
upload before the real application upload**, so merely adding a suffix does not
produce the single live-deployment lifecycle tested by `direct`.

If the basic route handoff works, those differences need representative OS evidence
before proposing adoption. The sibling idea of lease tags and aged parked slots
remains a separate experiment; it does not follow automatically from these results.

References: [Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/),
[route update API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/),
[DO rollout and tail updates](https://developers.cloudflare.com/durable-objects/platform/known-issues/).
