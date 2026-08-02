---
status: ready
size: small-medium
---

# Expandable approval detail on notification cards

## Status summary

Implemented, twice over: first the expandable approval detail on
notification rows (shared components, spec, video), then — per Misha's
review verdict — the standalone Approvals screen was RETIRED: decide
actions and the approver-key banner moved to the Notifications surface,
approvals-destination pushes route there with the matching row
pre-expanded, and both mobile specs run through the new surface (3x
consecutive passes each). Remaining: final gates + CI.

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
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene
      _all four green from the worktree root after the spinner-disable
      removal round (2026-08-02); PR body update stays with the parent_

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

## Removal scope (Misha: "we should just get rid of the approvals view")

- [x] Decide actions for open batches inside the notification expansion
      _shared `ApprovalBatchActions` in components/approval-batch.tsx — the
      retired screen's respond mutation verbatim (approve-all signs via
      signWithApproverKey, reject-all prompts a reason, never signs);
      rendered when `resolved === null` and unexpired; onDecided
      invalidates the batch query so the record replaces the buttons_
- [x] Approver key UI on the Notifications screen
      _components/approver-key-banner.tsx (enroll / re-enroll / signing-as,
      moved verbatim), mounted above the list; shares the
      approver-key-status query cache with the actions_
- [x] Routing: approvals-destination pushes → Notifications view
      _lib/notification-routing.ts routes to
      /project/[projectId]/notifications with approvalRequestEventOffset;
      the screen pre-expands the matching row (ActivityCard's
      toggled-or-default pattern). CHOICE: no scroll-to-row — newest-first
      list puts a fresh push's row at/near the top; noted as acceptable.
      The expansion's "Open in Approvals" link removed (it would
      self-navigate) — scope batches show their source line, nothing more_
- [x] Removal: approvals.tsx + drawer entry deleted; `focusOpenBatch` (+ its
      test) pruned as screen-only; knip clean
- [x] approvals.spec.ts final act reworked through the Notifications view
      _spec now enrolls the browser's device identity (rows need a device
      stream; both batches are claimed in-thread so the fake token is never
      dialed), expands both rows, keeps the #2372 full-text thread-context
      assertions and the tap-through verbatim_
- [x] notifications.spec.ts decides from the expansion
      _replaces the admin-side reject: "Awaiting decision" + Reject via the
      window.prompt stand-in (retried press, button-departure success
      signal), then asserts the historical record_

Removal-round log:

- decide() signature compatibility confirmed: it takes the requested
  event's payload, which deriveBatchDetail already returns verbatim (both
  deriveOpenBatches and the by-offset fetch carry `requested.payload`
  untransformed) — no reconciliation needed beyond an `expired` guard on
  showing the actions (deriveOpenBatches used to filter expired batches;
  the expansion checks payload.expiresAt instead).
- What resisted: the LOCAL dev server (miniflare host) dies with a V8
  heap OOM after ~2-3 consecutive spec runs — every mid-series spec
  failure in this round was that (health 000, OOM in dev-server.log), not
  spec logic. Cure: `pnpm dev restart --detach` before each run; the 3x
  series for both specs was recorded with fresh servers. Worth a separate
  look at the dev server's memory ceiling.

## Tabbed activity cards (Misha, comment 5158038879)

- [x] "Ran code" cards show the run's approvals in context via the SAME
      shared component
      _each code step is now Script | Approvals | Result tabs
      (activity-card.tsx CodeStepTabs); the Approvals tab renders decision
      badge + reason + the shared ApprovalBatchBody, matched by
      streamContext.executionId against the step's executionId
      (deriveBatchesForExecution in lib/approvals.ts, unit-tested)_
- [x] Approvals tab absent with no batches; Result absent while pending
      _tabs array is conditional; Result appears once the run settled with a
      value or an error; single-tab steps render no tab row at all_
- [x] Multi-turn runs organize vertically as Round 1 / Round 2
      _pure groupActivityRounds in lib/feed.ts (llm-writes-script +
      code-runs-it pairs; stray steps get their own round), labels only when
      >1 round. WORD CHOICE: kept "Round" — "Turn" is overloaded with chat
      turns and "Pass"/"Attempt" mislead (not retries; the script passes
      itself a value)_
- [x] Collapsed status glyphs
      _spinner while running (unchanged) + approval marks in the summary
      row: ◷ any batch awaiting decision, ✓ fully approved batch(es), ✗
      rejected or mixed (summarizeBatchOutcomes, unit-tested)_
- [x] Batch plumbing
      _CHOICE: prop-drilled from chat.tsx (FeedList → FeedItem →
      ActivityCard as ActivityApprovalContext) — the chat screen already
      holds the live root-stream approval subscription for its in-thread
      dialogs, so the tabs and glyphs update live with zero extra fetches;
      a per-card query would duplicate already-subscribed data and need the
      same context props anyway. ActivityCard's only usage is chat.tsx_
