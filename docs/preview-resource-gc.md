# Preview resource garbage collection

How preview environments reclaim their Cloudflare resources, and the design
ideas behind it. For the day-to-day operator view (statuses, reclaim commands),
see [Dev environments](dev-environments.md); this doc is the "why".

## The principle: releasing a slot never waits on teardown

There are nine preview **slots**. Each is a fixed shell of Cloudflare
resources — a Worker, its hostname/DNS, a D1 database, KV namespaces, R2
buckets, an AI Search namespace — created once by `ensure-resources` and
**never deleted** (Workers especially: recreating a container-bearing Durable
Object class is broken upstream). Erase preserves container classes declared
by the incoming branch, but deletes any retired container application before
tombstoning a class left by another branch. A slot is leased to one PR at a
time through the [semaphore](../apps/semaphore); a PR's deploy and e2e renew
the lease, and closing the PR releases it.

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

## Why no generation token: the project ID already is one

You might expect we need to stamp each tenancy with an identifier so a new PR's
data can't collide with the old PR's. We don't — the **project ID already does
this**. Project IDs are `crypto.randomUUID()` (`apps/auth/src/server/id.ts`),
and they're baked into every per-tenant resource key:

- R2 objects are keyed `{projectId}/…` (`search-corpus.ts`).
- AI Search instances are one-per-project, IDed by the project ID and scoped to
  index only `{projectId}/**` (`search-index.ts`).

A new tenant always mints fresh random project IDs, so its data lands under
fresh keys and can never overlap a dead tenant's. **Correctness is free.** The
only reason to delete a dead tenant's data at all is **cost** — so deletion can
be lazy.

## Two speeds of teardown

Teardown splits by what it costs to leave running:

| Concern                                                                                                                 | Reaped by                                                                    | When                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Orphaned **compute** — Durable Object scheduler alarms keep firing agent turns (real LLM spend) against erased projects | one O(1) parked-worker deploy that tombstones every DO class (`do-reset.ts`) | **promptly**, on PR-close cleanup, and as a backstop in the GC sweep |
| **R2 storage** — search corpus + itx.files + sandbox backups                                                            | Cloudflare **lifecycle rules** (server-side, zero control-plane calls)       | continuously, 3h after last write                                    |
| **AI Search instances** — no server-side expiry exists (namespace delete requires an empty namespace)                   | per-instance DELETE sweep                                                    | in the GC sweep (and PR-close cleanup)                               |
| **D1 rows / KV keys**                                                                                                   | O(1) batched wipe                                                            | on cleanup / erase-on-acquire                                        |

The expensive, rate-limit-prone operations were the **per-item** ones: R2
deletes (a churned search-index held 1521 objects) and AI Search deletes (up to
~162 per e2e run). Everything else is one or a few bounded calls. All of it
shares one account-wide budget (~1200 requests / 5 min), so the per-item R2
storm was _starving_ the AI Search deletes. Moving R2 to lifecycle rules frees
the budget for the AI Search sweep.

## Everything disposable expires 3 hours after last use

Preview data is synthetic and previews churn, so retention is a pure cost knob.
One TTL governs it: **3 hours** (`PREVIEW_DISPOSABLE_TTL_SECONDS` in
`scripts/lib/deploy-helpers.ts`).

- **Lease TTL** (`defaultPreviewLeaseMs`, `scripts/preview/preview.ts`): a slot
  whose PR hasn't deployed/tested for 3h has an expired lease and is reclaimed.
  A deploy/e2e cycle is minutes, so an active PR never lapses mid-run; a PR that
  goes quiet stops costing us within ~3h instead of a full day.
- **R2 lifecycle** on the preview `-search-index`, `-files`, and `-sandboxes`
  (`backups/`) buckets: objects are deleted 3h after they're written.
  `ensure-resources` installs these rules for preview slots only, and
  `erase-data` re-installs all three on every acquire/cleanup so existing slots
  self-heal without a manual `ensure-resources` run (CI never runs that). Prd
  keeps its data (sandbox backups 90 days, corpus + files forever).
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
   acquirer's erase-on-acquire, not here.)
2. For each, takes it under a fresh lease with a **non-force** acquire. This is
   the entire race story: a non-force acquire succeeds _only if the slot is
   genuinely free_. If a new PR grabbed the slot between the snapshot and the
   take, the acquire returns null and the sweep skips it — that PR's own
   erase-on-acquire will clean it. No verdict logic, no stealing.
3. Erases the slot (the same `erase-data` teardown), then releases it. An erase
   failure releases the slot anyway — its next taker erases first, so a
   half-wiped slot is self-healing and must never be parked out of the pool.

It runs sequentially (naturally rate-limited) and is idempotent — safe to run
as often as we like. `pnpm preview gc --dry-run` reports the plan without
touching anything.

The fast path (PR-close cleanup) still does the prompt DO-compute kill, so the
GC is a **backstop** for what cleanup missed: a lease that expired because a PR
went quiet, or a slot whose cleanup itself failed. Worst-case orphaned LLM spend
is therefore one cron interval, and only in the failure case.

## Self-healing invariants

- **Erase-on-acquire**: every acquire erases the slot before handing it out
  (`eraseAcquiredSlotOrGiveItBack`), so any teardown that's skipped, deferred,
  or half-finished is harmless — the next tenant wipes first.
- **Non-force GC acquire**: the sweep can never take a live tenant's slot.
- **Lifecycle rules are the reaper**: the SDK/worker only _check_ ttls at
  read/restore time and never delete from R2 themselves, so the rules are what
  actually reclaims the storage.

## Where things live

| Thing                                          | File                                              |
| ---------------------------------------------- | ------------------------------------------------- |
| The 3h TTL + R2 lifecycle helpers              | `scripts/lib/deploy-helpers.ts`                   |
| Lifecycle rules installed per slot             | `apps/os/scripts/ensure-resources.ts`             |
| Preview R2 walk skipped in favour of lifecycle | `apps/os/scripts/erase-data.ts`                   |
| Lease TTL, `gc`, `selectExpiredLeasesForGc`    | `scripts/preview/preview.ts`                      |
| The scheduled sweep                            | `.depot/workflows/cloudflare-preview-gc.yml`      |
| PR-close cleanup (the fast path)               | `.depot/workflows/cloudflare-preview-cleanup.yml` |
