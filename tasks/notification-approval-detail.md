---
status: ready
size: small-medium
---

# Expandable approval detail on notification cards

## Status summary

Spec committed, implementation not started.

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

- [ ] Shared approval-detail component extracted from the approvals screen
      (no drift between the two surfaces)
- [ ] Approval notification rows expand inline: requests, rule, verdicts,
      reason, thread-context line, originating script code; "Open thread"
      affordance inside
- [ ] Non-approval rows unchanged
- [ ] Unit tests for any new pure derivation; existing suites green
- [ ] specs/mobile/notifications.spec.ts extended: expand a row, assert the
      detail renders (requests + verdict + status line)
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene

## Out of scope

- Web dashboard notifications surface
- Re-showing decided approvals in the chat thread (separate design question)
