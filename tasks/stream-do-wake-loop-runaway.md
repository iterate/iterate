---
status: ready
size: large
---

# Stream DO wake loops must decay: the 2026-09-01 preview duration runaway

## Summary

From 2026-09-01 ~10:00 UTC to 2026-09-02 ~15:00 UTC the dev/preview Cloudflare
account burned ~500k+ Durable Object duration hours (~$300/hour at peak,
~$5k+ total) with **zero user traffic**. Contained on 2026-09-02 by running
`pnpm erase-data --env preview_N` on 12 slots (tombstones every DO). Detection
now exists (`.depot/workflows/do-duration-probe.yml` → Slack #error-pulse).
This task is the root-cause fix: the loops themselves.

## Observed mechanism (verified live via `wrangler tail os-preview-9`)

- ~16,000+ DO-equivalents continuously active on one preview slot; ~450k
  successful DO invocations/hour, around the clock, on an idle slot.
- Per-DO cycle every ~10s (`KEEPALIVE_ALARM_LEAD_MS`):
  `ALARM → wakeStreamProcessor/handleAlarm → getEventPage/appendCoreEvent →
  proxySetAlarm → ALARM`. Outcomes overwhelmingly "ok" — this is not one
  crash-looping object, it is a whole population of streams that wake
  "successfully" and never conclude.
- Objects stay resident *between* invocations (activeTime far exceeds
  invocation wall time; `maxWs=0`), i.e. cross-DO RPC sessions / in-flight
  background work pin them — same class as the June 2026 subscription-pin leak
  (`apps/os/tasks/do-duration-leak/DECISION_LOG.md`).

## Why the designed safeguards didn't hold

Each mechanism below is individually defensible; together they form a
non-decaying oscillator for any stream whose work can never settle (erased
spec-run projects, 403-damaged workers, parked 503 slots — previews mass-produce
all three):

1. **Every wake appends a `stream/woken` event**
   (`stream-durable-object.ts` `#finishInitialization`). The wake itself
   creates a new durable event, which is new delivery work, which can fail,
   which schedules a retry, which wakes the stream. The prod OOM incident
   stream accumulated 770+ `stream/woken` events in 3h.
2. **The keepalive crash-loop breaker resets too eagerly**
   (`packages/iterate/src/processors/stream-processor-keepalive.ts`): the
   revival backoff (10s→1m→5m→30m→6h) only holds if no quiet-clean
   confirmation intervenes. A cycle that *contains* a clean settlement (e.g.
   the revival pass resolves, delivery acks) resets the budget every round, so
   the 10s lead never decays.
3. **Every deploy resets every keepalive budget** (by design — version change
   = "the fix probably shipped"). On a preview account with dozens of deploys
   a day, wedged populations are perpetually re-budgeted.
4. **Nothing bounds the population.** Preview slots leased by long-lived open
   PRs are never erased (GC only reclaims *expired* leases), so every spec run
   deposits more never-settling streams into slots that keep them for days.

## Fix directions (each independently valuable)

- [ ] Keepalive: make the budget reset require quiet-clean *without an
      intervening revival* (or: N consecutive quiet-clean fires), so
      revive→clean→revive cycles still climb the backoff ladder.
- [ ] Delivery retry: permanently-failing subscribers (project worker 503/gone,
      config-repo 403) must reach a halted/parked state with a slow re-probe,
      not a warm retry loop. Check `stream-event-sender.ts` halt machinery for
      why it didn't engage here.
- [ ] `stream/woken`: don't append when the previous event is already an
      undelivered `woken` (or coalesce; or exempt woken-only appends from
      waking processors/subscribers). The event log growing on every wake is
      itself the fuel.
- [ ] Deploy-resets-budget: cap re-budgets per version-change per stream, or
      make the fresh budget start further up the ladder when the record shows
      prior plateau.
- [ ] Preview GC: periodically DO-reset slots that are *leased but idle* (no
      deploy/e2e in >3h) — leases protect the slot assignment, not the DO
      population. Alternatively: spec teardown erases the streams it created.
- [ ] Related in-flight work: PR #2572 (bound oversized settlements),
      PR #2573 (crash-loop quarantine for OOMing DOs), PR #2575 (repro). Those
      cover the OOM strain; this task covers the "successfully looping
      forever" strain.

## Evidence breadcrumbs

- CF GraphQL: `durableObjectsPeriodicGroups` per-namespace activeTime; top
  namespaces were `os-preview-{9,17,1,13,4,16,3,6,12,8}/StreamDurableObject`.
- `apps/os/scripts/do-duration-probe.ts` now trips on both signatures; run
  `doppler run --config dev -- pnpm tsx apps/os/scripts/do-duration-probe.ts`.
- prd has a chronic ~120 DO-hours/hour baseline worth its own look (the June
  leak was declared fixed; either it wasn't fully, or agents/schedulers
  legitimately hold this much — verify).
