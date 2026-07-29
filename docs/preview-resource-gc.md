# Preview resource garbage collection

How preview environments reclaim their Cloudflare resources, and the design
ideas behind it. For the day-to-day operator view (statuses, reclaim commands),
see [Dev environments](dev-environments.md); this doc is the "why".

## The principle: releasing a slot never waits on teardown

There are nineteen preview **slots**. Each environment is disposable:
acquisition destroys its Workers and Alchemy stack, then recreates both before
deployment. The one upstream exception is container class creation, handled by
a small first-deploy bootstrap before Wrangler takes over. A slot is leased to
one PR at a time through the [semaphore](../apps/semaphore); a PR's deploy and
e2e renew the lease, and closing the PR releases it.

The bug this design fixes: teardown used to be **on the critical path of
releasing the slot**. Cleanup erased the slot's data, and only then released
the lease. When the erase hit a Cloudflare rate limit (HTTP 429) it bailed
before releasing — and renewed the lease for another day. The slot looked
"leased" by a long-closed PR, the fleet filled up with these orphans, and open
PRs couldn't get a preview. (Observed 2026-07-15: 4 of 9 slots held by
closed/merged PRs.)

So the rule is: **the lease is the load-bearing outcome, not the teardown.**
The slot must free the instant a PR closes or its lease lapses; reclaiming the
resources is a separate, lazy, rate-limited job.

## Two speeds of teardown

Teardown splits by what it costs to leave running:

| Concern                                                                                                                 | Reaped by                                                                                          | When                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Orphaned **compute** — Durable Object scheduler alarms keep firing agent turns (real LLM spend) against erased projects | force-delete each environment Worker, which also deletes all of its DO namespaces and data         | cleanup / destroy-on-acquire / GC backstop             |
| Container applications and Artifact repos                                                                               | explicit Cloudflare API deletion and verification before their owning Worker/data stack disappears | cleanup / destroy-on-acquire / GC backstop             |
| **R2 storage** — itx.files + sandbox backups                                                                            | Alchemy destroy empties/deletes the buckets; lifecycle rules bound abandoned data before teardown  | cleanup / destroy-on-acquire; otherwise 3h after write |
| **D1 / KV**                                                                                                             | Alchemy destroys the whole databases/namespaces                                                    | cleanup / destroy-on-acquire                           |

The expensive, rate-limit-prone operations were the **per-item** R2 deletes.
Everything else is one or a few bounded calls. Moving R2 to lifecycle rules
keeps cleanup within the account-wide control-plane budget.

## Everything disposable expires 3 hours after last use

Preview data is synthetic and previews churn, so retention is a pure cost knob.
One TTL governs it: **3 hours**.

- **Lease TTL** (`defaultPreviewLeaseMs`, `scripts/preview/preview.ts`): a slot
  whose PR hasn't deployed/tested for 3h has an expired lease and is reclaimed.
  A deploy/e2e cycle is minutes, so an active PR never lapses mid-run; a PR that
  goes quiet stops costing us within ~3h instead of a full day.
- **R2 lifecycle** on the preview `-files` and `-sandboxes`
  (`backups/`) buckets: objects are deleted 3h after they're written. The
  Alchemy stack declares these rules for preview slots. Production keeps files
  forever and sandbox backups for 90 days.
- **Sandboxes**: containers already sleep after ~10 min idle
  (`onActivityExpired` snapshots then destroys the container). The 3h backup
  expiry finishes the job — a preview sandbox not used for 3h loses its backup,
  and a later restore degrades gracefully to an empty workspace, so it simply
  comes back fresh. (The DO still _writes_ backups with its 90-day ttl; on
  preview the R2 rule deletes them first. This divergence is deliberate and
  preview-only.)

## The two phases

### Phase 1 — every preview lease expires

There is no immortal preview lease. PR leases renew to 3h and lapse when the PR
stops renewing; manual `preview acquire` defaults to 3h; every leased slot
carries a `leasedUntil`. Lease expiry is the single signal the GC acts on.

### Phase 2 — the GC sweep reclaims expired leases

A scheduled Depot workflow (`.depot/workflows/cloudflare-preview-gc.yml`, hourly)
runs `pnpm preview gc`, which:

1. Lists every slot and selects those whose lease is **leased but past its
   expiry** (`selectExpiredLeasesForGc`). An expired lease means no live tenant,
   so the whole slot is fair game. (Available slots are cleaned by their next
   acquirer's destroy-on-acquire, not here.)
2. For each, takes it under a fresh lease with a **non-force** acquire. This is
   the entire race story: a non-force acquire succeeds _only if the slot is
   genuinely free_. If a new PR grabbed the slot between the snapshot and the
   take, the acquire returns null and the sweep skips it — that PR's own
   destroy-on-acquire will clean it. No verdict logic, no stealing.
3. Destroys the slot with `pnpm infra destroy`, then releases it. A failure
   releases the slot anyway — its next taker destroys first, so a
   half-destroyed slot is self-healing and must never be parked out of the pool.

It runs sequentially (naturally rate-limited) and is idempotent — safe to run
as often as we like. `pnpm preview gc --dry-run` reports the plan without
touching anything.

The fast path (PR-close cleanup) still does the prompt DO-compute kill, so the
GC is a **backstop** for what cleanup missed: a lease that expired because a PR
went quiet, or a slot whose cleanup itself failed. Worst-case orphaned LLM spend
is therefore one cron interval, and only in the failure case.

## Self-healing invariants

- **Destroy-on-acquire**: every acquire destroys the slot before handing it out
  (`eraseAcquiredSlotOrGiveItBack`), so any teardown that's skipped, deferred,
  or half-finished is harmless — the next tenant wipes first.
- **Non-force GC acquire**: the sweep can never take a live tenant's slot.
- **Fresh-stack handover**: no data object or physical identifier is adopted
  by the next tenant. Destroy/recreate is the recovery path.

## Where things live

| Thing                                       | File                                              |
| ------------------------------------------- | ------------------------------------------------- |
| D1/KV/R2 stack and lifecycle rules          | `infra/alchemy.run.ts`                            |
| Whole-environment destruction               | `scripts/cloudflare-infrastructure.ts`            |
| Lease TTL, `gc`, `selectExpiredLeasesForGc` | `scripts/preview/preview.ts`                      |
| The scheduled sweep                         | `.depot/workflows/cloudflare-preview-gc.yml`      |
| PR-close cleanup (the fast path)            | `.depot/workflows/cloudflare-preview-cleanup.yml` |
