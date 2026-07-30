# Preview resource garbage collection

How preview environments reclaim their Cloudflare resources, and the design
ideas behind it. For the day-to-day operator view (statuses, reclaim commands),
see [Dev environments](dev-environments.md); this doc is the "why".

## The principle: teardown failure never pins a lease

There are nineteen deployed preview **slots**. Seventeen are leased to PRs
through [Semaphore](../apps/semaphore); `preview-18` and `preview-19` are
reserved for destructive env-manager lifecycle proof and are deliberately
outside unattended GC. Each claimable environment is disposable: a tenant
handover or unknown-provenance acquisition destroys its Workers and Alchemy
stack, then recreates both before deployment. A same-PR renewal or retake stays
incremental. The one upstream exception is container class creation, handled
by a small first-deploy bootstrap before Wrangler takes over. A PR's deploy and
e2e renew the lease, and closing the PR releases it.

The bug this design fixes: cleanup used to release the lease only after every
resource deletion succeeded. When deletion hit a Cloudflare rate limit (HTTP
429), cleanup bailed before releasing and renewed the lease for another day.
The slot looked "leased" by a long-closed PR, the fleet filled with these
orphans, and open PRs could not get a preview. (Observed 2026-07-15: 4 of 9
slots held by closed/merged PRs.)

Cleanup still attempts the full destroy while it owns the lease, which prevents
a new tenant racing with deletion. The rule is that **destroy success is not a
precondition for release**. A separate durable `preview-stack` record exists
before provisioning begins and is deleted only after a final destroy succeeds.
Cleanup reports a failure and releases the environment lease, but the record
keeps the stack queued for hourly GC. The next acquire also destroys before
deploying.

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

## The two pieces of state

### Environment leases protect live tenants

There is no immortal preview lease. PR leases renew to 3h and lapse when the PR
stops renewing; manual `preview acquire` defaults to 3h; every leased slot
carries a `leasedUntil`. GC never force-acquires this lease.

### Stack records preserve cleanup obligations

`preview-stack/<slot>` exists for the whole lifetime of a possibly-present
Cloudflare stack. Preview tooling creates it before destroy/provision starts and
deletes it only after `pnpm infra destroy` succeeds. It therefore survives a
cancelled deploy, partial Alchemy apply, failed PR-close cleanup, and lease
release. It is not a second ownership system: the environment lease alone says
who may use the slot.

## The GC sweep

A scheduled Depot workflow (`.depot/workflows/cloudflare-preview-gc.yml`, hourly)
runs `pnpm preview gc`, which:

1. Lists durable stack records and environment leases. It selects recorded
   stacks whose lease is available or expired (`selectPreviewStacksForGc`).
2. For each, takes it under a fresh lease with a **non-force** acquire. This is
   the entire race story: a non-force acquire succeeds _only if the slot is
   genuinely free_. If a new PR grabbed the slot between the snapshot and the
   take, the sweep skips it. No verdict logic and no stealing.
3. Destroys the slot with `pnpm infra destroy`, deletes the stack record, then
   releases the environment lease. A failed destroy keeps the record and still
   releases the lease, so the next hourly sweep retries.

It runs sequentially (naturally rate-limited) and is idempotent — safe to run
as often as we like. `pnpm preview gc --dry-run` reports the plan without
touching anything. It attempts every eligible record, then exits non-zero if
any acquire, destroy, record deletion, or release failed; durable retry does
not turn a failed sweep green.

PR-close cleanup attempts the same whole-environment destroy, so the GC is a
**backstop** for a PR that went quiet, a cancelled deployment, or a cleanup
destroy that failed. The next automated attempt begins within one cron
interval; a persistent failure remains recorded and keeps each sweep red.

## Self-healing invariants

- **Destroy on tenant handover**: a new tenant or an
  unknown-provenance acquired slot is destroyed before deployment
  (`destroyAcquiredEnvironmentOrReleaseLease`). A same-PR continuous/re-taken
  recorded slot stays incremental; manual `preview acquire` only leases.
- **Durable cleanup obligation**: lease release cannot make a possibly-present
  stack invisible to GC.
- **Non-force GC acquire**: the sweep can never take a live tenant's slot.
- **Fresh-stack handover**: no data object or physical identifier is adopted
  by the next tenant. Destroy/recreate is the recovery path.

## Where things live

| Thing                              | File                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| D1/KV/R2 stack and lifecycle rules | `apps/env-manager/src/alchemy/environment-resources.ts` |
| Preview lifecycle and destruction  | `apps/env-manager/src/environment-durable-object.ts`    |
| Local CLI for the remote lifecycle | `apps/env-manager/scripts/cli.ts`                       |
| Lease TTL, stack records, and `gc` | `scripts/preview/preview.ts`                            |
| The scheduled sweep                | `.depot/workflows/cloudflare-preview-gc.yml`            |
| PR-close cleanup (the fast path)   | `.depot/workflows/cloudflare-preview-cleanup.yml`       |
