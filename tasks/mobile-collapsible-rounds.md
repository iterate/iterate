---
status: in-progress
size: small
branch: mobile-collapsible-rounds
base: os-agent-feed-round-meta (PR #2407 — stacked)
---

# Mobile: collapsible Round rows, like the os feed

> **Status summary**: spec written, implementation starting. Small change to
> mobile's activity card only; stacked on PR #2407.

Misha (2026-08-04, after reviewing #2407):

> i actually like the default-collapsed way it works on apps/os. can we make
> the "Round <N> ..." titles collapsibles on mobile too. Algorithm:
> If there's only one round, expanding "Ran code" shows the singular round as
> expanded
> If more than one round they're all collapsed by default, so I see the
> status updates

Mobile's activity card (apps/mobile/src/components/activity-card.tsx)
currently renders every round fully expanded once the card is open. The os
web feed (#2407) collapses each round to a "Round N · <summary status> ·
<duration>" header row; that's the shape to match.

## Checklist

- [ ] Extract a per-round component with its own expand state; header row is
      a Pressable with chevron + "Round N" + status suffix
- [ ] Single round: no header row, content expanded directly (unchanged
      behavior, mirrors os `AgentActivityRounds`)
- [ ] Multiple rounds: collapsed by default; a round whose code step is
      still running auto-expands (watch the live run — same rule as os
      `AgentActivityRoundRow`)
- [ ] Check specs/mobile/approvals.spec.ts — it taps the Approvals tab after
      expanding a card; if its fixture produces >1 rounds it must tap the
      round header first
- [ ] Cross-pointing comments stay accurate on both surfaces

## Assumptions

- Auto-expanding the running round mirrors os and keeps live code watchable;
  Misha's "all collapsed by default" is read as applying to settled rounds.
- Round expand state is component-local (resets when the card unmounts),
  same as os round rows.

## Implementation log

(notes appended during implementation)
