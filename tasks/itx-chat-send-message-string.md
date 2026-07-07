---
status: in-progress
size: medium
branch: itx-chat-send-message-string
---

# itx.chat.sendMessage takes a plain string

## Status summary

Task fleshed out, implementation not started yet. This is PR 1 of 2 — a
follow-up PR (`chat-snippet-stream-preview`) will build a streaming preview UI
on top of the string form.

## Ask (verbatim-ish)

> i want `itx.chat.sendMessage({ message: "Checking your email now..." })` to
> become `itx.chat.sendMessage("Checking your email now...")`. Lots of
> examples, docs, and tests will need to change!

## Why

The `{ message }` wrapper is ceremony: the method takes exactly one meaningful
value. The plain-string form is shorter, cheaper for the LLM to generate
token-by-token, and (crucially, for the follow-up PR) makes it trivial to
extract a partial message from a *streaming, not-yet-complete* snippet like
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

## Checklist

- [ ] `AgentChatRpcTarget.sendMessage` in `apps/os/src/rpc-targets.ts` accepts
      `string | { message: string }`; keep the non-empty-message error
- [ ] `__describe` instructions for the chat target mention `sendMessage(message)`
- [ ] Agent contract prompt (`apps/os/src/domains/agents/agent-processor-contract.ts`)
      — all examples and guidance use the string form
- [ ] Project processor prompts (`apps/os/src/domains/projects/project-processor-implementation.ts`)
      — MCP reply guidance uses the string form
- [ ] `apps/os/project-repo-template/sdk.ts` chat interface types the string form
      (union with the legacy object form)
- [ ] Regenerate: `itx-api.generated.ts`, `types-source.generated.ts`,
      `project-repo-template.generated.ts` (freshness tests enforce these)
- [ ] Docs: `apps/os/src/README.md`, `apps/os/docs/agent-smoke-testing.md`,
      `apps/os/docs/debugging-streams.md` (only if it uses the old form)
- [ ] Tests: `apps/os/src/domains/agents/agent-processors.test.ts`,
      `apps/os/e2e/vitest/itx.e2e.test.ts` use the string form; add coverage
      that BOTH forms work at the rpc-target level (back-compat is load-bearing)
- [ ] `apps/os/src/itx/itx-react.tsx` doc-comment examples (they say
      `sendMessage({ text })` which was already wrong — fix to string form)
- [ ] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` green

## Implementation log

(append notes here as work happens)
