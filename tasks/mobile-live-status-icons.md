---
status: in-progress
size: medium
branch: mobile-live-status
---

# Mobile: live status icons + agent-set status text in the activity card

## Status summary

Fleshed-out spec, implementation not started yet.

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
  (`Object.hasOwn(settlement, "result")`, reducer ~line 1455). Codemode
  contract: returning a value ⇒ another LLM round follows; `return;` ⇒ turn
  over. So "processing" = live activity, no running step, last step is a
  done code step (durable outcome) whose settlement carried a result.
- The generic texts live in `liveSummary()` in activity-card.tsx; the mobile
  fold entry point is `reduceFeed` in `apps/mobile/src/lib/feed.ts`.
- Today `reduceFeed` marks the activity done the moment no step is running —
  so the mid-turn gap (script settled with value → next request) shows a
  brief flicker to the settled card. Keeping the card live through that gap
  is what makes the "processing" icon visible at all.

## Checklist

- [ ] Phase derivation helper (pure, exported next to the reducer in
      `packages/ui` so web/TUI can adopt later): live activity →
      `"queued" | "thinking" | "writing" | "running" | "processing"`.
      "processing" per the definition above, durable outcomes only
      (`outcomeSource === "durable"`).
- [ ] Track "status was set this turn" in the reducer projection (e.g. stamp
      the fold state with the timestamp/offset of the last summary-updated
      and compare against `live.startedAtMs`). Client-side fold field only —
      not a new event.
- [ ] Mobile `reduceFeed`: keep the activity live/working through the
      "processing" gap (last step = done code step with result value).
      Guard against a stuck spinner: any terminal/pausing fact
      (`agent/paused`, stream paused, a following llm settle, queued user
      message flush) must still settle the card as today.
- [ ] Activity card summary row: spinner stays; add the phase glyph
      (consistent with the existing text-glyph pattern in `ApprovalGlyphs` —
      e.g. ✎ / ▶ / ⋯ — or Feather icons as in repo.tsx if glyphs render
      poorly; pick one, keep it subtle).
- [ ] Activity card summary text: this-turn `summaryActivity` when present,
      else existing fallbacks.
- [ ] Round header: "Round {n}" → "{n}".
- [ ] Reducer/derivation unit tests (precedent:
      `apps/os/src/components/agent-ui-reducer.test.ts`).
- [ ] Playwright mobile spec (`specs/mobile/live-status.spec.ts`) driving an
      `intercepted/*` model via the forged-session/`itx.ai.intercept`
      machinery (pattern: `specs/mobile/approvals.spec.ts`,
      `docs/intercepted-models.md`): a script whose first line is the
      summary-updated append then holds on a spec-controlled egress echo →
      assert status text + running glyph; release → script returns a value →
      second round. Assert the states that can be held deterministically;
      don't build flaky waits around transient ones (chunk-level "writing"
      may be one — verify what the interceptor emits before asserting).

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

## Implementation log

(append as you go)
