---
status: needs-grilling
size: medium
---

# Eval: agent discovers runtime-provided capabilities

## Summary (human skim)

First eval. Guards behavior: agent must find + use capability mounted
mid-session, not claim "can't do". Guards prompt nudge in
`agent-processor-contract.ts` ("before saying you cannot, `__describe` first").
No eval harness exist yet -> this task also bootstraps one. Not started.

_(written caveman-style, deliberate — see task ask)_

## Why

Bug seen for real: user share machine via `!share` (live cap `usersMachine`).
Cap mounted fine, invocable fine. But agent say "I can only read project repo /
sandbox, not your machine" -> gave up. Root cause: system prompt static. Dynamic
mounts invisible unless agent call `itx.__describe()`. Agent no reason to look ->
no look.

Fixed prompt: nudge agent "surface CHANGES AT RUNTIME, `__describe` before you
say no". Nudge is prompt-eng -> LLM may ignore -> need eval to measure it hold.

## Scenario

1. Spin test project + agent (reuse e2e itx harness — `apps/os/e2e/vitest/itx.e2e.test.ts` pattern: `provideCapability` from test conn, drive agent via `agent.ask`).
2. Mid-session, provide live cap at novel path NOT in static prompt. Distinct method + distinct return. Example: `provideCapability({ type: "live", path: ["secretVault"], capability: { reveal: () => "MAGIC-TOKEN-42" }, instructions: "...", types: "..." })`.
3. Ask agent natural language, DO NOT name method/path: "what's the magic token?".
4. Assert:
   - agent ran `itx.__describe()` (or `itx.capabilityHost.__describe()`) — check script-execution events on agent stream.
   - agent invoked `secretVault.reveal`.
   - final reply contain `MAGIC-TOKEN-42`.
   - agent did NOT reply "can't / don't have access" before checking.

## Open questions (grill user)

- Eval != test. LLM nondet. Measure pass RATE (run N=?, threshold?) or single-shot + one retry?
- Which model? pin cheap fast model for eval lane, or real prod model?
- Where live? new `apps/os/e2e/evals/` lane? separate `pnpm eval` script? CI gating or manual/nightly?
- Scoring: hard assert (regex/stream check) or LLM-judge? Prefer hard assert here — deterministic-ish signals available (stream events, token string).
- Cost/time budget per eval run (agent turns hit real LLM, slow). Cap turns.

## Checklist

- [ ] decide harness shape (answer open questions w/ user)
- [ ] bootstrap eval lane (dir + runner + one `defineEval`-ish helper OR plain e2e test w/ pass-rate loop)
- [ ] impl scenario: provide novel cap mid-session, ask indirect, assert discover+use
- [ ] wire run command (`pnpm eval` or similar) + doc in testing docs
- [ ] confirm eval FAILS w/o prompt nudge, PASSES with it (proves it guards the fix)

## Notes

- Related: `[[chat-share-machine-capability]]` (the `!share` POC that exposed this).
- Prompt nudge already landed on branch `chat-share-machine-capability`
  (`agent-processor-contract.ts`, DISCOVERING THE SURFACE section).
- Cap discovery primitive already exist: `itx.__describe().capabilities` = full
  inventory incl runtime mounts. Eval check agent USE it, not that it exist.
