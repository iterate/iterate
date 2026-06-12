---
state: todo
priority: high
size: medium
dependsOn: []
---

# Stream subscriber deliveries stall mid-turn on fresh agent streams

## Context

During the agent UI work (PR #1501) we repeatedly observed, on preview-4 with
healthy workers: a browser subscribes to a fresh agent stream, the first
message triggers an agent turn, deliveries flow for part of the turn (e.g.
events 1–40 of 99 reach the mirror), then stop — while the journal keeps
growing and the subscriber's socket stays healthy (`runtimeState()` on the
same connection answers with the current `maxOffset`). No close frame, no
error, no `subscriber-disconnected` fact. The same symptom reproduced in
local dev throughout (previously filed mentally under "#1500 dev weirdness",
but preview shows it is not dev-only).

The shape points at the Stream DO's outbound delivery loop (or a hop it
dispatches through) dying or losing the subscriber entry under agent-turn
load — agent turns reset/evict DOs in the same family
(`itx` context streams, `agent-host` wakes, worker-split cross-script hops),
and a recreation wipes the subscriber registry without notifying connected
sockets. A second flavor: a subscription opened moments before the agent
machinery "properly" creates the stream is orphaned by that creation
(incarnation change), again with the socket left open.

## What the browser already does (mitigation, shipped in #1501)

`packages/streams/src/browser/stream-browser-store.ts` self-heals: the 10s
liveness probe reconnects when the incarnation under the subscription changed
or when the server's `maxOffset` is ahead while no delivery arrived for a
whole probe interval; parked `reconcile`/`subscribe` calls time out after
15s. Net effect: a stalled page catches up in ~30–60s instead of wedging
until reload. That is damage control, not a fix — the live-streaming UX
visibly freezes for that window, and every other subscriber type (DO
processors, node clients) has no equivalent guard.

## Goal

Find and fix the server-side reason deliveries stop mid-turn:

- Instrument or reason through the Stream DO delivery path under an agent
  turn: what happens to outbound subscriber connections when the DO (or the
  worker hop carrying the websocket) is evicted/reset mid-stream? Is the
  subscriber registry durable across incarnations, and should a recreation
  close subscriber sockets instead of leaving them open-but-orphaned?
- Decide the contract: either deliveries survive DO churn (registry +
  redelivery cursor persisted, sockets re-attached), or churn must
  affirmatively close subscriber sockets so clients reconnect immediately
  rather than discovering staleness by probing.
- Cover the subscribe-vs-create race for lazily-created agent streams: a
  subscription accepted by a pre-creation instance should either carry over
  or be terminated at creation time.

## Repro

- Deterministic-ish on a preview slot: open
  `/projects/<p>/agents/streams/agents/<fresh-name>` in a browser, send one
  message through the composer, watch the raw mirror stop partway through
  the turn while `... streams read` shows the journal complete. The browser
  self-heal then kicks in after ~30–60s; the stall itself is the bug.
- Wire evidence captured during #1501: pushes for early turn events arrive
  on the subscriber socket, then silence; `runtimeState()` on the same stub
  keeps answering with growing `maxOffset`.
