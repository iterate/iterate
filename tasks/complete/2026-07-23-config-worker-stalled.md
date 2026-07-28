---
status: complete
size: small
---

# "Config worker stalled" — show why it parked, make the fix obviously clickable

## Status summary

Done, pending review (PR #2279). Prod remediated (subscription resumed by
hand, caught up instantly). Direction settled after discussion: keep the
park-fast behavior (no customers yet — optimise for going red fast and
visibly), and instead make the manual fix obvious: the sidebar warning now
looks like a clickable button, and the sheet shows the recorded park error.

## Incident

`os.iterate.com/projects/misha` showed the red "Config worker stalled" sidebar
warning. The root stream's `project-worker` subscription (the config worker
push feed) was parked at offset 70 with 792 events of lag.

Timeline (2026-07-22, UTC):

- 18:07:24 — delivery to the project worker starts failing with
  `Unable to deserialize cloned data due to invalid or unsupported version.`
  (workerd structured-clone version skew across the RPC boundary — transient
  Cloudflare fleet-rollout weather, not our payloads: offset 69 was a plain
  `stream/woken` fact)
- 18:07:28 — poison verdict on offset 69 after 3 attempts → skipped
- 18:07:31 — poison verdict on offset 70 after 3 attempts → skipped
- 18:07:34 — third consecutive poison verdict → `MAX_CONSECUTIVE_SKIPS` →
  **parked**. Ten seconds from first failure to giving up.
- 2026-07-23 — appended `subscription-resumed`; delivery caught up 70 → 866
  with zero failures. Receiver was fine; the outage lasted seconds.

## Direction

A first attempt made skip-mode ride out receiver-down windows in backoff for
hours before parking (like park mode does). Reverted after discussion: with no
customers yet, fast-and-visible red beats self-healing that hides problems for
hours. Instead:

- [x] Keep park-fast. _The ride-out change was committed then reverted in
      this branch; see the revert commit for the rationale trail._
- [x] Preserve the park evidence on the spine row: new
      `SubscriptionCursorStore.park` clears the retry schedule (parked rows
      must not drive the alarm) but keeps `attempt` + `last_error`, mirroring
      the `subscription-parked` fact. Runtime state then shows why a parked
      subscription parked. _`stream-storage.ts` (interface + SQL + method),
      `#park` in `stream-subscribers.ts`; fakes in three test files._
- [x] Show the recorded error in the warning sheet for parked rows (red text),
      with the old "recorded on the stream's parked event" line as fallback
      for rows parked before this shipped. Attempts row shown whenever > 0.
      _`project-worker-health.tsx` + logic doc comments._
- [x] Make the sidebar warning a clearly clickable button (border + fill +
      "Fix…" affordance) so the path to Resume is obvious. The sheet's
      Resume / Skip buttons already existed. _`project-worker-health.tsx`._
- [x] Tests: store `park` semantics (`stream-storage.test.ts`), spine keeps
      row evidence after park (tests d and h in
      `stream-subscribers.test.ts`).

## Out of scope (noted for later)

- Agent-driven resolution ("Investigate with agent" on a parked/poison row) —
  discussed and deliberately dropped for now.
- Auto-resume / ride-out of transient outages — reverted by choice; revisit
  when there are customers and silent stalls cost more than hidden ambers.
- Slowing poison confirmation so short outages don't skip healthy events.

## Implementation log

- 2026-07-23: prod `misha` remediated via `subscription-resumed` append
  (`doppler run --config prd -- pnpm cli itx run --context misha -e ...`).
  Caught up 70 → 866 immediately, zero failures, confirming transience.
- 2026-07-23: ride-out fix implemented, then reverted after discussion
  (optimise for loud-and-fast red for now). Replaced with park-evidence
  retention + UI affordance.
