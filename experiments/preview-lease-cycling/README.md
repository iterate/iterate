# EXPERIMENT: replace a preview, then retire its old slot

This is a manual experiment, not a production CI change. It uses real Semaphore
leases, the six existing app deployment scripts, and a single-attempt version of
CI's project/agent/reply smoke. The old preview stays published until the new
fleet and smoke succeed. Cleanup runs in a separate process and owns the old
lease throughout parking, 150 seconds of rest, deletion, another 150 seconds of
rest, verification and release.

The branch starts at main `97ffd6fd65` (#2712). Experiment deploys use that exact
product/package revision; a Git diff guard refuses changed product files. A new
experiment commit is not a new product revision. No PR means the existing
pkg.pr.new PR publish trigger does not run on these branch pushes.

```sh
# Unit lifecycle proof; no network or credentials.
pnpm --dir scripts exec vitest run --root ../experiments/preview-lease-cycling

# Real mutations: restrict candidates explicitly. Never evicts another holder.
RUN_LEASE_CYCLING=1 doppler run --project _shared --config prd -- \
  pnpm exec tsx experiments/preview-lease-cycling/experiment.ts \
  replace my-experiment preview-4,preview-6 90000

# Further replace calls select an available candidate, keeping the current one.
# Use 0 or 15000 for the experimental postdeploy gate; 90000 is the control.
```

`acquire <id> <comma-separated-slots>` reserves a candidate without deploying.
`cleanup <id> <slot>` prepares that owned slot for a future experiment, or resumes
failed retirement. `deploy <id> <slot> <wait-ms>` deploys an already held slot;
`smoke <id> <slot>` is an explicitly new measurement, never an automatic retry.
`status <id>` reads the local published preview/cleanup queue.
`finish <id>` removes the current pointer and starts its retirement.

The registry is local to `evidence.ignoreme/<id>/`, including lease tokens and
recovery checkpoints; do not commit it. A cleanup launch is independent of the
deploy process and its intent is saved before launch. It survives a normal
parent exit, but **this is not a distributed durable job runner**: machine death
requires the explicit recovery command. A stale `.mutation.lock` or
`registry.lock` must be inspected before removal. Never remove a lock while its
process is running. Expired/lost leases forbid recovery mutations.

Available slots are ordered by the service's `lastReleasedAt`. A prior cleanup
receipt is trusted only while the service's release timestamp still matches it, including after acquisition. Unknown slots get the normal entry erase. Known deleted slots skip
that erase, preserving their rest. Receipts are experiment-local; this does not
implement production slot tags or deploy a new Semaphore version.

Deletion is an explicit exception to this repo's normal never-delete policy,
authorized for this experiment. Only leased preview Workers are targeted. OS
container apps/classes are retired first; the six app Workers and OS compiler
sidecars are then deleted without `force`. DNS, D1 schemas, KV/R2 resources and
Artifacts storage are retained. The first erase currently uses the normal
preserve-Artifacts fast path; “deleted” certifies Worker/DO removal, not an empty
Cloudflare account. Full OS recreation must prove routes and container bindings
work again. Every failed first smoke remains in the logs and results.

## Interaction with #2712

- Docs-only inheritance should allocate nothing and leave the human preview alone.
- Tests-only reuse should retain the selected settled preview/lease, not rotate.
- Product deployment should allocate a candidate separately from the published slot.
- Test-project cleanup and restoration of the **new** preview are still needed:
  old-slot retirement does not stop test-created agents on the replacement.
- `preview-settled` must continue to refer to the exact restored versions; rotating
  publication cannot replace that provenance with a pre-cleanup version.
- Production needs a durable cleanup workflow, an atomic publication/retirement
  queue, deployment ordering, lease renewal/expiry recovery and pool capacity policy.

The manual experiment proves Cloudflare behavior and the local lifecycle. It does
not claim to exercise GitHub PR reporting, Depot cancellation, the complete browser
suite or settlement publication. The existing planner and settlement tests are
run unchanged to check the starting assumptions.

`watch <id> <slot> <duration-ms>` samples the current preview until publication
moves to a replacement (maximum 15 minutes). `inspect <id> <slot>` saves route,
namespace, container and sampled Worker Logs evidence without attaching a live
tail. Request/log samples do not establish worldwide propagation.

`replace-owned <id> <slot> <wait-ms>` resumes a candidate reserved by `acquire`.
`rest-deleted <id> <slot>` verifies an already absent fleet and observes another
150 seconds under ownership when a cleanup receipt is missing. It never treats
unknown age as old. Semaphore renewals update `lastAcquiredAt`; only the release
timestamp is used to invalidate receipts on an intervening acquisition/release.

`rest-parked <id> <slot>` is a comparison arm: ordinary DOs and identity data
are erased, the slot rests for 150 seconds under its lease, and the next deploy
skips entry erasure. Worker assets and container applications are retained. It is
labelled `kind: parked` in evidence, distinct from full deletion.

`sandbox <id> <slot>` additionally creates a project, boots a lite container,
executes a fixed command and destroys it. A failure before sandbox creation is
reported as project bootstrap failure, not container-recreation evidence.
