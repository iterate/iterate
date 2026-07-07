---
status: in-progress
size: medium
branch: chat-snippet-stream-preview
base: itx-chat-send-message-string
---

# Streamed sendMessage snippet → live chat-message preview

## Status summary

Task fleshed out, implementation not started. PR 2 of 2, stacked on
`itx-chat-send-message-string` (#1735) — depends on the plain-string
`itx.chat.sendMessage("...")` form landing first.

## Ask (verbatim-ish)

> light pre-parsing on the snippets as they're being generated in the browser:
> iff the snippet starts with `itx.chat.sendMessage("blah blah` we could get a
> passable token-by-token preview message streaming into view. Detect an
> unclosed method call `itx.chat.sendMessage(` + opening quote, pretend there's
> a closing `")` to make it valid syntax, extract the quoted bit, and show it
> as the agent "message" while tokens stream (the sendMessage has NOT actually
> been called yet — it's fakery!). Also handle it inside a `Promise.all`, but
> otherwise only when it's the first statement.

## Where this lives

The live streaming code renders in `apps/os/src/components/agent-feed.tsx` —
`LiveStepStream` / `StreamingCodeBlock` show `step.code` / `step.responseText`
as it streams (state built by `agent-ui-reducer`). The preview is purely a
render-time derivation from the partial snippet text: no reducer/state
changes, no new events. When the script later actually runs and the real
`web-message-sent` event lands, the preview disappears (the step is no longer
live) and the real message row takes over.

## Sketch

A pure function, unit-tested hard, something like:

```ts
/** Extracts a best-effort preview message from a *partial* agent code snippet. */
export function extractStreamingSendMessagePreview(partialCode: string): string | null;
```

Rules (deliberately conservative — bail with `null` on anything else):

- Strip a leading ` ```ts`/```` ``` ````fence and `async (itx) => {`-style
  wrapper openers if present, plus leading comments/blank lines.
- Match when the first real statement is (optionally `await`)
  `itx.chat.sendMessage(` followed by a string literal — `"`, `'`, or
  backtick without `${` interpolation.
- The string may be unclosed (mid-stream): take everything after the opening
  quote up to end-of-input or the closing quote. Handle escaped quotes (`\"`)
  and process standard escapes (`\n`, `\\`, ...) so the preview reads clean.
- Also match as the first entry of `Promise.all([` (per the contract-prompt
  guidance that pairs a progress message with slow work) — i.e. optional
  `await Promise.all([` prefix before the `itx.chat.sendMessage(` call.
- Once the literal closes, stop extending the preview (later statements are
  NOT previewed); if the closed call turns out to be malformed, drop preview.

Rendering: while a live code step's snippet yields a preview, show it styled
like an agent chat message (the same look as a settled `web-message-sent`
row) with a subtle streaming/pending affordance (e.g. blinking cursor), above
or instead of the streaming code block — exact placement to taste, keep it
simple. It must be visually honest that it's in-progress.

## Assumptions (made while AFK — flag in review if wrong)

- Preview only for the FIRST statement (optionally inside `Promise.all([`) —
  matches the ask; later sendMessage calls in a snippet get no preview.
- Template literals with `${...}` are not previewed (can't know the value).
- The streaming code block still renders (collapsed/less prominent is fine);
  the preview supplements rather than hides what the agent is doing.
- No server/reducer changes; pure view-layer derivation.

## Checklist

- [ ] Pure `extractStreamingSendMessagePreview` helper + colocated unit tests
      (mid-stream truncation cases, escapes, Promise.all, template literals,
      comments, non-first-statement bails, object-form `{ message:` bails)
- [ ] Wire into the live step rendering in `agent-feed.tsx` (preview styled as
      an in-flight agent chat message with streaming affordance)
- [ ] Real `web-message-sent` event cleanly supersedes the preview (no
      double-render moment worth worrying about; verify visually)
- [ ] Screenshot / short recording in the PR body
- [ ] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` green

## Implementation log

(append notes here as work happens)
