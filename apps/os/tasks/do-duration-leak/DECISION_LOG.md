---
title: DO billable-duration leak from cross-script stream subscriptions
status: in-progress
branch: fix/do-subscription-duration-leak
opened: 2026-06-14
owner: jonas + claude
---

# Durable Objects billable-duration leak — decision log

Living document. Append-only narrative + a "rejected alternatives" section we can
revisit. Newest dated entries at the bottom of each section.

## Problem statement

After PR #1500 ("Split os into per-DO workers", merged 2026-06-12 10:04 BST), the
prd Cloudflare account's **Durable Objects billable compute duration** jumped
100–1000×. dev/preview is worse (~13× prd). Signature: individual DO invocations
with wallTime up to **17 hours**, **~0 CPU**, **0 WebSockets**. Cost is small in
absolute terms (~$25 prd / ~$300 dev-preview per cycle) but it is a real
architectural leak that scales with usage.

## Confirmed mechanism (as of 2026-06-14)

Stream subscriptions use a **push** model. A subscriber DO calls
`subscribeOutbound(...)` on the Stream DO (cross-script Workers RPC) and passes a
`processEventBatch` callback. The Stream DO **dup()s and retains that callback
stub** so it can push later (`packages/streams/src/processors/core/implementation.ts:530`,
comment at `:514–517`). A capability passed across an RPC keeps that **RPC session
open until the stub is disposed**. Per CF docs, _"a Durable Object stays alive as
long as requests are being processed"_ — so the still-open session keeps **both**
DOs resident and billable, at ~0 CPU and no WebSocket, for the entire subscription
lifetime.

- NOT caused by `ctx.waitUntil` (it is a **no-op** inside DOs — corrected after an
  initial wrong explanation that leaned on it). The misleading comment lives at
  `packages/streams/src/workers/stream-processor-host.ts:232`.
- NOT an alarm and NOT a busy loop. The pump parks (returns) when caught up and is
  re-woken by `connection.wake()` on append (`implementation.ts:548–604`).
- Before #1500 both ends were in one isolate, so the retained callback was an
  in-process JS reference — no cross-isolate session, nothing extra billed. The
  split turned it into a genuine cross-script open session.
- No idle teardown: a connection only closes on `unsubscribed` / `replaced` /
  `rpc-broken` / `delivery-failed` / `subscription-removed`
  (`implementation.ts:615–652`). A subscription to a quiet stream stays pinned
  forever.

### Evidence (CF GraphQL analytics, account 04b3b57291ef2626c6a8daa9d47065a7)

| date     | activeTime (µs) | note                                     |
| -------- | --------------- | ---------------------------------------- |
| Jun 7–11 | <2e9/day        | baseline                                 |
| Jun 12   | 2.91e11         | split lands 10:04 BST                    |
| Jun 13   | 1.23e12         | peak (~14 DO-equivalents pinned all day) |
| Jun 14   | 3.34e11         | still accruing at query time             |

Per-script wallTime p99 (Jun 12): os-prd-agent 62,457s (~17.3h), os-prd-itx
61,404s, os-prd-repo 61,402s. dev/preview reproduced the same on os-preview-3-_
and os-preview-5-_ (and a distinct pre-split os-dev-jonas hold on Jun 11).

## Plan

1. Reproduce reliably in ONE preview environment; capture the billing signal.
2. Deeply understand (done at code level; confirm empirically).
3. Write a FAILING test — fast workerd integration test for the mechanism +
   slow preview e2e for the duration signal.
4. Fix.
5. Adversarially pressure-test in the preview env.
6. Defense-in-depth to prevent recurrence.

## Chosen approach — Option 1, Stream-DO-authoritative idle teardown

Jonas's steer (2026-06-14): _"specific logic in the stream durable object that says
'if nothing happens for a while, I'll deliberately go to sleep — delete all
connections etc.'"_ Adopted.

Design (revised — **in-memory timer, NOT a DO alarm**; see "alarm vs timer" below):

1. Stream DO holds an **in-memory `setTimeout`**. It is (re)armed after each append
   while there are live outbound connections, and cleared when the connection count
   hits zero. No storage writes; no durable alarm.
