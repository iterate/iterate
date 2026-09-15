# Alarm cleanup plan

Planning baseline: `21ffa0acb`, 2026-09-15. This is the cleanup implemented on top of the
scheduled-appends feature, informed by three subagent investigations and independent Fable/Codex
architecture reviews. The implementation keeps the work in small, observable stages: bounded
ephemeral traces, complete deadline ownership, private same-context dispatch, and removal of the
blanket self-wake breaker.

Keep the native alarm as a wake mechanism derived from current work. Keep schedule intent and
outcomes in the event log, existing subscription progress in its durable cursors, and idle resource
cleanup in memory. Replace historical deadline requests with current, withdrawable deadlines.

## What is established

- [The coordinator](../src/alarm-coordinator.ts) remembers the earliest request per owner until an
  alarm fires. It cannot withdraw a completed watchdog, postpone an idle deadline after activity,
  or delete the physical alarm when work disappears.
- [Subscription delivery](../src/stream/subscription-delivery.ts) shares one `delivery` deadline
  across multiple subscriptions. Its queued/in-flight watchdog is 20 seconds; existing cursor
  retries have their own durable timestamps and bounded failure policy.
- [The context](../src/iterate-context-durable-object.ts) uses a 60-second idle clock. Before this
  cleanup, internal same-context `invoke()` calls also looked like external activity and the root
  config subscription could reset a durable self-wake breaker. The private adapter and ephemeral pass
  traces now make that distinction explicit.
- Saved preview tails show successful approximately 60-second wakes across multiple contexts.
  Canceled attempts paired with successful delivery for the same DO and scheduled time are a
  separate observation. They do not establish a lost alarm.

The exact resource keeping each observed context active is not established. A 20-second watchdog
defect must not be presented as proof of a 60-second idle loop. Instrument and reproduce that loop
before choosing any change to lifecycle semantics.

## Target model

| Owner                 | Authoritative state                                                | When its deadline disappears                                                                             |
| --------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Scheduled appends     | Existing core schedule projection                                  | Completion, cancellation, pause or parked failure                                                        |
| Subscription delivery | Existing cursor/retry state, plus current queued/in-flight records | Durable acknowledgement, caught-up cursor, removal, replacement, halt or classification as a push target |
| Idle cleanup          | Current live resources and quiet deadline                          | Resources released; eviction discards the whole incarnation                                              |

`SubscriptionDelivery` computes its own minimum from existing records. The coordinator sees these
owner-scoped deadlines; it does not become a public timer registry. Finishing one delivery must not remove
another delivery's watchdog. Replacement must be guarded by the subscription definition/attempt
identity so an old completion cannot cancel new work.

For known current-incarnation alarms, reconciliation sets the current minimum, moves it later when
appropriate, and deletes it when all owners return no deadline. Firing consumes the native
notification, not the underlying work. Recompute obligations instead of clearing them wholesale.

Keep native writes ordered and let storage failures fail the invocation. Deferral remains a short
synchronous scope around atomic commits and registration of their resulting work. Never defer
watchdog installation across an awaited subscriber call; reconcile fresh state after settlement.

## Implementation sequence

1. **Prove and name the wake.** Emit bounded `events.iterate.com/stream/trace/alarm` events with
   `ephemeral: true`. A `fire`, `reconcile`, `delivery` or `quiesce` phase records the current
   incarnation, selected owner/deadline, cursor progress, live facet/stub/connection counts and the
   final rearm/delete decision. The event is lazy and exact-type opt-in through `waitForEvent`: no
   waiter means no trace offset traffic, and a waiter receives one bounded live event without joining
   subscription delivery or keeping a cursor lane active. Payloads
   are depth-, key-, string- and byte-bounded; trace append failures report an issue and never fail the
   alarm path. Build deterministic root-context reproductions with no resources, a hosted facet, a
   borrowed stub and a library connection. Measure warm versus cold behavior and which operation
   refreshes idle time.

2. **Give deadlines a complete lifecycle.** Add replace/clear semantics to the small coordinator.
   Put delivery watchdogs on existing per-subscription records; register before work can be lost,
   and clear only after the corresponding durable transition. Refresh idle by replacement and
   clear it after quiescence. Do not hold a fulfilled watchdog merely as crash insurance.

