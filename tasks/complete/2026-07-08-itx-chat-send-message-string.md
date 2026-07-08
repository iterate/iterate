---
status: done
size: medium
branch: itx-chat-send-message-string
---

# itx.chat.sendMessage takes a plain string

## Status summary

Implementation complete: runtime accepts both forms (options ride in a second
argument), all prompts, docs, examples, and tests use the plain-string form,
generated files regenerated, and the e2e project-tool test covers both call
forms — verified against a local dev server. Remaining: full e2e lane in CI,
and human review. This is PR 1 of 2 — a follow-up PR
(`chat-snippet-stream-preview`) will build a streaming preview UI on top of
the string form.

## Ask (verbatim-ish)

> i want `itx.chat.sendMessage({ message: "Checking your email now..." })` to
> become `itx.chat.sendMessage("Checking your email now...")`. Lots of
> examples, docs, and tests will need to change!

## Why

The `{ message }` wrapper is ceremony: the method takes exactly one meaningful
value. The plain-string form is shorter, cheaper for the LLM to generate
token-by-token, and (crucially, for the follow-up PR) makes it trivial to
extract a partial message from a _streaming, not-yet-complete_ snippet like
`itx.chat.sendMessage("Checking your ema` — a string literal in argument
position is much easier to pre-parse than an object literal.

## Assumptions (made while AFK — flag in review if wrong)

- **Back-compat:** live agents have conversation history full of
  `sendMessage({ message })` calls, and models imitate history. So the runtime
  keeps accepting the legacy object form (`string | { message: string }`),
  while every doc, prompt, example, and test moves to the string form. The
  legacy form is undocumented — a code comment explains why it's kept.
- The MCP-scope prompt and agent contract prompt examples all switch to the
  string form, including the `Promise.all([itx.chat.sendMessage("..."), ...])`
  progress-update guidance.
- `agent.sendMessage(message: string)` (user→agent direction, on
  `AgentRpcTarget`) already takes a plain string and is untouched.
- **Options are a second argument (Misha, mid-implementation):** anything
  beyond the message itself rides in an optional second object arg —
  `itx.chat.sendMessage("hello", { files: [...] })` — never folded back into
  an object first arg. The existing options-like field (`files`) moved there.
  The legacy `{ message, files? }` object form is back-compat only, not the
  home for future options. `AgentChatSendOptions` in `types.ts` is the second
  arg's type.

## Checklist

- [x] `AgentChatRpcTarget.sendMessage` in `apps/os/src/rpc-targets.ts` accepts
      `string | { message: string }`; keep the non-empty-message error
      _rest-params over `Parameters<AgentChat["sendMessage"]>` (the
      `mechanical-class-impl` lint rule mandates that shape); normalizes
      string/legacy-object to one input, trims, keeps the non-empty error_
- [x] `__describe` instructions for the chat target mention `sendMessage(message)`
      _now reads `sendMessage(message, { files? })` with "message is a plain
      string" spelled out_
- [x] Agent contract prompt (`apps/os/src/domains/agents/agent-processor-contract.ts`)
      — all examples and guidance use the string form
      _all 7 mentions switched, incl. Promise.all progress guidance and the
      files example, which becomes `sendMessage("Here you go!", { files })`_
- [x] Project processor prompts (`apps/os/src/domains/projects/project-processor-implementation.ts`)
      — MCP reply guidance uses the string form
      _`await itx.chat.sendMessage(message)` in the MCP reply-exactly-once line_
- [x] `apps/os/project-repo-template/sdk.ts` chat interface types the string form
      (union with the legacy object form)
      _mirrors types.ts: `sendMessage(message: string | { message; files? },
options?: AgentChatSendOptions)`; also gained the previously-missing
      files surface_
- [x] Regenerate: ~~`itx-api.generated.ts`~~, `types-source.generated.ts`,
      `project-repo-template.generated.ts` (freshness tests enforce these)
      _`pnpm generate:itx-types-source` + `pnpm lint --fix` (codegen preset);
      no `itx-api.generated.ts` exists in this repo — spec was mistaken_
- [x] Docs: `apps/os/src/README.md`, `apps/os/docs/agent-smoke-testing.md`,
      `apps/os/docs/debugging-streams.md` (only if it uses the old form)
      _README + smoke-testing updated; debugging-streams.md only says "via
      itx.chat.sendMessage" with no call shape — left alone_
- [x] Tests: `apps/os/src/domains/agents/agent-processors.test.ts`,
      `apps/os/e2e/vitest/itx.e2e.test.ts` use the string form; add coverage
      that BOTH forms work at the rpc-target level (back-compat is load-bearing)
      _system-prompt assertion + fixtures updated; the e2e "Agent scripts can
      send web-chat messages" test now sends one string-form and one
      legacy-object-form message and asserts both web-message-sent events_
- [x] `apps/os/src/itx/itx-react.tsx` doc-comment examples (they say
      `sendMessage({ text })` which was already wrong — fix to string form)
      _both doc comments now `itx.chat.sendMessage(text)`_
- [x] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` green
      _all green locally; additionally ran the three touched e2e tests
      (both-forms, replay, dynamic-worker) against a local dev server via
      `doppler run --config dev -- pnpm e2e run vitest/itx.e2e.test.ts -t ...`
      — all pass; the full e2e lane is left to CI_

## Implementation log

- 2026-07-07: Implemented the full rename. Design update from Misha landed
  mid-task: options are a SECOND argument (`sendMessage("hello", { files })`),
  not part of an object first arg — recorded under Assumptions. `files`
  (the only options-like field) moved accordingly; `AgentChatSendOptions`
  exported from `types.ts` (and mirrored in the template `sdk.ts`).
- Gotcha: `oxlint --fix` (the `mechanical-class-impl` rule) auto-rewrites the
  impl signature to `...[message, options]: Parameters<AgentChat["sendMessage"]>`
  and its autofix collided with my hand-written body once — if you touch this
  method, run lint before assuming the file is what you wrote.
- No `itx-api.generated.ts` in the repo (the task spec guessed wrong); the two
  real generated artifacts (`types-source.generated.ts`,
  `project-repo-template.generated.ts`) were regenerated by script/lint-fix.
- e2e back-compat coverage lives in `apps/os/e2e/vitest/itx.e2e.test.ts`
  ("Agent scripts can send web-chat messages (string and legacy object form)
  and call project tools") — exercises the real `AgentChatRpcTarget` through
  the script runner with both call forms.
- Review-pass follow-ups (2026-07-08): mixed-form calls
  (`sendMessage({ message }, { files })`) now honor the options instead of
  silently dropping them (object's own files win if both are given), and the
  e2e test grew coverage for `("msg", { files })` second-arg plumbing plus the
  mixed form, asserting the stored attachment records on the
  web-message-sent payload.

## Possible follow-up

- ~~Narrow the prompt-facing type surface if models keep emitting the object
  form~~ — moot: Misha asked for the runtime back-compat to be removed
  entirely (2026-07-08), so the union is gone from types, runtime, and
  prompts alike.
- 2026-07-08 (post-review): Misha: "Remove the runtime backcompat." Done —
  `sendMessage(message: string, options?: AgentChatSendOptions)` only. The
  legacy `{ message, files? }` object branch, its mixed-form merge logic, and
  the e2e legacy/mixed-form sends are all deleted; generated files
  regenerated. The earlier back-compat Assumption above is superseded.
