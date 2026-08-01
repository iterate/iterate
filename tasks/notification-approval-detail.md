---
status: ready
size: small-medium
---

# Expandable approval detail on notification cards

## Status summary

Implemented: shared batch-detail components extracted from the approvals
screen, Notifications approval rows expand inline into the full history
(requests, verdicts, reason, thread-context line, script, Open thread),
spec extended and passing 3x consecutively. Remaining: final gates + CI.

## Ask (Misha, 2026-08-01)

The Notifications view's approval rows are thin — a status line and a deep
link into the chat, which no longer shows the approval once it's decided
(the in-thread dialog renders open batches only). The rich rendering of a
historical approval — the requests, the rule, the verdict/reason, the
thread's status at the time, "the script + status at the time + whatever
else" — should be reachable from the notification: make the approval
notification card **expandable** to show that detail inline, rather than
being only a deep link.

## Design

- Approval-born notification rows already carry `approvalRequestEventOffset`
  (top-level on the intent since #2371). Tapping an approval row toggles an
  expanded state (collapsed by default) instead of navigating; the deep link
  moves to an explicit affordance inside the expanded area ("Open thread").
  Non-approval notifications keep their current tap-to-navigate behavior.
- The expanded body reuses the approvals screen's history rendering — the
  batch card content from `approvals.tsx` (requests with method+host, rule
  key/description, per-index verdicts, rejection reason, decidedBy, and the
  #2372 thread-context line with its status fold). Extract the shared
  pieces into reusable components rather than duplicating markup — the
  approvals screen and the notification expansion must not drift.
- Data: the expansion fetches the batch's events from the project root
  stream by offset (requested + decided + settled), one-shot react-query
  keyed on the offset, `staleTime: Infinity` (decided history is immutable;
  an undecided batch's row can refetch like the thread-context line does —
  reuse that settledness-gating pattern if it applies).
- Expansion state: no useState — same toggle pattern the activity card uses
  (check how `ActivityCard` handles expanded/collapsed and follow it; if it
  uses useState internally, match the existing precedent rather than
  inventing a new one).
- The script itself: the thread-context line covers "status at the time";
  if the batch's streamContext carries the executionId, showing the
  originating script's code (fetched from the agent stream's
  script-run-requested event, rendered with the existing CodeBlock) is in
  scope if it stays simple — it is the "script" part of the ask.

## Checklist

- [x] Shared approval-detail component extracted from the approvals screen
      (no drift between the two surfaces)
      _components/approval-batch.tsx: ApprovalBatchBody (requests/script/
      policy + sub-toggles + one-shot script fetch) and ThreadContextLine,
      moved verbatim from approvals.tsx; BatchCard now composes them and
      keeps only headline/actions/targeting. The in-body link reads "Open
      thread" (was "Show thread") on both surfaces_
- [x] Approval notification rows expand inline: requests, rule, verdicts,
      reason, thread-context line, originating script code; "Open thread"
      affordance inside
      _NotificationRow (ActivityCard's useState toggle precedent, chevron)
      + ApprovalNotificationDetail in notifications.tsx: one-shot query by
      batch offset against the root stream, cached forever once decided AND
      settled (deriveBatchDetail's complete flag), 5s provisional refetch
      otherwise — the thread-context line's settledness gating. Non-thread
      batches get an "Open in Approvals" link instead of the body's Open
      thread_
- [x] Non-approval rows unchanged
      _rows without a batch identity keep tap-to-navigate; the identity
      itself is new on DeviceNotificationRow (top-level intent field with a
      legacy approvals-destination fallback)_
- [x] Unit tests for any new pure derivation; existing suites green
      _deriveBatchDetail cases in approvals.test.ts (undecided/all-reject/
      partial-settle/unknown offset); row batch-identity cases in
      notifications.test.ts_
- [x] specs/mobile/notifications.spec.ts extended: expand a row, assert the
      detail renders (requests + verdict + status line)
      _the spec now rejects the elsewhere batch admin-side (with a reason)
      and seeds an agent status before the run, then expands the "Send
      failed" row and asserts URL + "Rejected because: …" + the status
      line, and drives "Open thread" from inside the expansion; 3
      consecutive local passes_
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene

## Out of scope

- Web dashboard notifications surface
- Re-showing decided approvals in the chat thread (separate design question)

## Implementation log

- ActivityCard's expansion precedent is a plain `useState` toggle (the
  task file anticipated this) — NotificationRow follows it exactly; the
  members/script sub-toggles keep BatchCard's query-cache pattern, moved
  with them into ApprovalBatchBody.
- CodeBlock untouched (mid-rework in #2379); the shared body imports
  whatever main has.
- Renamed the shared in-body link "Show thread" → "Open thread" so the
  notifications requirement and the approvals screen share one affordance;
  nothing asserted on the old label.
- Spec gotcha: after navigating via "Open thread", expo-router keeps the
  Notifications screen mounted-but-hidden and its thread-context line
  contains the thread name — the chat-arrival assertion targets the header
  HEADING role, not bare text.
- The local dev server needed two `pnpm dev restart --detach` cycles during
  spec iteration (known miniflare degradation; one mid-series failure was
  exactly that, not the spec).
