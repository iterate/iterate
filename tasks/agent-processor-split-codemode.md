---
status: in-progress
size: large
---

# Agent processor split + `<codemode>` response format experiment

> **Status summary** (for skimmers): phase 1 (pure refactor) done on branch
> `agent-processor-split` — nothing user-visible changed; all existing tests pass unmodified.
> Phase 2 (codemode-tag format + config template) is a stacked PR on top.

## Why

`AgentProcessor` (apps/os/src/domains/agents/agent-processor-implementation.ts) is one class doing
three jobs: turn orchestration, the LLM request, and parsing assistant output (one ```ts fence →
itx script; prose outside the fence is discarded).

End goal: an opt-in per-project experiment where the model responds with markdown + an embedded tag:

```
Good question! Let me look into it.

<codemode status="Checking your files">
const foo = await itx.doWhatever()
return { abc: foo.bar }
</codemode>
```

- prose outside the tag → sent to chat (what `itx.chat.sendMessage` does today)
- `status="..."` → replaces model-appended `agent/summary-updated` activity events
- tag body → runs as an itx script

Opt-in is delivered as a config-repo template on top of PR #2413 (`configs/` dir), so the
experiment lives "in user land" (prompt + opt-in are data in the project's config repo) and can
run long-lived on chosen projects.

Full approved plan with design rationale: see PR body / `~/.claude/plans/warm-watching-fern.md`
(decisions D1–D6). Key calls:

- **One registered processor, three internal components**; only the response-format component is a
  swappable strategy (`AgentResponseFormat` with opaque `id: string`; processor holds a
  `Record<string, AgentResponseFormat>` registry selected by `state.config.responseFormat`).
  Not three StreamProcessors: the parser's security gate and interrupt guard share reduced state
  with the LLM request component; separate processors would duplicate the reducer and require
  birth-event migration.
- **Swap mechanism**: `agent/configured` gains `responseFormat: "fenced-ts" | "codemode-tag"`
  (default `fenced-ts`); the template's worker flips it at agent creation + supersedes the keyed
  `agent/system-prompt` slot. First-turn race accepted (self-heals).
- **Prose delivery**: one `agents/web-message-sent` per response carrying `llmRequestOffset`;
  mirror handler skips marked events (raw assistant text is already in history).
- **status attr**: server-side `agent/summary-updated {activity}` appended before
  `script-run-requested` in the same batch.
- **Parsing**: line-anchored open/close tags (fence-incident lesson); bare bodies wrapped as
  `async (itx) => {...}`.
- **Prompt lives in the template**, synced into the keyed system-prompt slot on config commits —
  prompt iteration without platform deploys. Web-chat agents only in v1.

## Checklist

### Phase 1 — pure refactor (this PR, zero behavior change)

- [x] extract `agent-response-format.ts`: `AgentResponseFormat` interface, `ResponseParseOutcome`,
      `fencedTsResponseFormat` (moves `extractAsyncTypescriptSnippet` + regexes + corrective
      feedback strings) — _corrective feedback strings moved into the outcome (`feedback` field) so
      the processor is fully format-agnostic; the outcome's `status`/`prose` fields exist now but
      only phase 2 produces them_
- [x] extract `agent-llm-request.ts`: LLM request component (`#runLlmRequest`/`#attemptLlm`,
      in-flight slot, chunk streaming, settle appends; compaction goes through `attempt()`) —
      _class `AgentLlmRequest`, constructed by the processor with `{deps, idempotencyKey,
      readConsumedEvents, now}`; interrupt path uses `abortInFlight()`, adopt check uses
      `isExecuting()`; `prepareAgentLlmMessages`/`buildAgentCompactionRequestBody`/
      `contextWindowTokens` moved along and re-exported from the implementation for compat_
- [x] `agent-processor-implementation.ts` delegates to both; emitted bodies and idempotency keys
      byte-identical — _1441 → ~1040 lines; module-level `responseFormat` const marks the phase-2
      registry seam_
- [x] new `agent-response-format.test.ts` (pure unit tests incl. fence-in-string-literal case)
- [x] existing suites pass unchanged: `agent-processor.test.ts`, `workers-ai-transport.test.ts`,
      `agent-prompt-budgets.test.ts` — _all 250 apps/os unit test files green with zero test-file
      diffs; codemode-fence e2e runs in CI_

### Phase 2 — codemode-tag format + template (stacked PR)

- [ ] contract: `responseFormat` knob, `llmRequestOffset` on `web-message-sent`,
      `web-message-sent` added to emits, version 5.2.0
- [ ] `codemodeTagResponseFormat` + `extractCodemodeTag` line scanner
- [ ] processor: format registry/selection, mirror-skip, batch ordering
      `[summary-updated?, web-message-sent?, script-run-requested]`, `none`-outcome prose append
- [ ] `feed-format.ts` `looksLikeCode` matches `<codemode`
- [ ] `configs/codemode-tag/` template (prompt file + worker opt-in + README) on top of
      `default-configs`
- [ ] tests: `agent-processor-codemode-tag.test.ts`, pure scanner cases, template typecheck,
      e2e codemode tag + project-creation-from-template

## Implementation log

- (start) worktree `../worktrees/iterate/agent-processor-split`, branch off origin/main
  @ 1e652faba.
