---
status: ready
size: small
---

# Approvals screen: show what the thread was doing when the batch was born

## Status summary

Spec committed, implementation not started. Split out of #2339's task
(`tasks/complete/2026-07-30-in-thread-approvals.md` › "thread-status line"),
which made the approvals screen mostly a cross-thread queue + history view.

## Ask (Misha, via #2339 follow-ups)

The approvals view should show the status of the thread at the time the
request was created — extra context now that in-thread dialogs handle the
live case and this screen is mostly queue + history. "What was this run even
doing?" should be answerable without opening the thread.

## Design

- A held batch's `streamContext` (kind `script-execution`) already carries
  `streamPath` and `scriptRunRequestedEventOffset`. For batches whose
  `streamPath` is an agent thread (`/agents/…`), the batch card gains one
  context line derived from the agent stream AT THAT MOMENT: the last visible
  user/assistant message at or before `scriptRunRequestedEventOffset`,
  truncated to one line, plus the thread name.
- Derivation is a pure helper in `apps/mobile/src/lib` (unit-testable): feed
  it the agent stream's visible-message events (the `reduceChatEvents`
  vocabulary from `lib/chat.ts`) and the offset, get back
  `{ role, text } | null`. The screen fetches events with react-query
  (`getEvents` on the agent stream filtered to the two visible-message types,
  offset-bounded if the API supports it, otherwise filter client-side) —
  no useEffect/useState.
- Tapping the context line (or the card) deep-links to the thread — the
  `agent-chat` route from #2339's notification destinations already lands
  there.
- Non-agent batches (scope holds, non-agent scripts) render unchanged.
- History entries (settled batches) get the same line — it is derived from
  immutable history, so it works identically for queue and history rows.

## Checklist

- [ ] Pure helper: last visible message at-or-before an offset (+ unit tests
      covering: message before, message after only, empty thread, exact-offset
      message)
- [ ] Approvals screen: context line on agent-thread batch cards (queue +
      history), react-query fetch, thread deep-link on tap
- [ ] Graceful when the agent stream fetch fails or is slow: card renders
      without the line, no spinner-blocking
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene

## Out of scope

- Web dashboard approvals surface
- Live status ("thread is currently working") — this line is a snapshot at
  request time, deliberately
- Any protocol/event changes — this is a pure read-side feature
