---
status: done
size: medium
branch: chat-snippet-stream-preview
base: itx-chat-send-message-string
---

# Streamed sendMessage snippet → live chat-message preview

## Status summary

Done. The pure parser (`extractStreamingSendMessagePreview`) is
implemented with 17 hard unit tests (token-by-token prefix simulation), and
wired into `LiveStepStream` in `agent-feed.tsx` — the preview renders as an
in-flight assistant message bubble, and the streaming code block is
show-only-when-needed: hidden while the message literal streams (the same
words would show twice), held back through trailing punctuation after the
close (`");` + `}` would flash it in just to end the turn), and shown — with
the leading call redacted to `itx.chat.sendMessage(...)` — only once a word
character streams in after the close. The settled "Ran code" view shows the
unmodified script. A demo recording of a real streaming turn is in the PR
body. PR 2 of 2, stacked on `itx-chat-send-message-string` (#1735) — depends
on the plain-string `itx.chat.sendMessage("...")` form landing first.

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

- Strip a leading ` ```ts`/` ``` `fence and `async (itx) => {`-style
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
- (Design note from review) `sendMessage` may rarely take options as a SECOND
  argument — `itx.chat.sendMessage("hello", { whatever: 123 })`. A `,` after
  the closed literal is well-formed, not malformed: the preview stays the
  first string literal, both mid-stream (`sendMessage("hello", { wha`) and
  complete.

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

- [x] Pure `extractStreamingSendMessagePreview` helper + colocated unit tests
      (mid-stream truncation cases, escapes, Promise.all, template literals,
      comments, non-first-statement bails, object-form `{ message:` bails)
      _`apps/os/src/components/streaming-send-message-preview.ts` + `.test.ts`
      (17 tests; `expectPreviewOverEveryPrefix` simulates token-by-token
      growth over every prefix; second-options-arg cases included)_
- [x] Wire into the live step rendering in `agent-feed.tsx` (preview styled as
      an in-flight agent chat message with streaming affordance)
      _`LiveStepStream` derives the preview from `step.responseText` via
      `useMemo`; `StreamingSendMessagePreview` renders a
      `Message from="assistant"` bubble with the shared `StreamingCursor`_
- [x] Show the code block only when "needed" (Misha's review comment): hide it
      while the message literal streams, buffer through trailing punctuation
      after the close, then show it with the message redacted to
      `itx.chat.sendMessage(...)`
      _parser now returns `{ message, literalClosed, redactedCode }`;
      `redactedCode` goes non-null only once a `\w` character streams in
      after the closing quote, and IS the display code (literal spliced out);
      `LiveStepStream` renders `StreamingCodeBlock` from it — settled "Ran
      code" rows are untouched_
- [x] Real `web-message-sent` event cleanly supersedes the preview (no
      double-render moment worth worrying about; verify visually)
      _by construction: the preview only renders for the live *streaming* LLM
      step (`LiveStepStream` is only mounted for running llm steps), and the
      real message row lands after the script executes — see log for why the
      running-code phase deliberately gets no preview_
- [x] Screenshot / short recording in the PR body
      _done on request — GIF of a real agent turn against local dev in the PR
      body's "Demo" section (user-attachments asset 879eaf14); recorded with
      the browser gif recorder, uploaded via GitHub's attachment flow_
- [x] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` green
      _run from the worktree root; live-env e2e lanes not run (need a running
      environment)_

## Implementation log

- Parser lives in `apps/os/src/components/streaming-send-message-preview.ts`,
  colocated with the feed like `agent-ui-reducer.test.ts`. Hand-rolled cursor
  scan (no regex-only tricks for the literal): strip fence → trivia →
  `async (itx) => {` opener → optional `const [, x] = await Promise.all([`
  opener → `(await )itx.chat.sendMessage(` head → read the (possibly
  unclosed) string literal with escape processing.
- Mid-stream "hold" semantics: a half-streamed escape (dangling `\`, partial
  `\u{1F6`) or a backtick `$` that might become `${` stops the preview just
  _before_ it; the next chunk re-derives the whole thing and picks the
  characters back up. So over successive prefixes the preview is always a
  leading slice of the final message (asserted for every prefix in tests).
- `,` after the closed literal is accepted (second options argument, per
  design note); `+` or anything else after it drops the preview.
- Also accepted an assignment prefix on the Promise.all form
  (`const [, inbox] = await Promise.all([`) — that's the exact shape the
  contract prompt teaches, so bare `await Promise.all([` alone would have
  missed the main case.
- Rendering: preview only attaches to the _streaming LLM step's_
  `responseText` (the token-by-token generation this task is about).
  `LiveStepStream`'s `step.kind === "code"` branch is currently unreachable
  (AgentLiveActivity routes running code steps to collapsed
  `AgentActivityStep` rows) and deliberately gets no preview: while a script
  is _executing_, the real `web-message-sent` may already have landed as a
  settled row, so a preview there would double-render the message for
  long-running scripts.
- Note the brief gap: streaming ends → preview unmounts → script runs →
  real message lands. sendMessage is the first statement so the gap is small;
  judged acceptable vs. the duplicate-bubble risk above.
- oxfmt reformatted a nested-backtick line in this task file; the sibling
  task file (`itx-chat-send-message-string.md`) also got reformatted but was
  reverted here — it belongs to #1735.
- Review round (3 comments on the PR, all addressed):
  1. the render gate is now `looksLikeCode(...) || preview != null` — the
     parser accepts bare `itx.chat.sendMessage("...`-style forms the
     `CODE_START_PATTERN` heuristic misses, and a non-null preview is itself
     proof the text is code;
  2. documented + pinned (with a `distinctPreviews` test) that a preview can
     appear then vanish when a later token invalidates it (`"hi" + name`,
     `` `hi ${name}` ``) — bail-to-null is deliberate;
  3. the preview bubble now renders through `MessageResponse` in streaming
     markdown mode, so it's typographically identical to the settled
     `web-message-sent` row it hands off to (cursor blinks on its own line —
     streamdown owns the markdown DOM).
- Follow-up (Misha, top-level PR comment): only show the code block when we
  "need" to — seeing the message twice (bubble + the same words inside the
  streaming code block) was confusing, and the block shouldn't flash in just
  to render `");` + `}` before the turn ends. The parser now returns
  `{ message, literalClosed, redactedCode } | null`:
  1. while the literal is still streaming, `LiveStepStream` renders ONLY the
     bubble and suppresses `StreamingCodeBlock`;
  2. after the closing quote, the block stays hidden through trailing
     punctuation/whitespace (`");`, newlines, `}`, the closing fence) and
     only appears once a `\w` character streams in after the close — real
     further code is coming (`redactedCode` non-null is exactly that signal);
  3. when it appears, the block renders `redactedCode` — the partial snippet
     with the message literal spliced out to `...`, reading
     `itx.chat.sendMessage(...)` — the message text lives only in the bubble.
     Display-only for the live stream; the settled "Ran code" expandable
     shows the unmodified js.
     Edge cases decided:
  - Preview bails-to-null mid-stream (`"hi" + name`, `` `hi ${` ``): the
    preview-branch condition goes false the same render, so the plain code
    block (or, for bare non-`looksLikeCode` forms, the pre-existing prose
    fallback) appears immediately — never a blank step.
  - Bare `itx.chat.sendMessage("...` forms where `looksLikeCode()` is false:
    preview-only while streaming is correct anyway; once further code
    streams after the close, the `looksLikeCode(...) || preview != null`
    gate still routes to the code branch and the redacted block appears —
    even though the heuristic alone would have called it prose.
  - An options second argument (`sendMessage("hello", { wha…`) counts as
    further code (word characters), so the block shows as
    `itx.chat.sendMessage(..., { wha` while the options stream — only the
    message literal is redacted, and only the FIRST one (a later
    `sendMessage("another")` in the snippet keeps its literal).
    Tests updated for the new shape (every-prefix helper now takes the
    expected `finalRedactedCode` and asserts the block only surfaces after
    the close, grows monotonically, and never hides again; `distinctPreviews`
    captures the `false → true` flip and the vanish sequences; new
    fence-to-fence test pins that a message-only turn never shows a block).
- Demo recording (post-review): ran the OS dev server locally, drove a real
  agent turn in the browser ("how many lines does AGENTS.md have? message me
  first…"), and verified the feature end-to-end visually — the preview bubble
  streams above the amber code block (markdown `.ts`/`AGENTS.md` inline code
  renders via MessageResponse) and hands off to the settled row when the
  script runs. Captured with the claude-in-chrome gif recorder. Gotchas for
  next time: the recorder only keeps action-keyed frames (screenshots taken
  while recording are mostly dropped — use no-op scroll-down ticks at the
  feed bottom as frame generators), and the feed only follows streaming when
  pinned to the bottom. Upload used gif export's drag/drop-to-coordinate
  onto the PR-body textarea (file_upload rejects host paths); the drop
  inserts at the pointer so the body was then rewritten cleanly via gh.
- Demo re-record for the show-code-only-when-needed follow-up: verified
  end-to-end against local dev (minted session, fresh project, real agent
  turns) — the bubble streams ALONE while the literal is open, then the
  amber block appears below it reading `itx.chat.sendMessage(...)` once the
  next statement's word characters stream in, then the settled rows take
  over. Captured 20+ frame recordings twice, but the upload leg failed 3×
  (extension disconnect mid-batch; `download: true` exports report success
  but no file ever lands on disk; export drag/drop-to-coordinate onto the
  PR-body textarea failed twice with "Failed to upload GIF to page" —
  also note the standalone gif_creator tool schema strips `coordinate`, it
  only goes through via browser_batch). Left the original GIF in the PR
  body with an explicit note that it predates this change.
