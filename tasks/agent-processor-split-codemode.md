---
status: in-progress
size: large
---

# Agent processor split + `<codemode>` response format experiment

> **Status summary** (for skimmers): phase 1 done on branch `agent-processor-split` — the
> processor is now a ~100-line composition of three components (turn loop, LLM request,
> codemode); nothing user-visible changed and all existing tests pass unmodified. Phase 2
> (stacked PR) adds a HEADLESS processor variant (no codemode component) plus the
> `configs/codemode-tag` template that implements the tag format entirely in userland.

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

Design (revised after review — the earlier knob/registry approach was rejected as not
actually userland):

- **The processor is a composition of exactly three components** sharing the pure fold
  (`reduceAgentEvent`) and a small host surface: `AgentTurnLoop` (mirror, waiting-clear,
  interrupt, error transcription, at-head lifecycle), `AgentLlmRequest` (transport, chunks,
  settle appends, compaction), `AgentCodemode(format)` (slash commands, response parsing,
  settlement rendering). The class body is ~100 lines of wiring.
- **The experiment is 100% userland.** The platform ships a HEADLESS variant — the same
  wiring minus the codemode component — which schedules turns and calls the model but
  interprets nothing. An opted-in agent's wake subscription is retargeted to it (a single
  reversible `stream/subscription-configured` upsert on the same subscriptionKey). The
  project's config worker then IS component #3: it consumes assistant `context-added`
  events, parses the `<codemode status="...">` tag itself, and appends the same public
  events the platform component would have (`script-run-requested`, `web-message-sent`,
  `summary-updated`, corrective feedback, settlement rendering). The prompt and parser live
  in `configs/codemode-tag/` — iterating on the format is a git commit, no deploy.
- **Idempotency keys** mint in the fixed `agent/` namespace (not the contract slug) in both
  processors and the template, so a stream swapped between processors dedupes consequences
  instead of re-executing scripts.
- **Prose delivery**: `agents/web-message-sent` gains optional `llmRequestOffset`; the turn
  loop skips mirroring marked messages (the raw assistant text is already in history).
- **Known caveats** (documented in the template README): config-worker delivery is
  observation-grade (skip-on-failure, no recovery obligations) — a dropped delivery kills
  that turn silently; promotion path is `createProcessorHost` or platformizing the proven
  format. First-turn race before the retarget lands is accepted (self-heals).

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
- [x] `agent-processor-implementation.ts` becomes a ~100-line composition of
      `[AgentTurnLoop, AgentLlmRequest, AgentCodemode(fencedTs)]` over `agent-host.ts`; emitted
      bodies and idempotency keys byte-identical (keys pinned to the fixed `agent/` namespace)_
- [x] new `agent-response-format.test.ts` (pure unit tests incl. fence-in-string-literal case)
- [x] existing suites pass unchanged: `agent-processor.test.ts`, `workers-ai-transport.test.ts`,
      `agent-prompt-budgets.test.ts` — _all 250 apps/os unit test files green with zero test-file
      diffs; codemode-fence e2e runs in CI_

### Phase 2 — headless processor + userland codemode-tag template (stacked PR)

- [x] contract: optional `llmRequestOffset` on `web-message-sent` + mirror-skip in the turn
      loop; `web-message-sent` in emits; version 5.2.0 — _itx API regenerated so the sdk
      types carry the new field_
- [x] `HeadlessAgentProcessor`: same wiring minus the codemode component —
      _agent-headless-processor.ts; contract = the agent contract verbatim under slug
      `agent-headless` (shared version so they never drift); registered in AgentDurableObject
      via a shared `#agentArgs()` deps recipe; live-state runtimeChange reads whichever
      processor holds state_
- [x] `configs/codemode-tag/` template — _worker.ts retargets each agent's wake subscription
      (keyed upsert, same subscriptionKey → slug `agent-headless`), supersedes the
      system-prompt slot from `prompts/agent-system-prompt.md`, parses tags with the vendored
      `codemode-format.ts`, appends consequences under the platform's `agent/` key namespace
      (cross-processor dedupe), and renders settlements; README documents mechanics + limits_
- [x] `feed-format.ts` `looksLikeCode` matches `<codemode` (streamed responses render as code)
- [x] tests: `agent-headless-processor.test.ts` (turn runs + nothing interpreted, slash inert,
      full userland loop driven by hand-played worker appends, mirror-skip + plain-sendMessage
      mirror), template typecheck lane green
- [ ] project-creation-from-template e2e (`configRepoTemplate` → `configs/codemode-tag`) —
      _deferred: needs a preview/e2e lane with a public GitHub ref to this branch; manual
      dogfood is the next step_

## Implementation log

- (start) worktree `../worktrees/iterate/agent-processor-split`, branch off origin/main
  @ 1e652faba.