2. On fire: sever every live **outbound** connection — dispose each retained
   callback stub. The freed subscriber DO hibernates (~10s), which wipes its
   in-memory `entry.stream`, releasing the Stream DO too (cascade). New disconnect
   reason `"idle"`. Scope = outbound only (the measured leak); inbound (browser)
   connections are left alone — they belong to active viewers and want WS
   Hibernation, a separate change. (Pending Jonas's call on outbound-only vs all.)
3. The durable `subscriptionsByKey` config is untouched, so the existing
   `woken → reconcileConnections → dial` path re-dials all subscribers on the next
   real append; each re-handshakes from its durable checkpoint (replay covers the
   gap). Verified: `implementation.ts:391–432` (reconcile from persisted config),
   `stream.ts:75–100` (woken fact restores connections on every wake).

### Alarm vs in-memory timer (Jonas, 2026-06-14) — TIMER wins

Initial design used a DO alarm; Jonas pushed back: if the DO is already awake, why
a durable alarm rather than an in-memory `setTimeout`? He's right. The retained
stubs we tear down are in-memory and die on eviction — exactly the lifetime of a
`setTimeout`. A durable alarm buys cross-eviction persistence we don't want: if the
DO is evicted the stubs are already gone (nothing to tear down), and an alarm's only
extra power — waking a _hibernated_ DO — is the very thing we must avoid. The alarm
is also worse on the hot path (a `setAlarm()` storage write per append to push the
deadline) and has more moving parts (deleteAlarm, persisted lastActivity). Since the
DO is always resident while holding stubs, the in-memory timer is guaranteed to fire.
Decision: in-memory `setTimeout`, reset on append, cleared at zero connections.
(Testability note: in-memory timers are harder to fire deterministically than
`runDurableObjectAlarm`; the regression test uses a short idle window + real-time
`settle()`, or a directly-invoked sever method — TBD against the outbound harness.)

### Two-sided teardown (Jonas, 2026-06-14): producer AND subscriber idle timers

Belt-and-braces, both with failing tests:

1. **Producer (Stream DO)**: in-memory idle timer severs outbound connections
   (disposes the callback stub → frees the subscriber).
2. **Subscriber (StreamProcessorHost / StreamProcessorRunner / Agent DO)**: its
   OWN in-memory idle timer, reset on each delivered batch; on fire it disposes
   `entry.stream` (+ unsubscribes) → frees the producer and goes dormant. Re-armed
   when the producer re-dials it.
   These are complementary (each frees the OTHER side directly; each frees itself via
   the hibernation cascade), so either firing is sufficient and both firing is prompt

- robust to one side's logic failing.

Re-dial correctness for BOTH paths: appends don't reconcile by default
(`stream.ts:476`). So after ANY idle sever (producer- or subscriber-initiated) the
Stream DO must re-dial configured-but-disconnected subscriptions on the next
append. Implemented generally via `coreProcessor.needsOutboundReconcile()` (cheap
O(subscriptions) check; no-op in steady state) called from `#appendBatchHere`.

### The symmetric-pin subtlety (must-get-right)

A subscription holds TWO retained stubs over one session: Stream DO → subscriber
(callback, pins the subscriber) and subscriber → Stream DO (`entry.stream`, pins
the Stream DO). "Delete all connections" on the Stream DO frees subscribers but not
the Stream DO itself — so the teardown must ALSO tell each subscriber to drop its
handle (new `releaseStreamSubscription` RPC on the host). Confirmed by data: the
subscriber scripts (os-prd-agent/itx/repo/workspace) were pinned too, not just
os-prd-stream.

### "Doesn't the idle alarm just WAKE the DO?" (Jonas, 2026-06-14)

No — and the question tightened the design. The alarm only ever fires on a DO that
is _already awake_: the retained stubs pin it resident (that IS the bug), so it
cannot hibernate while connections are held. The alarm runs on the live, already-
billing incarnation, disposes the stubs, then the DO sleeps. It does not wake a
sleeping DO; it lets a stuck-awake one sleep. Two rules prevent a recurring alarm
from waking a _hibernated_ DO:

1. Arm the alarm ONLY when there are live connections (`hasLiveConnections()`
   guard). No connections → no alarm → natural hibernation, nothing scheduled.
2. `deleteAlarm()` after teardown → no pending alarm survives; the DO sleeps until
   a real external append wakes it (when there's genuinely work).
   A timer is unavoidable: "idle for a while" has no triggering event, so some
   scheduled primitive must fire. A DO alarm is correct (a `setTimeout` is itself
   in-flight work that keeps the DO up and doesn't survive eviction). Net: strictly
   less resident time.

### Known implementation gotcha

`stream.ts` constructor appends a `woken` fact on EVERY wake — including the
idle-alarm wake — which re-dials everyone. The teardown must suppress re-dial on
the alarm path (e.g. flag the alarm wake; reconcile skips dialing) or it
thrashes (re-dial → teardown loop). Covered by a regression test.

## Rejected / deferred alternatives

See `ALTERNATIVES.md`. Summary: Option 4 (lease/heartbeat) is the best fallback if
alarm-storage churn is costly; Option 6 (co-location) kept as a perf optimization
for the hottest same-app streams; Options 2/3/5 rejected (break push latency /
heavy new transport / breaking contract change).

## Timeline / log

- 2026-06-14 — Diagnosis complete; branch + decision log opened; 3 investigation
  sub-agents dispatched (repro runbook, test-harness observables, fix menu).
- 2026-06-14 — Chosen Option 1 (Stream-DO-authoritative idle teardown) per Jonas.
  Verified cold re-dial path works from durable `subscriptionsByKey`. Documented
  the symmetric-pin subtlety + the woken-reconcile gotcha. Next: failing workerd
  test, then implement.
- 2026-06-14 — Switched alarm → in-memory `setTimeout` (Jonas: the DO is already
  awake while pinned; durable alarm would only wake a hibernated DO + writes
  storage per append). Producer-side fix landed:
  - `contract.ts`: `"idle"` disconnect reason.
  - `implementation.ts`: `hasLiveOutboundConnections()`, `closeIdleOutboundConnections()`,
    `needsOutboundReconcile()`.
  - `stream.ts`: in-memory `#idleTimer`, `#idleTeardownMs()` (env-overridable,
    default 5m), `#armOrClearIdleTimer()` (arm only when outbound connections
    exist), `runIdleTeardownNow()`; `#appendBatchHere` re-dials severed
    subscriptions on the next DOMAIN append and re-arms/clears the timer.
  - Bug caught by the test: the teardown's own `subscriber-disconnected` fact
    re-triggered `needsOutboundReconcile` and instantly re-dialed — fixed by
    gating re-dial to non-`stream/*` (domain) appends.
  - Tests green: new `stream-idle-teardown.workers.test.ts` (sever → reason "idle"
    → re-dial on next append, via the real echo-runner outbound path) +
    79 streams node + 16 streams workers (incl. M1 re-dial) + 13 apps/os inbound
    itx-stream-subscribe. No regressions.
    Next: subscriber-side belt-and-braces (host idle disconnect) + failing test;
    public PR; preview repro + pressure test; defense-in-depth.

- 2026-06-14 — Public PR opened: https://github.com/iterate/iterate/pull/1518 (draft).
- 2026-06-14 — Narrowed the re-dial gate per Jonas: exclude EXACTLY the
  `subscriber-disconnected` event (the one self-undoing trigger), not the whole
  `stream/*` namespace. Documented inline in `stream.ts`.
- 2026-06-14 — Subscriber-side belt-and-braces landed (host idle disconnect):
  - `stream-processor-host.ts`: in-memory idle timer (`HOST_IDLE_TEARDOWN_MS`, 5m),
    reset on each delivered batch + handshake, cleared when no entry holds a live
    stream stub; `runIdleDisconnectNow()` unsubscribes (frees this DO) and disposes
    `entry.stream` (frees the producer), keeping the durable checkpoint so the
    producer's re-dial re-handshakes.
  - `stream-processor-runner.ts`: exposes `runIdleDisconnectNow()`.
  - Lives in `createStreamProcessorHost`, so it AUTOMATICALLY protects the real
    Agent / repo / workspace host DOs (the pinned subscribers in the leak data).
  - New `stream-host-idle-disconnect.workers.test.ts`: host drops its stub on idle
    → producer's outbound connection closes too → re-handshakes on next append.
    Green: 79 node + 17 workers streams; apps/os typecheck; oxlint clean.
    Remaining: preview repro + adversarial pressure test (real billing signal);
    defense-in-depth recurrence guard.
