---
status: ready
size: small
---

# Approvals screen: show what the thread was doing when the batch was born

## Status summary

Implemented, then reworked twice on Misha's review: the context line shows
the thread's agent-maintained STATUS (`agent/summary-updated`, folded by
`threadContextForScriptRun` in `apps/mobile/src/lib/chat.ts`) in full —
no fallback: statusless threads get no line (round 3 dropped the
last-message fallback entirely). Tappable line on agent-born batch cards,
queue and history alike; the spec asserts the full status text and the
deep-link. Nothing outstanding beyond PR review. Split out of #2339's task
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
- [x] Rework (Misha, round 2): show the thread's STATUS, not the truncated
      last message — _`threadContextForScriptRun` folds `agent/summary-updated`
      (independent title/activity fields, explicit-null clears) through the
      run's own `script-run-settled` event; the card shows the status IN FULL
      (wraps, never clipped); the spec's scripts set status like a real agent
      turn and the screen act asserts both cards' full text by equality;
      video re-recorded_
- [x] Simplify (Misha, round 3): no status, no line — _last-message fallback
      and name-only form deleted (`lastVisibleMessageAtOrBefore` gone); the
      fetch narrows to summary-updated + script-run-settled, which getEvents
      filters in SQL before the page limit, so the read is O(status events);
      unit test pins the setStatus-then-held-fetch shape (unsettled run →
      status shows)_
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
- Round-2 rework (Misha: the truncated "you: /script con…" line is useless;
  show the STATUS, set via `itx.agent.append` like an agent would, in full):
  - Bound decision: a status the script sets lands AFTER
    `scriptRunRequestedEventOffset` (same stream, later offset), so an
    offset-at-or-before fold would exclude exactly the status the run set.
    The fold's upper bound is instead the run's own `script-run-settled`
    event (matched by `executionId`; no bound while unsettled) — single
    stream, no cross-stream clock comparison, and "this run's status"
    includes what the script wrote before (or after) its held fetch, while
    a later turn's status is excluded.
  - Fallback decision: threads with no summary events fall back to the last
    visible message at-or-before the run request, one-lined (a user's ask is
    still better context than nothing); name-only when the thread is empty.
    The full-text no-clip guarantee applies to the status form only.
  - The spec's inter-lane guard became "run 1 settled" (was "narration
    landed"): settlement closes batch 1's fold window, so lane 2's status
    appends can never leak into the approve card's context.
- Round-3 simplify (Misha: "fallback is null — just don't show anything if
  there's no status", plus an efficiency question):
  - Fallback deleted. `threadContextForScriptRun` returns
    `{ title, activity } | null`; the card renders no line for statusless
    threads, and while the fetch is pending or failed — one render form.
  - Efficiency answer (verified in `stream-storage.ts` `getRangeSized`): the
    `eventTypes` filter is applied in SQL inside the page subquery, BEFORE
    `limit`, and event bodies are only joined for selected offsets — so a
    filtered read never burns pages on skipped events. Narrowed to the two
    status-fold types, the read is O(status events) per thread: one ~empty
    page for any realistic thread. The only linear-in-thread cost is
    SQLite's internal metadata index walk inside the DO — no RPC, no bodies.
    Not RBAR.
  - Misha's sanity check confirmed and pinned by unit test: `setStatus(...);
    fetch(...)` with the fetch parked at the door → no settlement yet → the
    fold has no upper bound and the run's own status shows on the card while
    the batch is held.
  - Video NOT re-recorded: the happy path it shows (full status on both
    cards, deep-link tap) is unchanged by the fallback removal.
- Review-bot fixes after ready-for-review:
  - AI-linter explain-type-cast threads: the two payload casts in
    `threadContextForScriptRun` got the approvals.ts treatment (cast to the
    field subset touched + per-field runtime guards; no schemas — mobile
    keeps zod out of this boundary). Settle lookup is equality against a
    known executionId (malformed = never matches); title/activity accept
    string-or-null only, so malformed fields preserve rather than clear.
  - Bugbot "premature null cached forever": agents Promise.all the status
    append with the work, so the card's fetch can run before the status
    lands. `threadContextForScriptRun` now returns `{ settled, status }` —
    settled (the run's own settle event was in view) closes the fold window
    and makes the result immutable. The query caches forever only then;
    unsettled results get staleTime/refetchInterval of 5s until settlement.
    Unit test pins provisional null (unsettled) vs immutable null (settled).
    The spec cannot pin this race deterministically (its scripts await the
    status append before the burst, and the screen is visited only after
    settlement), so the conditional staleness is the fix, unforced.
