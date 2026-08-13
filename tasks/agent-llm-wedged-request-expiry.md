---
status: in-progress
size: small
---

# A wedged in-flight LLM attempt must not outlive its expiry horizon

## Status summary

Root cause understood from a prod incident (2026-08-13, `misha` project,
stream `/agents/web/2026-08-13t15-16-03-686z`): an agent showed "Waiting for
a response" counting up for ~28 minutes. Fix is scoped and small: the at-head
expiry settle must be unconditional once `open.expiresAt` passes, abandoning
this incarnation's in-flight slot instead of deferring to it.

## The incident

- `llm-request-requested` @2973 landed 15:25:43 (expiry 15:35:42). The
  incarnation dialed the transport and streamed ~29 ephemeral chunk events,
  then wedged around 15:25:51 — no settlement, no failure, nothing.
- Deliveries kept flowing the whole time (watcher `connection-opened/closed`
  presence events every ~5s, subscription lag 0), so the at-head pass ran
  constantly — but `#atHead`'s expiry branch only runs when
  `!this.#llm.isExecuting(open.requestedAtOffset)`. The wedged incarnation's
  `#inFlightLlmCall` slot stayed occupied forever, so the processor could
  neither re-run nor expire the request.
- The constant presence traffic also kept the Durable Object alive (no
  eviction → no adopt-based recovery) and kept resetting the keepalive's
  busy-refire wedge counter (`track()` zeroes `#busyRefires` on ANY settle,
  including unrelated delivery work), so the keepalive never revived either.
- 28 minutes later a fresh incarnation (booted by an operator poking
  `snapshot()`) ran at-head and settled `cancelled/expired` immediately —
  proving the expiry machinery works and only the `isExecuting` guard was
  blocking it.

The transport itself has a whole-attempt deadline (`deadlineMs =
expiresAt - now`), but the run() closure has un-deadlined awaits outside the
transport: `readConsumedEvents()` (pages the whole history over DO-stub
RPCs), `prepareAgentLlmMessages` (signed-URL RPCs), and the settlement
appends. A hang in any of those escapes every deadline and wedges the slot.

## The fix

- [x] Failing spec first: scripted transport that never settles, clock past
  the horizon, a delivery at head → expect `cancelled/expired` settlement,
  abort of the hung attempt, no re-dial. _In agent-processor.test.ts,
  "expiry: a WEDGED in-flight attempt…"._
- [x] `AgentTurnLoop.#atHead`: once `now >= open.expiresAt`, settle expired
  unconditionally — first `abandonExpired(open.requestedAtOffset)` so the
  hung closure is aborted and the slot freed. _agent-turn-loop.ts._
- [x] `AgentLlmRequest.abandonExpired(requestOffset)`: abort + clear
  `#inFlightLlmCall` when it belongs to that request. The aborted closure's
  late settle already loses the `settle/<offset>` idempotency race, and its
  catch's `signal.aborted` guard keeps it from journaling a duplicate
  failure. _agent-llm-request.ts._

## Follow-ups deliberately out of scope

- Keepalive wedge detection is defeated by frequent unrelated settlements
  (`#busyRefires` resets on any settle). With this fix the agent's own
  horizon covers the worst case, but the detector remains blind on busy
  streams. Worth its own task.
- The UI's "Waiting for a response NNNNs" counter keeps counting past the
  request's expiry horizon even though nothing can still be running; it could
  render a "stalled" state after `expiresAt`.
- Why the incarnation wedged at 15:25:51 (append RPC that never resolved?
  isolate-level breakage?) is unproven; the fix makes the blast radius
  "one turn expires" regardless of cause.

## Implementation log

- Reproduced the incident end-to-end from the prod stream journal (replayed
  the fold over dumped events; confirmed `openRequest` stood open with
  deliveries flowing and no settlement until a fresh incarnation booted).
- Spec went red exactly like prod (no settlement, hung slot); fix turned it
  green with the rest of the agents suite (169 tests) untouched.
- Kept the `!isExecuting` guard on the RUN branch — only the EXPIRY branch
  became unconditional; a legitimately executing attempt is still never
  double-dialed.
