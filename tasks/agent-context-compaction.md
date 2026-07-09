---
status: poc
size: large
---

# Agent context compaction

## Status summary

POC implemented (2026-07-09): all checklist items done, typecheck/lint/tests green. Compaction is three new agent events (`compaction-requested/completed/failed`) folded by the agent reducer; the summarization call rides the existing llm-request pipeline as a `purpose: "compaction"` request, so both providers work unchanged (openai-ws additionally resets `previous_response_id` across the boundary). Trigger = typed provider usage + chars/4 extrapolation vs per-model window − 24k reserve, checked only in settle. Main missing pieces are the specced follow-ups (tier-1 pruning, manual `/compact`, overflow recovery); see "Implementation log" for mechanics and tradeoffs.

## Why

Agent history grows unbounded. `reduceAgentEvents` folds every `input-added`/`output-added` since the stream began into `state.history`, and `buildLlmChatRequest` sends all of it on every LLM call. There is no token counting, no context-window awareness, and the only size guard is the blunt 30KB `truncateScriptResult`. Long-lived channel agents (Slack threads that live for weeks) will eventually overflow any model's context window — and long before that, they'll degrade from context rot and burn money on tokens.

## Design

Full research writeup lives in the conversation that produced this task; the condensed decisions:

### Representation: compaction is an event the reducer folds

- `compaction-requested` `{reason: "manual" | "threshold" | "overflow", instructions?}`
- `compaction-completed` `{summary, firstKeptOffset, tokensBefore}`

The reducer folds `compaction-completed` by dropping history entries whose source event offset is below `firstKeptOffset` and prepending a synthetic user message containing the summary. This requires tagging each `ChatMessage` in reduced state with the offset of the event that produced it (internal field, stripped before the provider call).

Nothing is ever deleted; the journal stays append-only; state remains a pure function of events; request-by-reference (`offset <= llmRequestId`) keeps working for both providers; resume/replay is free. A `compaction-requested` with no matching `compaction-completed` is retriable by construction (opencode persists its compaction request as a message part for the same crash-safety; our event journal gives us that for free).

### Trigger: provider-reported usage vs. absolute headroom reserve

- Type the currently-`z.unknown()` `usage` on `llm-request-completed`.
- Small per-model context-window map (we have exactly two providers; a handful of models).
- Fire when `lastUsage.totalTokens + charsOver4(messagesSinceLastUsage) > contextWindow − reserve`, reserve ≈ 24k (room for the next response AND for the compaction request itself). Absolute reserve, not a percentage — pi's approach; it's what you actually need and scales across window sizes.
- Check when settling the next turn (before scheduling `llm-request-requested`), never mid-stream.

### Summarization

- Keep the newest ~20k (estimated) tokens of history verbatim; summarize everything older.
- Rolling summary: the span to summarize starts at the previous compaction's `firstKeptOffset`, and the previous summary is fed into an "update this checkpoint" prompt (pi's rolling approach — cheap, stable across many rounds).
- Serialize the span as labeled plain text (`[User]: … [Assistant]: …`) so the summarizer can't mistake it for a live conversation; system prompt forbids continuing the conversation.
- Structured checkpoint format: Goal / Constraints & preferences / Progress / Key decisions / All user asks / **Entities & handles** / **Side effects already performed — do not repeat** / Current work + verbatim next step.
- Same model/provider as the session for the POC.

### itx-specific rules (this is where we differ from the prior art)

Script executions are **stateless** (loopback entrypoint, no shared realm — `capability-host-durable-object.ts`), so conversation history is the only bridge between scripts. And capabilities carry no read-only hint, so scripts can never be assumed safe to re-run.

1. **Protect script code, spend script results.** Script code is small, dense, and is the agent's in-context few-shot corpus for correct itx API usage. Results are the bloat. Summarization serializes script code verbatim and clips results (~2k chars).
2. **Entities & handles** section is mandatory in the summary: exact IDs/URLs/keys returned by scripts (Slack ts, PR numbers, stream offsets, trigger keys). Losing one can leave the agent unable to act on an entity.
3. **Side effects already performed** section is mandatory: the post-compaction duplicate Slack message is the nightmare scenario.
4. Any future pruning placeholder must be neutral (`[old script result cleared]`) — never "re-run if needed".

