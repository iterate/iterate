---
status: in-progress
size: small
---

# Result tab: show what the agent actually saw

Follow-up from `tasks/codemode-script-preamble-followups.md` (second checklist item).

## Status summary

Done, pending re-review. Per Misha's feedback on the first cut ("only show it
this way when it's truncated"): the Result tab defaults to the agent-visible
render ONLY when that render is a transformed/truncated representation
(inline truncation, oversized spill with inferred type + preview). When the
agent saw the full result, the raw YAML view stays the default and the agent
view is one toggle away. Detection is structural (the untransformed render
embeds the exact stringified settlement verbatim; containment check), no
string-marker matching, degrades safely toward the agent view. Component
tests + live screenshots in the PR. Not done here: mobile's twin activity
card still shows only the raw result (possible follow-up).

## Problem

The agent feed's expanded activity rounds have a `Script | Result | Meta` tab bar
(`apps/os/src/components/agent-activity-rounds.tsx`). The Result tab renders its own
client-side view of the raw settlement: the result value re-serialized as YAML with its
own truncation ("This result is 81,313 characters as YAML. Showing the first 64 KB
without syntax highlighting.").

That view is unrelated to what the AGENT was shown. The agent-facing render is produced
server-side by `renderScriptSettlement`
(`apps/os/src/domains/agents/agent-processor-implementation.ts`): truncation at
`scriptResultHistoryLimit`, oversized results replaced by an inferred TS type + bounded
JSON preview + a `results[0].load(itx)` recipe, spill-file pointers, failure text with
recovery-tool hints. It is appended to the stream as a developer
`events.iterate.com/agents/context-added` event with
`payload.actor = { type: "script", executionId }` and content starting
"Your script returned" / "Your script failed".

Direction: **the Result tab should be a representation of what the agent is actually
shown.** Keep the raw view reachable, but the agent's view is the default.

## Design

- The render already exists on the stream, so don't re-implement it client-side: query
  the local raw-event mirror (`useStreamQuery`, same pattern as the Meta tab's
  `RoundMetaWithPrompt`) for the `agents/context-added` event whose
  `payload.actor.type = 'script'` and `payload.actor.executionId` matches the round's
  code step. The query only runs while the Result tab is mounted (inactive base-ui tab
  panels unmount), and it's live — if the render event lands after the settlement (it's
  appended in a blocked async section), the tab picks it up when it arrives.
- Render the event's `payload.content` through `MessageResponse`
  (`packages/ui/src/components/ai-elements/message.tsx`, streamdown) with
  `mode="static"` / `parseIncompleteMarkdown={false}` — the same markdown+fenced-code
  renderer settled assistant messages use. The text is bounded server-side, so no
  client-side truncation mechanism is needed on this path.
- Keep the raw view: a small toggle inside the Result tab switches between the agent
  view (default) and the existing raw YAML/error rendering. The full raw settlement
  also stays one click away via the existing "Execution trace" sheet.
- Fallbacks to the current raw view: no `database` prop, mirror query errored, or no
  render event found (old streams predating `renderScriptSettlement`, renders for
  non-agent executions, or a succeeded run with `result === undefined` which produces
  no render event — though that case doesn't offer a Result tab anyway).

## Assumptions (made while fleshing out, Misha AFK)

- Scope is the FEED Result tab (`agent-activity-rounds.tsx`) — the string observed live
  is from there. The execution-trace sheet
  (`script-execution-inspector-panel.tsx`) keeps its raw Result tab as-is: it *is* the
  raw capability the feed links to.
- Mobile's structural twin (`apps/mobile/src/components/activity-card.tsx`) is NOT
  updated in this PR — noted as a possible follow-up so the surfaces don't silently
  diverge.
- Correlation by `payload.actor.executionId` (exact match) is sufficient; no offset
  proximity heuristics needed.
- `useState` for the in-tab agent/raw toggle matches the file's existing tab-selection
  pattern (CLAUDE.md's "almost never useState" yields to local UI toggle convention
  already established in this file).

## Checklist

- [x] Pass `database` down to `RoundResult`; query the mirror for the script's
      `agents/context-added` render event _`AgentRenderedRoundResult` in
      apps/os/src/components/agent-activity-rounds.tsx, same `useStreamQuery` pattern
      as the Meta tab_
- [x] Render the agent-visible markdown via `MessageResponse` as the DEFAULT Result
      view _data-testid="script-result-agent-view"; MessageResponse mode="static",
      like settled assistant messages_
- [x] Keep the raw YAML/error view behind a toggle, and as the fallback when no render
      event exists _"Show raw result" / "Show agent view" ghost button; raw body
      extracted unchanged into `RawRoundResult` (+ data-testid="script-result-raw")_
- [x] Component test following `agent-feed.test.tsx` patterns (fake
      `StreamBrowserDatabase` with a canned query handle)
      _apps/os/src/components/agent-activity-rounds.test.tsx — createRoot + act +
      disposable mount fixture; the fake db is just `{ query: () => handle }`_
- [x] Screenshot for the PR body (local dev or spec tooling); if too painful, say so in
      the PR body _live capture: local dev + minted session (`pnpm getin`), real agent
      conversation running a fibonacci script; uploaded via gh image_

## Implementation log

- Worktree `result-tab-agent-view` off origin/main (34c7de98a).
- Located current truncation code: `RoundResult` in
  `apps/os/src/components/agent-activity-rounds.tsx` (feed) — the inspector panel has a
  separate, deliberately-raw equivalent.
- Confirmed the reducer (`packages/ui/src/components/events/agent-ui-reducer.ts`) drops
  script-actor context-added events ("model input, not another bubble") — so the mirror
  query approach avoids growing always-in-memory reducer state with big rendered text.
- Verified live on local dev: agent ran a script, Result tab showed
  "Your script returned:" + fenced JSON + preamble note, toggle flipped to the raw
  YAML view and back.
- Note for jsdom tests: `SourceCodeBlock`/CodeMirror is a lazy client-only chunk that
  never paints in jsdom, so raw-view assertions target `script-result-raw` rather than
  highlighted YAML text.
- Review feedback round (Misha): "I don't love either, let's only show it this way
  when it's truncated." → conditional default via `renderIsTransformed`: containment
  of the exact stringified settlement (string result as-is, else
  `JSON.stringify(value, null, 2)`, failure error text) in the render content.
  Chose structural containment over the marker strings emitted by
  `truncateScriptResult`/`renderOversizedJsonResult`/`rawTextSpillNotice` — no
  coupling to notice wording, and a server stringification change degrades toward
  the agent view (never claims the agent saw everything when it didn't).
- Tests updated: full-result render → raw default with agent view a toggle away;
  truncated render → agent view default with raw a toggle away; fallbacks unchanged.
