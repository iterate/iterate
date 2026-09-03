---
status: ready
size: small
---

# Erase a preview slot before EVERY deploy, not just on handover

## Status summary

Spec'd 2026-09-03 from the DO duration runaway follow-ups. Implementation on
this branch. Assumptions tagged **[assumption]**.

## Why

Every preview deploy + e2e run leaves hundreds of abandoned projects whose
Durable Objects keep waking (heartbeats, stream alarm loops) — ~$15–25/hr per
slot until erased (`tasks/stream-do-wake-loop-runaway.md`, PR #2583's pin).
Today the slot is erased only on **handover** (a new holder acquiring it).
Within one PR, every push stacks a fresh population on the previous one, and
each deploy re-arms the old populations' backoffs. Worse: a push during a
running e2e SIGKILLs it (`cancel-in-progress`), so in-test `using`
finalizers never run for the cancelled attempt — teardown inside tests can
never be the guarantee. The next deploy has to be.

New contract: **a preview slot is fresh on every push.** Nothing survives a
deploy that a fresh deploy wouldn't have produced. Cross-push manual QA
state is gone by design (recreate the project after pushing).

## What changes

- [x] `scripts/preview/preview.ts`: the same-holder **re-issue** path (lease
      renewed, no handover) runs the same erase as the acquire path,
      through the existing `eraseAcquiredSlotOrGiveItBack` machinery (a
      failed erase gives the lease back rather than deploying dirty).
      _(both `claimEnvironmentConfigLease` and `assignEnvironmentConfigLease`
      dropped the recorded-slug short-circuit in `onAdopted`)_
- [x] After an erase the deploy plan includes `auth` (erase wipes the
      auth D1, so the OS client must be re-seeded) _(the acquire path never
      forced it — it relied on the diff; now every claim adds the erased data
      owners os + streams-example-app plus auth to `appsToDeploy`)_
- [x] Skip the Artifacts-repo delete pass on same-holder redeploys _(`erase-data
      --keep-artifacts`, passed when the adopted slot is the PR body's recorded
      one; handovers and GC reclaims still delete)_
- [x] Concurrency: the workflow group is per PR (`cloudflare-previews-<pr>`,
      cancel-in-progress) and the semaphore gives a slot to one holder, so
      per-PR serialises per-slot; the GC sweep only touches expired leases
      (`preview gc`, non-force acquire) — it cannot erase a live tenant.
- [x] `docs/dev-environments.md`: the contract, under the lease model.
- [ ] Verify on this PR's own slot: DO-hours on the slot after push N+1
      never include push N's population (namespace ids change each erase;
      the old namespace shows as deleted in analytics).

## Out of scope

- The leftovers of a PR's *last* push (GC reclaims ~3h after the lease
  lapses) — the self-wake horizon / teardown cover that.
- dev and prd — nothing erases there; that is the horizon's job.

## Cost

One erase per push: tombstone deploy + D1/KV wipe (+ auth redeploy). Roughly
a couple of minutes on the preview critical path; the Artifacts pass skip
keeps it from being more.

## Implementation log

- 2026-09-03: first push landed on preview-1 as a handover (erase 106s), then
  the OS deploy hit Cloudflare's startup-limits validation coin flip. This
  push is the same-holder redeploy that proves the new path.
