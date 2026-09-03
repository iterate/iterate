---
status: ready
size: small
---

# Erase a preview slot before EVERY deploy and after every e2e run

## Status summary

Spec'd 2026-09-03 from the DO duration runaway follow-ups. Implemented on
this branch: erase before every deploy (proved on this PR's own slot), erase
after the e2e (`preview erase`, an `always()` workflow step), no
`--keep-artifacts`. Left: watching the first runs of the after-run step.
Assumptions tagged **[assumption]**.

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

New contract: **a preview slot is only populated while a run is in
progress.** Nothing survives a deploy that a fresh deploy wouldn't have
produced, and nothing a run created survives the run (the before-deploy
erase covers the runs a push SIGKILLed; the after-run erase covers the ones
that finished — 2026-09-03: one finished run of #2575 left 2,225 DO-hours
in a single hour on preview-15). Cross-push manual QA state is gone by
design; the PR body's login link mints a fresh test user and project on
demand.

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
- ~~Skip the Artifacts-repo delete pass on same-holder redeploys~~ _(built as
      `--keep-artifacts`, then removed: every repo is an orphan once the
      projects are erased, the flag only deferred ~90s of deletion to the next
      handover, and with the after-run erase the before-deploy pass finds
      almost nothing anyway)_
- [x] Erase after the e2e too: `preview erase` adopts the slot the semaphore
      says this PR holds, erases it and keeps the lease; the workflow runs it
      as an `always()` step right after `preview run`, `continue-on-error`
      (the next deploy erases anyway). Skips itself with `--ran-head-sha`
      when the PR head moved on, so it never races the newer push's deploy
      _(`eraseHeldSlotAfterRun` in preview.ts; three unit tests)_
- [x] Concurrency: the workflow group is per PR (`cloudflare-previews-<pr>`,
      cancel-in-progress) and the semaphore gives a slot to one holder, so
      per-PR serialises per-slot; the GC sweep only touches expired leases
      (`preview gc`, non-force acquire) — it cannot erase a live tenant.
- [x] `docs/dev-environments.md`: the contract, under the lease model.
- [x] Verify on this PR's own slot: DO-hours on the slot after push N+1
      never include push N's population _(runs 2–4 on preview-1 each logged
      one erase before deploy; the pre-erase StreamDurableObject namespace
      disappears from the account's namespace list after each erase)_
- [ ] Watch the first after-run erases in CI: the step must log
      `erased preview-N after the run` on a finished run and `erase skipped:
      … moved on` on a run cancelled by a push.

## Out of scope

- dev and prd — nothing erases there; that is the self-wake horizon's job.

## Cost

Two erases per run (before deploy, after e2e): tombstone deploy + D1/KV wipe
+ Artifacts repos (+ auth redeploy). About 20s each once the after-run erase
keeps the Artifacts backlog small; ~100s when it has one to work through.

## Implementation log

- 2026-09-03: first push landed on preview-1 as a handover (erase 106s), then
  the OS deploy hit Cloudflare's startup-limits validation coin flip. This
  push is the same-holder redeploy that proves the new path.
- 2026-09-03 (later): run 4 green. Then a finished run of another PR
  (#2575) burned 2,225 DO-hours in one hour on preview-15 until erased by
  hand — the after-run erase was added for exactly that, and
  `--keep-artifacts` dropped with it.
