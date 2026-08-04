---
status: in-progress
size: medium
branch: os-agent-feed-round-meta
---

# apps/os: show the LLM request with its round, like mobile's Meta tab

> **Status summary**: spec fleshed out, implementation starting. Main pieces:
> round grouping in the web feed, per-round tabs (Script | Result | Meta),
> Meta tab with YAML stats + replayed prompt. Nothing implemented yet.

Follow-up from #2398 (merged). Misha (2026-08-04, with screenshot of a 9-round
agent turn in the os feed):

> where you see the model/llm request info above each "Ran code", let's move
> that into a "Meta" tab just like we did on apps/mobile. In fact, make the
> "Ran code" thing work just like in Mobile: "Ran code 9x" is expandable,
> expanding shows "Round 1", "Round 2", "Round 3" etc. Clicking "Round N"
> shows the same tabs as we have on mobile (`Script | Approvals | Result |
> Meta` I think, with some of them being optional). we don't need to use a
> shared component for now, but maybe make the structure similar across the
> two of them and use comments to point to each other so future agents
> understand that it's worth asking if I want to keep them in sync in future
> if changes are made

In apps/os today, an expanded activity is a flat rail of step buttons — one
per llm request ("✦ openai/gpt-5.6-terra · 4.8k → 138 tok · 11.9 s") and one
per code run ("Ran code · Started 14:52:33 · 5.7 s") — each opening a separate
URL-backed inspector sheet. Mobile's activity card (#2398) instead groups the
steps into ROUNDS (the llm step that writes a script + the code step that runs
it), each a tabbed view `Script | Approvals | Result | Meta`.

## Checklist

- [ ] Promote `groupActivityRounds` from `apps/mobile/src/lib/feed.ts` into
      the shared `agent-ui-reducer` (packages/ui) so both surfaces group
      steps identically; mobile imports it from there
- [ ] apps/os `agent-feed.tsx`: expanded activity renders "Round 1..N" toggle
      rows instead of the flat llm/code step buttons
- [ ] Expanding a round shows tabs `Script | Result | Meta` (structure
      mirrors mobile's `CodeStepTabs`; cross-pointing comments in both files)
- [ ] Script tab: the round's submitted code in the shared `SourceCodeBlock`
- [ ] Result tab (only once the run settled with a value or error): returned
      value via `SerializedObjectCodeBlock` (+ oversized-preview guard),
      error text
- [ ] Meta tab: one YAML doc (same shape as mobile's `metaYaml` — llm model /
      duration / tokens / outcome, code duration, replayed `prompt:`)
      rendered in `SourceCodeBlock` yaml; prompt replayed with
      `replayLlmRequest` over the events table (same query shape as
      `llm-request-inspector-panel.tsx`), fetched only while Meta is open
- [ ] Keep the `?llmRequest` / script-execution sheets as deep links: "Open
      full trace" affordances from the tabs; per-step inspector buttons go
      away with the flat rail
- [ ] Live activity (`AgentLiveActivity`): settled rounds render as round
      rows; the currently-streaming llm step keeps `LiveStepStream`
- [ ] Update `agent-feed.test.tsx` for the rounds layout + new tests for tab
      content (Meta yaml, optional Result)

## Assumptions (made while Misha was AFK-ish; flag if wrong)

- **No Approvals tab on web for now.** Mobile's Approvals tab derives batches
  from root-stream approval events, which the os web feed doesn't have wired
  into `StreamFeedView`. The tab list keeps a commented slot so the surfaces
  stay structurally parallel; wiring approvals into the web feed is its own
  task.
- **Rounds default collapsed** when an activity has several; a single-round
  activity auto-expands its round (the user already clicked once to expand
  the activity).
- **The standalone `?llmRequest` sheet stays** (deep-linkable, live streaming
  overlay, markdown mode, copy button — richer than the inline Meta). The
  inline Meta tab is the everyday path; the sheet is the full trace. Same for
  the script-execution sheet.
- **No shared component** between web and mobile (per the ask) — a shared
  *pure grouping function* in agent-ui-reducer is fine (it's data, not UI,
  and the reducer package is already the shared home for exactly this kind
  of interpretation).

## Implementation log

(notes appended during implementation)