3. **Reconstruct durable recovery explicitly.** Derive due retry times and unfinished durable
   delivery from subscriptions, cursors and log position, including a first delivery whose cursor
   was never persisted. Preserve the cold-start alarm-restoration protection while initializing.
   Treat an inherited native alarm as temporary recovery insurance: do not postpone or delete it
   merely because in-memory owners report nothing. An earlier known deadline may fire first; that
   handler must still inventory all recovery work before retiring the inherited contribution.
   Afterwards, current owners determine the exact alarm. This allows one inherited stale wake,
   never a repeating series of unexplained wakes.
   Keep facet checkpoint ownership and existing push/read catch-up behavior; do not reintroduce
   an eager resurrection pass over every facet.

4. **Correct activity accounting and remove the blanket breaker.** Route same-context internal
   execution through a private path that preserves caller attribution, resolution and committed
   effects. Keep external requests and sibling-context calls on their existing public path.
   Audit delivery-completion and append activity hooks too: changing `invoke()` alone does not
   remove every maintenance refresh of idle time. Newly acquired resources and actual work
   completion must still publish a cleanup deadline. Cleanup must protect in-flight work, then release
   resources when the real quiet period ends. Once these invariants pass, delete the global
   self-wake streak, metadata reads/writes, request-reset bookkeeping and alarm gating. Existing
   per-subscription retry limits and durable halt facts remain. Alarm passes are observable through
   bounded ephemeral traces. Preserve historical event readability; do not erase history or
   automatically unpark halted subscriptions.

Do not define success as making the old five-wake halt fire. Legitimate cursor recovery can need
more than five alarms. The desired outcome is either an identified pending obligation or no alarm.

## Deliberate lifecycle boundary

Preserve `stream/woken` in the first cleanup. It currently marks every incarnation and helps
consumers interpret ephemeral-offset reuse. Do not append it and silently exclude it from wildcard
delivery, and do not remove it as an incidental constructor refactor.

If the controlled reproductions still show cleanup-only cold starts manufacturing recurring work
after exact deadline release and corrected activity accounting, make that a separate, explicit
contract change: construction rehydrates; `woken` is emitted once before an incarnation first
performs stream activity, while a stale/cleanup-only wake produces telemetry. That change requires
independent recovery of pre-existing cursor work, preservation of event ordering and initial
`created`/config setup, and an audit of config, wildcard and facet consumers. It is not required
merely to implement cancellable deadlines.

## Acceptance proof

- An acknowledged default config delivery leaves no watchdog. After real idle cleanup, there is
  no rearm and no pinned resource, even after a cold start.
- Completing or replacing delivery A preserves B's deadline; stale A settlement cannot clear its
  replacement. Removing, halting and converting a cursor target also withdraw their own deadlines.
- New activity moves idle cleanup later. Slow facet completion and a concurrent borrowed-stub call
  remain safe and eventually release resources.
- Eviction before the first cursor write, during a delivery, and after acknowledgement reconstructs
  the correct outstanding work. Retry recovery continues beyond five alarm-only passes, then follows
  the existing bounded policy.
- Schedule cancellation/replacement, pause/resume, atomic batch completion, duplicate alarms,
  intervals, provenance and ephemeral-offset reuse retain their current guarantees.
- On an isolated preview, exercise a known context, disconnect, and observe it without polling it
  during the quiet window. Require no unexplained wake for at least three idle intervals after
  quiescence, plus a disconnected schedule firing correctly after eviction. Correlate native
  attempts by DO and scheduled time, and inspect resource state and duration as well as errors.

Use the existing workers tests for deterministic failure boundaries and the deployed scheduling
examples for userspace compatibility. Run normal repository checks and review every changed
expected-failure test against its new invariant. Green tests alone are not release acceptance.

## Complexity and exclusions

This is a medium lifecycle cleanup: the deadline arithmetic is small; ownership during async
settlement, cold reconstruction and idle-resource lifetime carry the risk. The implementation keeps
the work in reviewable stages for proof and ownership. A change to `woken` semantics deserves its
own review if the evidence requires it.

No new schedule retries, backoff policy, cron, timer table, generic obligation framework, public
facet alarm API or durable event for every native set/delete/fire. Keep the current scheduling API
intact. Ephemeral alarm traces are the bounded, opt-in observability surface; they do not enter the
durable log, core reducer or subscription delivery. The intended result is fewer independent mechanisms
and an identifiable reason for every alarm.

Cloudflare documents that each DO has one replaceable alarm, constructor arming can interfere with
an existing alarm, and deleting an alarm does not guarantee suppression of a retry already in
progress. Duplicate and stale delivery must therefore remain safe:
[Cloudflare alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/).
