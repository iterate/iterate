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

- [ ] `scripts/preview/preview.ts`: the same-holder **re-issue** path (lease
      renewed, no handover) runs the same erase as the acquire path,
      through the existing `eraseAcquiredSlotOrGiveItBack` machinery (a
      failed erase gives the lease back rather than deploying dirty).
- [ ] After an erase the deploy plan must include `auth` (erase wipes the
      auth D1, so the OS client must be re-seeded) — same as the acquire
      path already forces **[assumption: verify how acquire forces it]**.
- [ ] Skip the Artifacts-repo delete pass on same-holder redeploys
      **[assumption]**: those repos are the PR's own, the pass is the slow,
      rate-limited part of erase-data, and the next real handover deletes
      them anyway. Needs an `erase-data` flag (e.g. `--keep-artifacts`).
- [ ] Concurrency: erase must never race a deploy to the same slot. The
      workflow group is per PR (`cloudflare-previews-<pr>`,
      cancel-in-progress) — one PR = one slot, so per-PR serialises per-slot
      **[assumption: confirm nothing else deploys to a leased slot]**.
- [ ] `docs/dev-environments.md` / preview docs: state the contract.
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
