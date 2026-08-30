---
status: in-progress
size: medium
branch: mobile-interwoven-status
---

# Mobile: stale status on cards when messages weave between rounds

## Status summary

Fleshed-out spec; repro first (worktreeify), then diagnose, then fix.

## What (observed, Misha's phone 2026-08-30)

A turn where a script sends a chat message mid-turn AND returns a value
splits into two activity cards with the reply bubble between them (that part
is known behavior: the reducer settles the live activity to flush the
deferred bubble, and the next round's request births a new activity). The
bug: **the second card wears the FIRST round's status** ("Inspecting PR
2548 and its public prompt configuration") even though its own script's
first line set a new one ("Found PR 2548; extracting its public voice
brief") — the previous status hangs around too long.

## Repro plan (deterministic, via the intercepted-model harness)

New spec `specs/mobile/interwoven-status.spec.ts`, same skeleton as
live-status.spec.ts (`createMobileFixture` + `createAgentHelper` +
`withTunnel` holds):

- Round 1 script: set status "Inspecting the refund API", `sendMessage`
  a mid-turn reply, fetch a held endpoint, RETURN a value (the weave:
  message + continued turn).
- Round 2 script: first line sets status "Extracting the voice brief",
  fetch a second held endpoint, then release and settle the turn.
- Assertions:
  - the reply bubble renders between two cards (current split behavior —
    assert it as-is unless the fix changes it);
  - while round 2 runs, the SECOND card's summary shows "Extracting the
    voice brief" (this is the expected failure — it's expected to show
    round 1's status);
  - after settle, the second card's header shows round 2's status.

## Hypotheses to check once the repro fails

- Round-2's code step inherits `state.summaryActivity` at birth (deliberate,
  for round headers) — is the round-2 `summary-updated` stamp being lost or
  ordered after something that overwrites it?
- `deriveAgentUiLiveStatus` gates statusText on
  `summaryActivityUpdatedAtMs >= live.startedAtMs` — after the split, the
  NEW activity's startedAtMs may be later than the round-2 status append
  in some orderings (statusText rejected as "previous turn"), leaving the
  fallback/settled label to surface the stale birth-inherited text.
- The 250ms display debounce (`useDebouncedValue`) caches per item id —
  the split means a NEW item id; check the cache isn't serving a stale
  entry, and that `keepPreviousData` isn't holding the old text across the
  card boundary.
- Whether the split itself is the right behavior is EXPLICITLY out of
  scope unless the status fix forces the question — one card per turn is a
  bigger product decision for Misha.

## Checklist

- [ ] Failing-then-fixed spec `specs/mobile/interwoven-status.spec.ts`
- [ ] Diagnose which fold/derivation serves the stale status
- [ ] Fix (reducer/mobile-lib/presentation as the diagnosis dictates —
      no new journal events)
- [ ] Reducer/feed unit coverage for the weave ordering
- [ ] Existing live-status + approvals specs stay green

## Assumptions (Misha on phone)

- "Status hangs around too long" = the second card showing round-1 text;
  fix means round-2's status shows as soon as its summary-updated folds
  (plus the standard 250ms display debounce).
- Keep the two-card split as-is.

## Implementation log

(append as you go)
