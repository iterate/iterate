---
status: in-progress
size: medium
branch: mobile-live-status
---

# Mobile: live status icons + agent-set status text in the activity card

## Status summary

Implementation done and green locally: reducer derivation + tests, mobile
card/feed wiring, and a passing Playwright spec that holds every phase open
deterministically. Remaining: PR video, CI, review.

## What

On mobile, while waiting for a response you mostly stare at "writing code…" /
"running code…" next to a generic spinner. Three improvements to the live
activity card (`apps/mobile/src/components/activity-card.tsx`):

1. **Second icon** next to the spinner, derived from state we already fold:
   - nothing — default, when all we know is "queued"/"working"
   - pencil — an llm step is streaming response text (writing code)
   - play/lightning — a code step is running
   - processing — the previous codemode script settled **with a returned
     value** (⇒ the agent owes another LLM round) but the next
     `llm-request-requested` hasn't landed yet. Only because this IS already
     derivable from existing events (see mechanics below) — no new events.
2. **Agent-set status text**: when `agent/summary-updated` (the
   `itx.agent.append({type: ".../agent/summary-updated", payload: {activity}})`
   call from `AGENT_SUMMARY_INSTRUCTION`) has fired **during this turn** —
   whether from the first line of the currently running script or from an
   earlier round of the same turn — show that `activity` text instead of the
   generic "writing code…"/"running code…". Fall back to the generic text
   otherwise.
3. **Round labels**: expanded-card round headers say "Round 1 · …" — too
   verbose. Just "1", "2", "3".

Hard constraint from Misha: **no new server-side state or events**. Everything
derives from the existing journal fold. If that turns out impossible for some
sub-state, drop that sub-state (the default "nothing" icon is always allowed).

## Existing mechanics (verified before this branch)

- `packages/ui/src/components/events/agent-ui-reducer.ts` already folds
  `agent/summary-updated` → `state.summaryActivity`, and stamps it onto code
  steps as `activitySummary` (running steps immediately, others at settle;
  new steps inherit it at birth — note that inheritance carries *stale,
  previous-turn* text, which is why "set during this turn" needs its own
  check, see below).
- `SCRIPT_EXECUTION_COMPLETED` (`capability-host/script-run-settled`) records
  `result` on the code step only when the settlement carried one
  (`Object.hasOwn(settlement, "result")`). Codemode contract: returning a
  value ⇒ another LLM round follows; `return;` ⇒ turn over. So "processing" =
  live activity, no running step, last step is a done code step (durable
  outcome) whose settlement carried a result.
- The generic texts live in `liveSummary()` in activity-card.tsx; the mobile
  fold entry point is `reduceFeed` in `apps/mobile/src/lib/feed.ts`.
- Before this branch `reduceFeed` marked the activity done the moment no step
  was running — the mid-turn gap (script settled with value → next request)
  flickered the card to settled and back.

## Checklist

- [x] Phase derivation helper _(`deriveAgentUiLiveStatus` exported from the
      reducer: `working | waiting | thinking | writing | running |
      processing` + this-turn statusText; durable-outcome + result-present
      gate for "processing")_
- [x] Track "status was set this turn" _(new `summaryActivityUpdatedAtMs`
      fold field, compared against `live.startedAtMs`; AgentUiStateSchema is
      deliberately strict, so old persisted web snapshots invalidate and
      rebuild — cache data, not a migration surface)_
- [x] Mobile `reduceFeed`: keep the activity live through the processing gap
      _(working ||= phase === "processing"; stuck-spinner guard: the reducer
      now settles an idle live activity on `agent/paused`/`stream/paused` —
      the autonomous breaker appends agent/paused, so the journal alone ends
      the gap)_
- [x] Activity card phase glyph _(text glyphs beside the spinner, matching
      the ApprovalGlyphs pattern: ✎ writing, ▶ running, ↻ processing;
      aria-labels "writing code"/"running code"/"processing result")_
- [x] Activity card status text _(this-turn `statusText` beats the generic
      fallbacks in `liveSummary`)_
- [x] Round header "Round {n}" → "{n}" _(activity-card.tsx roundLabel)_
- [x] Reducer/derivation unit tests _(agent-ui-reducer.test.ts: phase ladder,
      processing vs `return;` vs failed, this-turn statusText gating, pause
      settles idle live / keeps running steps live)_
- [x] Playwright mobile spec _(specs/mobile/live-status.spec.ts, passing in
      ~12s locally: intercepted/status model; "running" pinned by a
      withTunnel fetch the spec releases; "processing" pinned by
      llmRequestDebounceMs=4s; round-2 "waiting" pinned by gating the
      interceptor handler; settled card asserts bare "1"/"2" round headers.
      The chunk-level "writing" phase is asserted in unit tests only — the
      interceptor contract returns full text, word-split server-side, so its
      window can't be held open deterministically from a spec)_

## Assumptions made (Misha was AFK)

- "Status associated with this turn" = summary-updated folded at/after the
  live activity's start; the birth-inherited stale text stays for round
  headers (existing behavior, untouched) but does NOT replace the live
  summary text.
- Thinking keeps its existing "thinking…" text and gets **no** secondary icon
  (not in the requested list).
- The chat screen's pre-first-step "working…" row keeps no secondary icon
  (that's the default/queued state).
- Web/TUI feeds are out of scope; the derivation helper lives in packages/ui
  so they can adopt later.
- Glyphs are text characters (✎ ▶ ↻), not @expo/vector-icons — consistent
  with the card's existing ◷ ✓ ✗ approval glyphs.

## Implementation log

- Reducer: `summaryActivityUpdatedAtMs` fold field; `deriveAgentUiLiveStatus`;
  pause events now run `settleActivityAtBoundary` (idle live settles, running
  steps survive — matching the operator-pause-mid-request contract).
- Mobile: `reduceFeed` exposes `liveStatus` and counts "processing" as
  working; chat.tsx passes it to the live card only; card renders glyph +
  status text; round labels bare numbers.
- Spec discovery: the approvals-style isolate warm-up (`runScript`) journals
  onto the agent stream and renders as a stray second activity card — dropped
  it here (itx-side event waits bridge cold starts) and left a comment.
- Lint: middlewright(prefer-locator-waits) rewrote every
  `expect(locator).toBeVisible()` to `locator.waitFor()`.
