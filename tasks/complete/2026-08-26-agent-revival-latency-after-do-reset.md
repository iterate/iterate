---
status: done
size: small
---

# Agent revival latency after a Durable Object reset storm

## Status summary

Diagnosis complete (evidence below); fix + spec implemented: facet alarm
replay failures now fail the Stream DO's alarm invocation so Cloudflare's
platform alarm retry stays owed. Merged via PR #2520.

## Problem

During PR #2517's preview runs, `specs/create-project.spec.ts` flaked: the
onboarding agent of `create-project-mt8vagyc` (preview slot 9) took ~2m16s to
answer a user message that a healthy sibling answered in 17s. The stream shows
the llm-request opening at 16:17:02, the incarnation dying mid-attempt, and
`stream/processor-revived` only landing at ~16:19:07.

The keepalive is designed to revive within ~10s (`KEEPALIVE_ALARM_LEAD_MS`),
so ~2 minutes needed explaining.

## Diagnosis (from os-preview-9 workers observability logs, DO `86f78dbc…`)

- 16:17:07 — a deploy hit the slot (script version `7026a193…` → `5a38f11e…`).
  The reset storm broke the facets: "liveState watchers dropped", "stream
  processor runner background work failed … StreamUnavailable".
- 16:17:08–16:17:13 — the parent Stream DO's alarm fired 3 times. Each
  `handleAlarm` replay into the `agent` facet FAILED ("facet alarm replay
  failed; re-arming a bounded retry", failures 1→3), and the facet's own
  re-arm dial also failed ("stream processor registry alarm arming failed at
  Proxy.setAlarm"). Each fire CONSUMED the native alarm; the bounded-retry
  re-arm was lost with the resetting incarnation.
- 16:17:14 → 16:19:07 — total silence. The revival desire sat durably in the
  parent's `facetAlarmAtMs` KV slot, but no native alarm existed and nothing
  self-wakes a dead DO.
- 16:19:07.7 — an unrelated `getEvents` booted the DO; the constructor's
  level-triggered boot repair found the past-due desire and armed
  `setAlarm(now)` (the reviving alarm's scheduledTime is 16:19:07.677 — armed
  at boot, not a late fire). Replay succeeded, revival fact appended, visible
  reply ~9s later.

Root cause: facet alarm replays run as swallowed background work, so from the
platform's view every alarm fire "succeeds" and the alarm is consumed. The
self-armed bounded retry is the only continuation, and a reset storm can eat
that write. In prod, an idle stream might not get an external touch for hours
— this incident class is strictly worse there.

## Fix

- [x] `StreamDurableObject.alarm()` awaits the facet alarm replays and
      rethrows when any replay failed, so the platform's alarm retry (which
      survives DO resets) keeps the fire owed. The bounded self-armed retry
      stays as the fast path; the platform retry is the loss-proof backstop.
      _Implemented in `#fireDueFacetAlarms` (returns replay failures) +
      async `alarm()` in stream-durable-object.ts._
- [x] Spec: plain-node test driving the real `StreamDurableObject` with a
      scripted facet — failed replay ⇒ alarm invocation rejects AND the
      bounded retry desire is re-merged; successful replay ⇒ alarm resolves
      and the slot clears. _`stream-facet-alarm-replay.test.ts`._

## Non-goals

- The spec's 120s budget stays as-is (deliberately, per the task): the fix is
  faster revival, not a slower spec.
- PR #2510 (mid-stream LLM stall settlement) is related but distinct: that is
  stall settlement; this is revival latency after incarnation death.

## Implementation log

- Queried preview slot 9 via itx (`doppler run --project os --config
  preview_9 -- pnpm cli itx run …`): the incident project is deleted; healthy
  siblings show no revival facts.
- Queried Cloudflare workers observability
  (`/accounts/{id}/workers/observability/telemetry/query`, service
  `os-preview-9`) for the incident window; the timeline above comes from
  those logs.
- Considered and rejected: shrinking `KEEPALIVE_ALARM_LEAD_MS` (cadence was
  not the problem) and shrinking the keepalive's revival backoff table (the
  keepalive never got to run — its host alarm was lost a layer below).
