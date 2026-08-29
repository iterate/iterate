---
status: in-progress
size: small
branch: mobile-phase-debounce
---

# Mobile: debounce live-phase changes by 250ms

## Status summary

Implemented and green: hook + chat.tsx wiring, spec passes with the
debounce in place, lint/typecheck/knip clean. Awaiting review.

## What

The live activity card's phase glyph (#2543) still shows sub-100ms flashes:
the journal-derived certainty signals cover the KNOWN owed-turn gaps, but
fast event ripples (settle + follow-up landing near-simultaneously, chunk
boundaries) can still flip the derived phase for a frame or two. Misha's
ask: **debounce the displayed phase by 250ms** — when the derived phase
changes, queue the new value; if nothing else changes for 250ms, switch;
if it changes again first, restart the wait (trailing debounce). A flap
A→B→A within the window shows A throughout.

## How (decided)

- Presentation-layer only: the reducer stays a pure fold (no clocks). The
  debounce lives in a mobile hook.
- No useState/useEffect (house rule): `useQuery` keyed on the derived
  status's content — `queryFn` resolves the new value after 250ms,
  `placeholderData: keepPreviousData` shows the old value meanwhile, and
  `staleTime: Infinity` makes a return to a cached phase instant (flap
  suppression for free).
- Debounce the whole `AgentUiLiveStatus` (phase + statusText) as one unit —
  text flashes are as jarring as icon flashes.
- First value on card mount displays immediately (nothing to flash from).
- `liveStatus === null` (settled/absent) passes through undebounced — the
  card's live→settled switch is journal-final.

## Checklist

- [x] `useDebouncedLiveStatus(activityId, liveStatus)` hook in
      `apps/mobile/src/lib/` (tanstack-query debounce as above).
- [x] chat.tsx: pass the debounced status to the live ActivityCard.
- [x] Existing `specs/mobile/live-status.spec.ts` still green (its phase
      holds are all ≥4s, far above the debounce; the lag is absorbed by
      the waits).
- [x] Sanity-run against local dev. _(spec 27.4s, all phases assert through the lag)_

## Assumptions made (Misha was around but this is small)

- 250ms constant, not configurable.
- The WorkingCard (pre-first-event ⧗) is not debounced — it appears from
  nothing and hands over to a card whose first phase renders immediately;
  both edges are single transitions with nothing to flap against.
- No new unit-test infra for the hook: mobile has no component-test lane,
  and the observable contract is covered by the spec still passing plus
  the hook being ~20 lines of query wiring. If a mobile dom-test lane
  appears later, a flap-suppression test belongs there.

## Implementation log

(append as you go)