### Provider caveat

The OpenAI WS provider uses `previous_response_id` continuation (sends only new messages, relies on server-retained context). The first request after a `compaction-completed` must reset that and do a full resend.

### Guardrails

- No auto re-compaction while a `compaction-requested` is pending or if the last compaction happened within the same settle cycle (thrash-loop protection — the #1 failure mode in Claude Code and pi both).
- On summarization failure: journal a failure event, leave history untouched.

## Prior art (condensed)

- **pi** (earendil-works/pi-mono): absolute headroom reserve trigger from provider usage; rolling "update the previous summary" prompt; keep newest 20k tokens verbatim; cumulative `<read-files>/<modified-files>` blocks; append-only JSONL with compaction entries; one-shot overflow recovery via provider error regexes.
- **opencode** (sst/opencode): two tiers — non-destructive tool-output pruning every turn (placeholder text, original kept in storage) before any LLM summary; compaction request persisted as a message ⇒ crash-safe retry; summary is an ordinary stored assistant message flagged `summary: true`.
- **Claude Code**: auto-compact ~83.5% of effective window; escalating cascade (huge results to disk → placeholder-clear re-derivable tool results, keep newest 5 → session-memory notes → full 9-section summary); post-compact rehydration of recently-read files; prompt-cache preservation as an explicit design constraint.
- **codex** (openai/codex): 90% trigger; local path re-seeds fresh history = user messages (newest-first, 20k budget) + prefixed summary, discards all tool traffic; steady-state 10KB tool-output truncation; stores full `replacement_history` snapshot for resume.

Consensus we adopt: usage-based trigger with headroom, keep-recent-verbatim + summarize-old, durable/retriable compaction records, placeholder-clearing of bulky re-derivable outputs before expensive summarization, cache/continuation awareness.

## POC checklist

- [x] Typed `usage` on `llm-request-completed` + per-model context window map + `estimateTokens` (chars/4) helper — _`LlmUsage` (+`totalTokensFromUsage`) in agent-processor-contract.ts, wrapped in `.catch(undefined)` so a weird usage shape degrades instead of wedging the completion event; window map + estimator in agent-compaction.ts; per-agent override via `llm-provider-selected.contextWindowTokens` → `llmConfig.contextWindowTokens`_
- [x] `compaction-requested` / `compaction-completed` events in `agent-processor-contract.ts` — _plus `compaction-failed` (the "journal a failure event" guardrail); `firstKeptOffset`/`tokensBefore` are computed at request time and carried on the events so fold and serialization can't disagree_
- [x] Reducer: source-offset tagging on history entries; fold `compaction-completed` (drop older, prepend summary message) — _`ChatMessage.offset` + `summary` internal fields, stripped in `buildLlmChatRequest`; the prepended checkpoint carries no offset so the next compaction always rolls it forward_
- [x] Threshold trigger in settle logic (append `compaction-requested` when over budget; thrash guard) — _`planCompaction` in agent-compaction.ts, called from `#settleLlmRequestScheduling` before scheduling; guards: pendingCompaction, one-attempt-per-usage-measurement (`lastCompactionAttempt`), `lastUsage` cleared on fold, min 1k-token span_
- [x] Summarization step: on `compaction-requested`, serialize the span, run summary LLM call, append `compaction-completed` — _a `purpose: "compaction"` llm-request through the normal pipeline; `buildAgentLlmRequestBody` swaps in the compaction prompt, the agent turns its `output-added` into `compaction-completed` (never script execution)_
- [x] OpenAI WS provider: full resend (reset `previous_response_id`) after a compaction boundary — _body carries `compactionCount`; the provider stores the count with the response id and nulls continuation on mismatch (and never stores a compaction response's id)_
- [x] Tests in the existing `agent-processors.test.ts` style: reducer fold, trigger, end-to-end compact-then-continue — _agent-compaction.test.ts: 9 specs incl. cloudflare-ai compact-then-continue and openai-ws full-resend e2e_

## Follow-ups (out of POC scope)

- [ ] Tier-1 pruning: `script-results-pruned` event, protect newest ~40k tokens, ≥20k reclaim minimum
- [ ] Deterministic `<scripts-run>` ledger extracted from script events, merged across rolling compactions
- [ ] Manual `/compact [focus instructions]` surface
- [ ] Overflow recovery (provider context-exceeded error detection → compact once → retry)
- [ ] Cheaper dedicated summarizer model config
- [ ] Snippets-catalogue promotion: nudge agent to save proven scripts to the known-good snippets capability pre-compaction
- [ ] Context-used % surfaced in UI/evlog

## Implementation log

(started 2026-07-09)

### 2026-07-09 — POC implemented

Files: `agent-processor-contract.ts` (events/state/usage vocabulary, version 0.3.1 → 0.4.0), new `agent-compaction.ts` (planning + prompt/serialization, pure functions only), `agent-processor-implementation.ts` (folds, settle trigger, output→compaction-completed routing), `openai-ws-processor-implementation.ts` (continuation reset), `agent-compaction.test.ts`.

**Summarization mechanism chosen: a `purpose: "compaction"` flag on the existing llm-request events**, not a separate request pipeline. Rationale: providers already rebuild request bodies by reference (`buildAgentLlmRequestBody(events, llmRequestId)`), so teaching that one function to emit the compaction prompt when the request-at-offset has compaction purpose gives both providers (and any future one) summarization for free — zero provider-specific compaction code except the openai-ws continuation reset, which is needed regardless. The alternative (agent runs its own side-channel LLM call) would bypass the orphan-recovery sweep, request cancellation, chunk streaming, and the requested/completed idempotency machinery, all of which compaction gets for free by riding the pipeline.

Mechanics worth knowing when reading the diff:

- The request slot (`currentRequest`) is shared: a pending compaction wins it before any chat request; the chat trigger (`pendingTriggerOffset`) deliberately survives compaction-purpose scheduled/requested folds so the user's turn fires right after the compaction settles. Compaction requests don't charge the autonomous-turn circuit breaker.
- `firstKeptOffset`/`tokensBefore` are computed once, at settle time, and travel on `compaction-requested` → state → `compaction-completed`, so the provider-side serializer and the reducer fold can never cut at different places.
- Settle re-derivations between "compaction LLM request completed" and "compaction-completed folded" dedup into the original scheduled event (`agent/llm-request-scheduled@compaction:<requestedOffset>` idempotency key) — no double summarizer calls.
- Failure/cancellation paths: summarizer failure → `compaction-failed` (history untouched, no model-visible error input); user interrupt during compaction → cancel fold also clears `pendingCompaction`. Both leave `lastCompactionAttempt` pointing at the usage measurement, so the trigger stays quiet until fresh usage arrives — degrade to "no compaction", never a loop.
- Usage from compaction requests is ignored for the trigger (it measures the summary prompt, not the conversation).
- Malformed `usage` degrades via `.catch(undefined)` rather than failing the event parse — an unparseable `llm-request-completed` would otherwise wedge `currentRequest` forever (the reducer skips unparseable events).
- Legacy checkpoint entries without `offset` tags count as oldest (always summarizable); if the keep-boundary itself lands on an untagged entry, compaction is skipped until tagged entries exist.
- Regenerated files: `itx-api.generated.ts`, `types-source.generated.ts` (scripts), and the `sdk.ts` codegen copy + `project-repo-template.generated.ts` (the oxlint codegen preset doesn't fire — spliced manually, guarded by existing freshness tests).

Tradeoffs / conscious POC shortcuts:

- Compaction failures increment `consecutiveLlmFailures` like any failure; a compaction success also resets it. Harmless coupling, not worth a parallel counter yet.
- `reason: "manual"`/`"overflow"` and `instructions` are in the event schema but nothing generates them yet (follow-ups).
- Context-window numbers: kimi-k2 family 262,144; gpt-5 family 272,000 (input window); unknown models 131,072. Overridable per agent via `llm-provider-selected.contextWindowTokens`.
