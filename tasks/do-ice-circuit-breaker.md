---
status: in-progress
size: medium
---

# DO ice switch: freeze an environment's alarm loops without destroying data

## Status summary

Spec fleshed out autonomously on the evening of 2026-09-02 (Misha AFK) during
the DO duration runaway incident; assumptions marked **[assumption]** below.
Implementation in progress on this branch.

## Why

During the 2026-09-01→02 preview runaway (~$300/hr list-price), the only
containment lever was `erase-data` — destroy every DO in the slot. That is:

- unusable on prd (real data),
- a treadmill on previews: slots re-ignite within ~2h of any deploy + spec
  run, even on healthy post-#2567 code (verified live on slots 3, 14, 8, 11
  on 2026-09-02 evening — the wake loops need no external trigger).

We need a reversible "big red button": flip a switch → the environment's
self-perpetuating background work (alarm → wake → woken-append → deliver →
re-arm) drains quiet within roughly one alarm cycle → debug calmly → flip
back. Data intact. See `tasks/stream-do-wake-loop-runaway.md` for the loop
mechanics this freezes (but does not fix).

## Design

One flag per environment: **iced**.

- **Storage**: a single key in the project-directory KV namespace
  (**[assumption]** — it exists in every env, is already bound to os, and is
  wiped by erase-data which is the correct reset semantics). Value carries
  `{icedAt, reason}` for the audit trail.
- **Read path**: each DO incarnation reads the flag ONCE during boot
  (non-blocking; default un-iced on read failure — the switch must never
  become its own outage). Incarnations are short-lived precisely when the
  fleet is hot, so propagation is fast where it matters; a long-lived
  resident incarnation picks it up on its next alarm turn (the handler
  re-reads at most every REFRESH_MS). **[assumption]** ~30s refresh floor.
- **Enforcement points** (all fail-open, i.e. iced → do less, never throw):
  1. `StreamDurableObject.alarm()`: mark fired, skip facet alarm replays and
     reconcile, do NOT re-arm, return success — the platform alarm is
     consumed and the loop's edge dies.
  2. `StreamAlarmArmer`: arming becomes a no-op while iced (fetch/RPC turns
     can't re-plant the alarm).
  3. Processor keepalive + scheduler registry arming hooks: same no-op.
  4. Boot `stream/woken` append: skipped while iced (stop minting new
     delivery work; `created` birth events still append — creation is
     user-facing).
  5. Delivery retry arming (stream-event-sender): no-op while iced.
- **What still works while iced**: reads, appends from real callers, RPC,
  the UI. Only background self-perpetuation stops; deliveries lag by design
  and catch up after un-icing (the durable cursors make that safe — this is
  the same catch-up path as post-eviction recovery).
- **Un-icing**: delete the KV key. Streams resume lazily: the next real
  interaction (fetch/RPC/append) boots them, appends `woken`, re-establishes
  deliveries from cursors. No mass thundering-herd wake on un-ice
  (**[assumption]**: acceptable — active streams get traffic; idle wedged
  streams staying asleep is the desired outcome).
- **Operator surface**: `pnpm cli ice status|on|off --env <name> [--reason]`
  (doppler-backed script pattern), plus the duration-probe alert message
  (PR #2576) naming the command.

## Checklist

- [x] `do-ice.ts` module: flag read + per-incarnation cache _(src/domains/streams/do-ice.ts; 30s refresh floor, 500ms read cap, fail-open)_
- [x] Enforcement in StreamDurableObject alarm turn + StreamAlarmArmer _(armer takes an `isIced` hook — the single choke point every alarm write funnels through; alarm() consumes fires from the cached flag so the turn stays synchronous)_
- [x] ~~Enforcement in keepalive/scheduler arming hooks~~ _(unnecessary for streams: keepalive/facet desires all arm through the parent armer. SchedulerDurableObject arms via the shared registry and is deferred — it burned ~66 DO-hrs/3h vs the stream DO's 50k in the incident; noted as follow-up)_
- [x] Skip boot woken-append while iced _(both boot paths now refresh the flag under blockConcurrencyWhile before finishInitialization — the checkpoint-ready fast path previously initialized synchronously; cost is one capped KV point read per boot)_
- [x] Node-harness test: iced boot appends no woken/arms nothing, iced alarm consumed without facet replays, un-iced boot unchanged, flag-clear resumes next incarnation _(stream-do-ice.test.ts, real StreamDurableObject over the in-memory ctx fake)_
- [x] CLI: `pnpm cli ice` on/off/status _(scripts/ice.ts via the KV REST control plane; live round-trip drilled on preview_3)_
- [ ] Wire the runbook line into do-duration-probe alert text (PR #2576
      follow-up if that merges first)
- [ ] Follow-up: same gate for SchedulerDurableObject (shared registry —
      needs an OS-injectable hook, not KV logic in packages/iterate)
- [ ] Follow-up: a live drain drill on a deliberately-wedged preview slot
      (nothing was burning when this landed)

## Implementation log

- 2026-09-02 evening: worktree created, spec committed first per AFK
  protocol.
- Implementation + tests landed the same evening. Notable discovery: fresh
  streams boot through the checkpoint-ready SYNCHRONOUS path (empty log ⇒
  `kind: "ready"`), so the flag read had to gate both constructor lanes.
  alarm() reads the cached flag (not awaited) to keep the pacing test's
  synchronous-turn contract; residents converge one alarm cycle after a
  flip, fresh boots immediately.
