# Preview resource garbage collection

How preview environments reclaim their Cloudflare resources, and the design
ideas behind it. For the day-to-day operator view (statuses, reclaim commands),
see [Dev environments](dev-environments.md); this doc is the "why".

## The principle: teardown failure never pins a lease

There are nineteen deployed preview **slots**. Seventeen are leased to PRs
through [Semaphore](../apps/semaphore); `preview-18` and `preview-19` are
reserved for destructive env-manager lifecycle proof and are deliberately
outside unattended GC. Each claimable environment is disposable: every tenant
handover or ownership gap destroys its Workers and Alchemy stack before
deployment. Only an uninterrupted exact-token lease renewal stays incremental.
The one upstream exception is container class creation, handled by a small
first-deploy bootstrap before Wrangler takes over. A PR's deploy and e2e renew
the lease, and closing the PR releases it.

The bug this design fixes: cleanup used to release the lease only after every
resource deletion succeeded. When deletion hit a Cloudflare rate limit (HTTP
429), cleanup bailed before releasing and renewed the lease for another day.
The slot looked "leased" by a long-closed PR, the fleet filled with these
orphans, and open PRs could not get a preview. (Observed 2026-07-15: 4 of 9
slots held by closed/merged PRs.)

Cleanup still attempts the full destroy while it owns and continuously renews
the exact lease, which prevents a new tenant racing with deletion. The rule is
that **destroy success is not a precondition for release**. Environment-manager
is the sole durable cleanup-obligation authority: any non-empty or failed
environment lifecycle remains visible after lease release. Hourly GC reads
that state directly. The next acquire also destroys before deploying.

## What full teardown removes

| Concern                                                                                                                    | Reaped by                                                                                                                         | When                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Orphaned **compute** — Durable Object scheduler alarms keep firing agent turns (real LLM spend) against destroyed projects | reconcile every owned DO class to a declarative `state: "deleted"` export, then force-delete and verify the Worker and namespaces | cleanup / destroy on handover / GC backstop            |
| Container applications and Artifact repos                                                                                  | explicit Cloudflare API deletion and verification before their owning Worker/data stack disappears                                | cleanup / destroy-on-acquire / GC backstop             |
| **R2 storage** — itx.files + sandbox backups                                                                               | Alchemy destroy empties/deletes the buckets; lifecycle rules bound abandoned data before teardown                                 | cleanup / destroy-on-acquire; otherwise 3h after write |
| **D1 / KV**                                                                                                                | Alchemy destroys the whole databases/namespaces                                                                                   | cleanup / destroy-on-acquire                           |

The old machinery issued per-item R2 deletes. Alchemy deletes in batches, and
the lifecycle rules bound how many abandoned objects can accumulate before a
later destroy.

## Live tenancy expires 3 hours after last use

Preview data is synthetic and previews churn, so retention is a pure cost knob.

- **Lease TTL** (`defaultPreviewLeaseMs`, `scripts/preview/preview.ts`): a slot
  whose PR has not deployed/tested for 3h has no live tenant. A deploy/e2e
  cycle is minutes, so an active PR does not lapse mid-run.
- **R2 lifecycle** on the preview files and sandboxes buckets: objects are
  deleted 3h after they're written. The Alchemy stack declares these rules for
  preview slots; only sandbox objects are limited to the `backups/` prefix.
  Production keeps files forever and sandbox backups for 90 days.
- **Sandboxes**: containers already sleep after ~10 min idle
  (`onActivityExpired` snapshots then destroys the container). The 3h backup
  expiry finishes the job — a preview sandbox not used for 3h loses its backup,
  and a later restore degrades gracefully to an empty workspace, so it simply
  comes back fresh. (The DO still _writes_ backups with its 90-day ttl; on
  preview the R2 rule deletes them first. This divergence is deliberate and
  preview-only.)

## Two authorities, no duplicated cleanup record

