---
status: maybe
size: medium
---

# Stealable preview leases for draft PRs

> **Update 2026-08-10:** the v1 draft-skip policy (and the `preview` opt-in
> label, `--allow-draft`, `decideDraftPreviewPolicy`) was removed outright —
> every open PR now gets previews, draft or not. That deletes this task's
> premise and its "revert v1" checklist items. The stealing idea only becomes
> relevant again if slot contention returns; the draft/ready split would then
> need a different priority signal since drafts are no longer second-class.

Follow-up to `tasks/complete/2026-07-07-draft-prs-no-preview-lease.md` (PR
#1720), which is the blunt v1: draft PRs skip previews entirely unless they
opt in. The better shape (Misha's suggestion): drafts DO deploy and get e2e
signal when capacity is spare, but their lease is second-class — a ready PR
that finds no free slot may steal a draft's slot.

## Sketch

Slot selection for a ready PR, in priority order:

1. a free slot (least-recently-released first, as today — freed slots rest)
2. steal from the stalest draft-held lease (oldest `updatedAt`/renewal first)
3. queue, as today

## Design constraints (from the PR #1720 discussion)

- **Only steal draft-held AND idle leases** (no renewal in ~30min). Renewals
  happen at run start and runs take ~6–20min, so idle ≈ not mid-run. This
  preserves the invariant that two PRs never deploy onto the same slot
  concurrently — per-PR concurrency groups don't protect across PRs, and an
  automated steal during a victim's in-flight deploy means both write workers
  to the same slot. Under total contention with all-fresh drafts (bedtime),
  ready PRs still queue; accepted.
- **Steal must be atomic-ish in the semaphore** (check-idle → evict →
  acquire): two ready PRs can target the same victim at once. This is a
  semaphore-level feature (lease priority/stealability), not deploy-script
  logic.
- **Victim recovery mostly exists already**: deploy handles "my slot is
  gone / someone took it" by claiming a fresh slot and redeploying the whole
  fleet, and the PR-body banner machinery narrates slot moves. Add a banner
  variant naming the thief PR and why ("you're a draft; mark ready or add
  the `preview` label to hold a slot firmly").
- Once this lands, the v1 policy (skip previews for drafts) should be
  removed or reduced; the `preview` label could be repurposed as "don't
  steal my draft's lease". Update `docs/dev-environments.md`, README/CLAUDE
  "Before PRs" note, and the `decideDraftPreviewPolicy` unit tests.

## Checklist

- [ ] semaphore: leases carry a stealable/priority flag (or holder metadata enough to derive it) and an atomic steal operation
- [ ] acquire path: free slots → stalest idle draft-held lease → queue
- [ ] victim PR-body banner naming the thief and the opt-out
- [ ] revert/soften the v1 draft-skip policy in `preview deploy`
- [ ] docs + AGENTS/README note updated