- [x] approvals.spec.ts extended: finds both settled cards by glyph
      (✓ / ✗), opens the approved card's Approvals tab, asserts badge +
      policy through the shared body; 3x consecutive passes, and
      notifications.spec.ts re-verified 3x (fresh dev server per run — the
      miniflare heap OOM again)
- [x] VIDEO_MODE re-record of approvals spec → activity-tabs.webm
      (32s: live card with Script|Approvals tabs + ◷, settled cards with
      ✓/✗, Approvals tab opened)

## Spinner-waiter disables: measured, then removed

(Misha: "See if the flickery spinner issue is actually an issue before
making the spinner stitch together gaps.")

Verdict: the "frame gap" the scoped disables guarded against was NOT real.
Every disable is gone from both mobile specs. What the measurements showed:

- Baseline: all ~17 `spinnerWaiter.settings.run({ disabled: true })` blocks
  removed, 5+ runs per spec, fresh dev server per run.
- approvals.spec.ts: 6 pass / 2 fail in 8 runs. BOTH failures were the same
  site — decideBatch's `waitFor({ state: "detached" })` — and the trace
  proved the product was fine: the press landed, the confirm dialog fired
  and was accepted, the decision appended, the burst ran (200s), the card
  left the thread. The spec still failed because spinner-waiter's readiness
  heuristic (visible && enabled) is inverted for DISAPPEARANCE waits: a
  gone-or-renamed button reads as "target missing, no spinner" and the wait
  gets the 1ms fast-fail rewrite — and `timeout: 1` aborts before the first
  evaluation can report "already detached", so an ALREADY-SATISFIED wait
  hard-fails. Middlewright bug, not a product gap.
- notifications.spec.ts: 0 pass / 4 real runs (plus one dev-server OOM),
  all at the same line — lane two's `getByText("Send failed").waitFor`.
  Genuinely no spinner AND no target: the wait starts the moment the
  elsewhere-thread's script fires, and for several seconds the pipeline
  (script start → egress hold → 2s debounce → grace window → Expo round
  trip) has NO on-screen counterpart on this device — like a phone idling
  before a push arrives. Not a frame gap; a structural
  external-event wait that belongs on the protocol.
- Every other formerly-disabled site (route transitions, batch-card mounts,
  row expansions, glyph/tab assertions, deep links) passed repeatedly with
  the middleware fully on — covered by real product spinners (working row,
  activity card, screen/detail ActivityIndicators) plus the 100ms handoff
  bridge.

Fixes (no disables anywhere):

- patches/middlewright.patch extended: spinner-waiter is now goal-aware —
  `waitFor({ state: "detached" | "hidden" })` inverts the readiness check
  (target no longer visible = success-adjacent), so satisfied disappearance
  waits proceed with their original timeout instead of the 1ms fast-fail.
  Candidate upstream middlewright change.
- Product (apps/mobile/src/lib/notifications.ts): non-terminal row statuses
  are now honest in-flight indicators — "Waiting to send…" / "Sending…"
  (the chat working-row's `anythinging…` convention). The push obligation
  IS server work in flight; the row now shows it as such (and
  spinner-waiter recognizes it, keeping the UI wait covered from row
  appearance to settlement).
- Spec (notifications.spec.ts lane two): the external-event window is
  waited out on the PROTOCOL (expect.poll for the device stream's second
  notification-settled event), then the UI assertion rides the row's own
  in-flight status flip.
- Timeouts tightened now that waits are honest: UI-local assertions on
  already-present data 30s/15s → 5s; cross-server waits (screen-mount
  fetches, expansion one-shot queries, chat mounts) → 15s; cold multi-hop
  waits (first project open, batch coalescing) keep 30s.

Review round (tabbed-cards screenshot feedback):

- [x] Self-referential provenance block hidden inside activity cards
      _ApprovalBatchBody gains a REQUIRED `showThreadInfo` prop (explicit at
      both callsites per repo preference): the Notifications expansion
      passes true, the activity card false — the card lives inside the
      thread the block would link to. The non-script "Triggered from …" /
      "Source metadata unavailable" fallbacks are gated too (same
      provenance concern)_
- [x] Tab selection restyled to read as a TAB, not a pill
      _flat tab bar: full-width hairline baseline in colors.border, active
      tab marked by a 2px underline + label in neutral colors.text (never
      the accent — that is the status badges' color), inactive labels
      textFaint. No borders/pills/backgrounds, so nothing resembles the
      Approved/Rejected badges. Spec tab presses target role+name, so the
      restyle needed no selector changes_
