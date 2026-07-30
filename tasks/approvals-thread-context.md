---
status: ready
size: small
---

# Approvals screen: show what the thread was doing when the batch was born

## Status summary

Implemented. The pure helper (`lastVisibleMessageAtOrBefore` in
`apps/mobile/src/lib/chat.ts`) plus its unit tests landed first; the
approvals screen now renders a tappable thread-context line on every
agent-born batch card, queue and history alike. Nothing outstanding beyond
PR review. Split out of #2339's task
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

- [x] Pure helper: last visible message at-or-before an offset (+ unit tests
      covering: message before, message after only, empty thread, exact-offset
      message) — _`lastVisibleMessageAtOrBefore` in `lib/chat.ts` (reuses
      `reduceChatEvents`' vocabulary); six tests in `lib/chat.test.ts`, incl.
      one-line collapse + blank-message skip_
- [x] Approvals screen: context line on agent-thread batch cards (queue +
      history), react-query fetch, thread deep-link on tap — _`ThreadContextLine`
      in `approvals.tsx`, rendered by `BatchCard` for `script-execution`
      batches with an `/agents/…` streamPath; `getEvents` bounded with
      `beforeOffset`, paged, `staleTime: Infinity` (immutable history)_
- [x] Graceful when the agent stream fetch fails or is slow: card renders
      without the line, no spinner-blocking — _line renders immediately with
      just the tappable thread name; the message text is appended only when
      the fetch resolves; no pending/error branches block the card_
- [x] Playwright coverage + video (Misha's review ask on #2372) — _the
      mobile approvals spec now visits the approvals screen after both lanes
      settle, asserts the context line's text on both history cards, and taps
      it back into the thread; 3 consecutive passes; VIDEO_MODE recording
      captured for the PR body_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene —
      _all four green from the worktree root_

## Out of scope

- Web dashboard approvals surface
- Live status ("thread is currently working") — this line is a snapshot at
  request time, deliberately
- Any protocol/event changes — this is a pure read-side feature

## Implementation log

- Helper went into `lib/chat.ts` rather than a new module: it is pure
  chat-vocabulary logic and reuses `reduceChatEvents`, so the visible-message
  event types stay defined in exactly one file. Tests sit with the existing
  `chat.test.ts` suite and reuse its event fixtures.
- `getEvents` supports `beforeOffset` (exclusive upper bound), so the fetch
  is server-bounded to `scriptRunRequestedEventOffset + 1` and filtered to
  the two visible-message types; the queryFn still pages (afterOffset cursor,
  loop until empty page, same shape as `reconcileBacklog`) because a busy
  thread can exceed one page and only the last message matters.
- The line sits on the card surface (after the headline), not behind the
  details expander — so settled history rows, which start collapsed, show it
  too. Decision: the thread name renders synchronously from `streamPath`
  (`/agents/` prefix stripped, same convention as chat.tsx's title) and is
  tappable straight away; the `you:`/`agent:` message text joins it when the
  one-shot fetch lands. Slow/failed fetch = name-only line, never a spinner.
- Helper collapses whitespace to one line and skips blank messages — a
  visible message with no visible text would render an empty context line.
- ~~No playwright spec (per spec): the derivation is unit-tested, the wiring
  is a plain react-query read.~~ Misha asked for visible proof on the PR, so
  `specs/mobile/approvals.spec.ts` grew a final act: back out of the thread,
  drawer → Approvals, assert both settled cards' context lines
  (`<thread name> · you: /script const burst…`), tap one, land back in the
  thread. Two determinism fixes surfaced while writing it: (1) lane 1's
  narration is awaited before lane 2's command so the reject batch's context
  snapshot is always the command message; (2) that wait polls the protocol,
  not the DOM — the live activity card streams the script's code expanded,
  which contains the same "approve-me outcomes:" literal as the narration
  (getByText hit a strict-mode violation on exactly that).