### Environment leases protect live tenants

There is no immortal preview lease. PR leases renew to 3h and lapse when the PR
stops renewing; manual `preview acquire` defaults to 3h; every leased slot
carries a `leasedUntil`. Every destructive operation renews its exact fencing
token before work, throughout work, and once more before completion. Renewal
loss cancels the exact environment-manager operation. GC never force-acquires
this lease.

The PR body carries an opaque lease ID only so a later command can ask
Semaphore to renew the same lease. It is not ownership state: missing or
rejected tokens are ownership gaps, and the slot must be reacquired and
destroyed before reuse.

### Environment-manager preserves cleanup obligations

Each environment Durable Object stores operation/progress/error state. Alchemy's
SQLite output is the canonical durable resource manifest; the manager derives
the live resource projection from that output. A local Wrangler JSON file is
only an ephemeral materialization and is invalidated before destroy begins.
There is no Semaphore `preview-stack` resource and no second durable resource
manifest.

## The GC sweep

A scheduled Depot workflow (`.depot/workflows/cloudflare-preview-gc.yml`, hourly)
runs `pnpm preview gc`, which:

1. Reads environment-manager status for every claimable inventory slot and
   lists environment leases. It selects every non-empty manager lifecycle whose
   lease is available or expired (`selectPreviewEnvironmentsForGc`).
2. For each, takes it under a fresh lease with a **non-force** acquire. This is
   the entire race story: a non-force acquire succeeds _only if the slot is
   genuinely free_. If a new PR grabbed the slot between the snapshot and the
   take, the sweep skips it. It then re-reads manager status under the lease.
3. Continuously renews the exact token while the environment-manager Durable
   Object destroys the environment. Renewal loss cancels that exact remote
   operation, and ownership is verified again before completion is accepted.
   A failed destroy leaves manager state non-empty/failed and still releases
   the lease, so the next hourly sweep retries.

It runs sequentially (naturally rate-limited) and is idempotent — safe to run
as often as we like. `pnpm preview gc --dry-run` reports the plan without
touching anything. It attempts every eligible record, then exits non-zero if
any status read, acquire, destroy, renewal, or release failed; durable retry
does not turn a failed sweep green. `release=false` is ownership loss, not
success.

PR-close cleanup attempts the same whole-environment destroy, so the GC is a
**backstop** for a PR that went quiet, a cancelled deployment, or a cleanup
destroy that failed. The next automated attempt begins within one cron
interval; a persistent failure remains visible in manager state and keeps each
sweep red.

## Self-healing invariants

- **Destroy on tenant handover or ownership gap**: a new tenant or re-acquired
  recorded slot is destroyed before deployment
  (`destroyAcquiredEnvironmentOrReleaseLease`). Only an exact uninterrupted
  renewal stays incremental; manual `preview acquire` only leases.
- **One durable cleanup obligation**: lease release cannot make a non-empty
  environment invisible because GC reads environment-manager directly.
- **Non-force GC acquire**: the sweep can never take a live tenant's slot.
- **Continuous fencing**: destructive work aborts on exact renewal loss and
  completion is rejected without a final renewal.
- **Fresh-stack handover**: no data object or physical identifier is adopted
  by the next tenant. Destroy/recreate is the recovery path.

## Where things live

| Thing                              | File                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| D1/KV/R2 stack and lifecycle rules | `apps/env-manager/src/alchemy/environment-resources.ts` |
| Preview lifecycle and destruction  | `apps/env-manager/src/environment-durable-object.ts`    |
| Local CLI for the remote lifecycle | `apps/env-manager/scripts/cli.ts`                       |
| Lease fencing and `gc`             | `scripts/preview/preview.ts`                            |
| The scheduled sweep                | `.depot/workflows/cloudflare-preview-gc.yml`            |
| PR-close cleanup (the fast path)   | `.depot/workflows/cloudflare-preview-cleanup.yml`       |
