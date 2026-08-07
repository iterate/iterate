---
status: implemented
size: small
---

# Agent feed: flush script-sent replies when the script settles

**Status:** implemented with a regression test; awaiting review. Remaining:
none in this scope (stale runtime-lane phantom spinner and prd delivery errors
are tracked separately, see links at the bottom).

## Problem

Prod incident (stream `agents/web/2026-08-07t15-50-03-269z`, project misha,
2026-08-07): the agent answered a message in 15 seconds — request settled,
script ran, `web-message-sent` durably appended — but the web UI showed
"Waiting for a response" for 11+ minutes and never rendered the reply.

Mechanism in the shared feed reducer
(`packages/ui/src/components/events/agent-ui-reducer.ts`):

1. A reply sent from inside a script (`itx.chat.sendMessage(...)`) arrives
   while the script's code step is still running, so `emitAssistantMessageItem`
   defers the bubble (correct: ordering).
2. `script-run-settled` marks the step done but never flushes
   `deferredAssistantMessages`.
3. The only flush lived in `reduceAgentUiRuntime` — the transient live-state
   runtime overlay. When that lane lags or wedges (it did), the reply stays
   invisible forever. Journal replays (page reload, TUI, mobile) had the same
   hole: journal facts alone never emitted the bubble.

## Fix

- [x] Failing spec mirroring the prod event sequence — journal facts alone
      must emit the reply. _`apps/os/src/components/agent-ui-reducer.test.ts`,
      "flushes a script-sent reply when its script settles and nothing else is
      running"._
- [x] At `SCRIPT_EXECUTION_COMPLETED`: when no steps remain running and
      deferred/queued messages exist, settle the live activity and flush.
      _One conditional in the reducer; no behavior change for turns without
      deferred messages._
- [x] Verify consumers: os reducer suite (46), os components/lib (412),
      browser client-libraries (94), stream-tui (41), `@iterate-com/ui`
      typecheck — all green.

## Implementation notes

The flush deliberately settles the activity: if the turn continues after
sending a message, the next round starts a fresh activity group — honest
chronology (the message really was sent mid-turn), and a sent message must
never wait on a liveness signal to become visible.

Related follow-ups (out of scope here):

- [stream-subscriber-deliveries-stall-mid-turn](stream-subscriber-deliveries-stall-mid-turn.md)
  — the stale `useLiveState` runtime lane that hid this bug and still causes a
  phantom spinner when wedged (prd sighting appended).
- [prd-subrequest-depth-limit-breaks-deliveries](prd-subrequest-depth-limit-breaks-deliveries.md)
  — `Subrequest depth limit exceeded` skipping subscription deliveries and
  putting processor revival into a 360m backoff plateau.
