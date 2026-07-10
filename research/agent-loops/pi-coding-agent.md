# pi coding agent — research notes

**Date:** 2026-07-09
**Upstream:** https://github.com/earendil-works/pi (formerly badlogic/pi-mono)
**Iterate port:** PR #1639, branch `material-krypton`
**Author of upstream:** Mario Zechner (@badlogic)
**Upstream blog post:** https://mariozechner.at/posts/2025-05-04-building-a-coding-agent/

---

## TL;DR

pi is a minimal, production-battle-tested TypeScript coding agent. Its most
interesting design choices relative to iterate's stream-processor model are:

1. **Two-queue steering** (`getSteeringMessages` + `getFollowUpMessages`) —
   separates mid-turn injections from queued follow-ups; maps reasonably to
   event-sourced streams but AbortControllers remain the hard part.

2. **Parallel tool execution with ordered emission** — tools run concurrently
   but results are appended in source order to keep history deterministic;
   `terminate` flag is ALL-or-nothing per batch.

3. **LLM-side compaction** — threshold + overflow with a `previousSummary`
   anti-pile-up guard, model-context-window awareness, and a stale-usage check
   that prevents false re-triggers; maps to iterate's planned
   `agent/history-compacted` event (design-improvements.md item 4).

4. **Never-throw `StreamFn` contract** — provider failures are encoded as
   `AssistantMessage { stopReason: "error" }`, never as exceptions; errors
   stay in history, `transformMessages` drops them before the next prompt
   rebuild. This is exactly iterate's pattern with `llm-request-completed` +
   event replay.

5. **`transform-messages.ts`** — cross-provider normalization pass handles
   thinking-block redaction, orphaned-tool-call synthesis, image downgrade,
   and tool-call ID normalisation for APIs like OpenAI Responses that emit
   450-char IDs. Iterate needs an equivalent at the agent-processor boundary
   (design-improvements.md item 1).

No subagents, no background processes, no MCP. Explicit design choices with
blog post rationale.

---

## Upstream vs Our Port Status

### Repo rename and npm package rename

- Old: `github.com/badlogic/pi-mono`, packages `@mariozechner/*`
- New: `github.com/earendil-works/pi`, packages `@earendil-works/*`
- The local clone at `~/src/github.com/badlogic/pi-mono` tracks `origin/main`
  which is now the earendil-works repo. `git fetch --all` is sufficient to
  update.

### "v2" status

No branch named `bigrefactor`, `earendil`, `compact-groups`, `grammar-constraints`,
`flexible-reload`, or `model-registry` exists on origin. There is only
`origin/main`.

The "bigrefactor" was a long-running branch that existed ~May 2026. Issues
closed during that period were auto-labelled `closed-because-bigrefactor`,
suggesting the branch held sweeping changes. It has since merged into main.

The most significant structural change on main is **v0.80.0 (2026-06-23)**,
the model-registry refactor:
- `AgentHarnessOptions.models` is now required (was optional)
- Replaces the old `getApiKeyAndHeaders` per-request hook
- `Models` runtime: per-provider factory objects instead of a global API
- Old API still available at the `/compat` entrypoint

This is the "v2" equivalent. If iterate ports pi, it should target this API
shape.

### Our port (PR #1639, branch `material-krypton`)

The port is a pi-shaped `StreamProcessor` pair:

- `apps/os/src/domains/pi/pi-processor-contract.ts` — `PiProcessorContract`
  v0.1.0
- `apps/os/src/domains/pi/pi-processor-implementation.ts` — `PiProcessor`

The port is a faithful translation of pi's state machine into event-sourced
form. It is draft/spike quality — designed to surface difficulties rather than
ship immediately. PR #1639 body lists 9 specific friction points (detailed
in the Implications section below).

---

## Core Loop Architecture

**File:** `~/src/github.com/badlogic/pi-mono/packages/agent/src/agent-loop.ts`

The loop runs two nested `while` loops:

```
outer: while (followUpQueue.length > 0 || firstIteration) {
    inner: while (true) {
        steeringMessages = getSteeringMessages()
        if steeringMessages → inject; continue inner
        if no tool calls → break inner
        executeToolBatch()
        if shouldTerminateToolBatch() → break inner
    }
    if shouldStopAfterTurn() → break outer
    prepareNextTurn()
    followUp = getFollowUpMessages()
    if followUp → push to outer queue
}
```

- **Steering messages** are injected between tool batches without starting a
  new LLM turn. They are prepended to the next LLM prompt in the same turn.
- **Follow-up messages** queue a NEW turn (new LLM call). They fire only when
  the inner loop has stopped.
- `shouldStopAfterTurn()` + `prepareNextTurn()` are checked/called at outer
  loop boundaries (not inner). They are NOT blocking API calls.

### Event flow

Each turn emits a sequence of `AgentEvent` values to a subscriber:

```
agent_start
  assistant_message_start
    text_start / text_delta / text_end
    thinking_start / thinking_delta / thinking_end (extended thinking models)
    toolcall_start / toolcall_delta / toolcall_end (per tool call)
  assistant_message_end
  tool_start / tool_end (per tool executed, may be interleaved)
agent_end
```

The harness (agent-session.ts) fires compaction check on `agent_end`.

---

## Tool Calls

**Files:**
- `~/src/github.com/badlogic/pi-mono/packages/agent/src/agent-loop.ts:451`
  `executeToolCallsParallel()`
- `~/src/github.com/badlogic/pi-mono/packages/agent/src/agent-loop.ts:544`
  `shouldTerminateToolBatch()`
- `~/src/github.com/badlogic/pi-mono/packages/agent/src/types.ts`
  `AgentTool<TParameters>`

### Parallel vs sequential

- Default: **parallel** (`Promise.all`).
- Per-tool override: `AgentTool.executionMode: "sequential" | "parallel"`.
- Global override: `AgentLoopConfig.sequentialToolExecution: true`.
- If ANY tool in the batch has `executionMode: "sequential"`, the entire batch
  runs sequentially.

### Ordered emission

Even in parallel mode, results are emitted in **source order** (the order tool
calls appear in the assistant message). Implementation: `Promise.all` resolves
all concurrently but `tool_start`/`tool_end` events are emitted by iterating
the calls array after all have resolved.

This keeps history deterministic regardless of actual execution order.

### `terminate` semantics

`AgentTool.execute()` can return `{ terminate: true }` to signal the turn
should end after this batch. The batch terminates only when
`finalizedCalls.every(f => f.result.terminate === true)` (line 544) — ALL
results must carry `terminate: true`. One non-terminating tool keeps the loop
going.

### `beforeToolCall` / `afterToolCall` hooks

Called synchronously around each tool execution. Both must not throw/reject.
`afterToolCall` receives the result and can mutate it (e.g. post-process
output).

### AbortSignal threading

Each tool `execute(id, params, signal, onUpdate)` receives the agent-level
`AbortSignal`. Tools that support cancellation (e.g. bash) can terminate early.
The signal is NOT per-tool-batch; it is the single agent-run signal.

---

## Steering and Follow-up Queues

**File:** `~/src/github.com/badlogic/pi-mono/packages/agent/src/types.ts`
`AgentLoopConfig.getSteeringMessages` and `getFollowUpMessages`

```typescript
// Inject mid-turn messages between tool batches (same LLM turn)
getSteeringMessages?: () => Promise<Message[]>

// Queue a new turn after the inner loop stops
getFollowUpMessages?: (lastMessage: AssistantMessage) => Promise<Message[]>
```

- `getSteeringMessages` is called before each LLM call inside the inner loop.
  If it returns non-empty, those messages are prepended to context and a new
  LLM call fires without appending a tool-result turn.
- `getFollowUpMessages` is called when the inner loop exits naturally (no tool
  calls, no steering). If non-empty, the messages are queued for a new outer
  iteration.

### Mapping to event-sourced streams

Steering maps naturally to `pi/user-message-received { whileRunning: "steer" }`.
Follow-ups map to `{ whileRunning: "follow-up" }`. The port encodes both in the
event type and routes them through the `#settle()` decision function.

The friction: `getSteeringMessages()` and `getFollowUpMessages()` are ASYNC
HOOKS called at runtime by the loop; in an event-sourced model, the steering
decision must be pre-recorded in events (cannot call an async hook during
replay). The port handles this by materializing the decision at event-append
time: the caller that appends `pi/user-message-received` must set
`whileRunning` to steer or follow-up at write time, not read time.

---

## Compaction

**Files:**
- `~/src/github.com/badlogic/pi-mono/packages/agent/src/harness/compaction/compaction.ts`
- `~/src/github.com/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts`
  lines ~1835–1950 (`_checkCompaction`)

### Trigger

Two triggers, both checked on `agent_end`:

1. **Overflow:** `isContextOverflow(assistantMessage, contextWindow)` — the
   LLM returned an overflow error OR reported usage exceeding the configured
   context window. Removes the error message from in-flight state and retries.
   One-shot: `_overflowRecoveryAttempted` guard prevents infinite loop.

2. **Threshold:** `shouldCompact(contextTokens, contextWindow, settings)` —
   `tokens > contextWindow - reserveTokens`. No auto-retry; user continues
   manually.

Both checks are SKIPPED if:
- The assistant message is older than the latest compaction boundary (stale
  usage from pre-compaction turns must not re-trigger).
- Compaction is disabled in settings.
- The overflow is from a different model (user switched models mid-session).

### Cut point

`findCutPoint()` walks from the END of history, accumulating tokens until the
`keepRecentTokens` budget is exhausted. Valid cut boundaries: `user`,
`assistant`, `bashExecution`, or `custom` messages. Tool results (`toolResult`)
are never cut points — they must stay paired with their tool calls.

Split-turn handling: if a cut lands inside a tool-call/result pair,
`findTurnStartIndex()` rewinds to the turn boundary and
`generateTurnPrefixSummary()` separately summarizes the orphaned turn prefix.

### Summary generation

`generateSummary()` serializes the to-be-compacted slice (the `trimmed`
portion before the cut point) and calls the LLM with:
- System: `SUMMARIZATION_SYSTEM_PROMPT` (hardcoded in compaction.ts)
- User: `SUMMARIZATION_PROMPT` (first compaction) or
  `UPDATE_SUMMARIZATION_PROMPT` (subsequent, includes `<previous-summary>`)

The `previousSummary` field prevents pile-up: each compaction updates the
summary incrementally rather than re-summarizing the entire already-summarized
history.

### Default settings

```typescript
DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
}
```

`estimateContextTokens()` uses the last assistant message's `usage.totalTokens`
plus a heuristic for trailing messages (100 tokens each).

### Mapping to iterate's design

Iterate's planned `agent/history-compacted { floorOffset, summary }` event
(design-improvements.md item 4) maps directly to pi's compaction boundary
record. The key advantage of event sourcing: the compaction event makes history
rewriting deterministic — replay produces the same prompt whether or not
compaction has run, because the fold handles both cases cleanly.

Pi's `_overflowRecoveryAttempted` guard maps to iterate's
`overflowRecoveryAttempted: bool` in `PiProcessorContract` state.

Pi's "stale compaction boundary" check (skip if message is older than last
compaction entry) maps to `compactionFailedForTailOffset` in the port — a
finer-grained guard that prevents re-triggering if compaction itself failed.

---

## Message Normalization (`transform-messages.ts`)

**File:** `~/src/github.com/badlogic/pi-mono/packages/ai/src/api/transform-messages.ts`

Two-pass transformation applied before every LLM prompt rebuild:

**Pass 1** (per-message):
- Non-vision model: downgrade `image` blocks to placeholder text (user and
  tool-result messages).
- Cross-model thinking blocks: redacted thinking dropped; non-empty thinking
  text converted to plain text; empty thinking blocks dropped.
- Cross-model tool calls: `thoughtSignature` stripped; tool call IDs normalised
  (OpenAI Responses emits 450+ char IDs with `|`; Anthropic requires
  `^[a-zA-Z0-9_-]+$` max 64 chars).

**Pass 2** (sequential, state machine):
- `error` or `aborted` assistant messages are **skipped entirely** — incomplete
  turns must not replay.
- If tool calls from a skipped or orphaned assistant turn have no matching
  `toolResult`, synthetic results are inserted: `{ content: "No result
  provided", isError: true }`. This satisfies API requirements (tool calls
  must be paired) without corrupting history.

This is the provider-agnostic normalization boundary that iterate is missing.
Currently iterate's UI reducer (`agent-ui-reducer.ts`) does equivalent work
hardcoded to specific provider event types (design-improvements.md item 1).

---

## Streaming

**File:** `~/src/github.com/badlogic/pi-mono/packages/agent/src/agent-loop.ts`
`streamAssistantResponse()` (~line 250)

### StreamFn contract

```typescript
type StreamFn = (
  messages: Message[],
  tools: Tool[],
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
) => Promise<AssistantMessage>
```

**Must never throw or reject.** Failures are encoded in the returned
`AssistantMessage`:
- `stopReason: "error"` — provider error
- `stopReason: "aborted"` — signal fired

The `onEvent` callback emits incremental events: `start`, `text_start`,
`text_delta`, `text_end`, `thinking_start/delta/end`, `toolcall_start/delta/end`,
`done`, `error`. The returned `AssistantMessage` is the authoritative record.

### Why never-throw matters

`agent-loop.ts` does not wrap `streamFn()` in try/catch. If it threw, the
outer loop would crash. The contract means errors propagate as data, not
control flow. Iterate already follows this pattern: `llm-request-completed`
carries `{ status: "failure" }` and the fold continues normally.

### Thinking blocks

Extended thinking (Anthropic) and reasoning summaries (OpenAI) are both
represented as `{ type: "thinking", thinking: string, thinkingSignature?:
string, redacted?: boolean }`. Cross-provider: signatures stripped, text
preserved or converted to plain text. Same-model: kept verbatim for replay.

---

## Interruptions and Cancellation

**File:** `~/src/github.com/badlogic/pi-mono/packages/agent/src/agent-loop.ts`
`runLoop()` — `signal` parameter threaded throughout.

The agent loop receives a single `AbortSignal`. When fired:
- The current `streamFn` call receives it and is expected to return an
  `AssistantMessage { stopReason: "aborted" }` promptly.
- Pending tool executions receive the same signal (each `tool.execute` call
  gets it).
- The outer loop checks `signal.aborted` between iterations; if true, exits.

There is NO per-tool-batch or per-turn-level timeout. The signal is the only
cancellation primitive.

### Note: aborted messages in history

Aborted assistant messages ARE appended to history (for the session record)
but are STRIPPED by `transformMessages()` before the next LLM prompt is
built. They are not replayed to the model.

### Mapping to iterate

Iterate's `llm-request-cancelled` event updates the fold but does NOT abort
the running provider execution (design-improvements.md item 9). Pi shows the
correct shape: the signal passed at `streamFn` call time must be stored so
`llm-request-cancelled` can fire it. The port's `#inFlightLlmRequests:
Map<number, AbortController>` implements this.

---

## Timeouts

Pi has **no native loop-level timeouts**. Timeout responsibility lies with:
- The tool implementation (e.g. bash can be given a timeout flag).
- The caller: the agent-session.ts harness at the application layer sets
  an overall deadline via the AbortSignal it creates before calling `runLoop`.

In the upstream CLI harness there is no idle timeout. The Cloudflare AI
Gateway wrapper used by iterate adds per-request timeouts at the HTTP layer.

---

## Subagents and Background Processes

**Explicit design choice: neither exists in pi core.**

From the blog post (https://mariozechner.at/posts/2025-05-04-building-a-coding-agent/):
> "No parallel subagents. No background threads. No MCP."

The rationale is simplicity and debuggability. The single-threaded loop model
makes compaction and steering straightforward; parallel subagents would require
synchronized compaction across agents.

If iterate needs subagents, it must build them on top of multiple independent
`StreamProcessor` instances, not within pi's loop. This is consistent with
how iterate's existing agent PR agents (`apps/os/src/domains/agents/`) and
email-thread agents work: one processor per agent, no shared state.

---

## `AgentLoopConfig` Hook Reference

**File:** `~/src/github.com/badlogic/pi-mono/packages/agent/src/types.ts`

| Hook | When called | Must not throw |
|---|---|---|
| `getSteeringMessages()` | Before each LLM call in inner loop | yes |
| `getFollowUpMessages(lastMsg)` | After inner loop exits | yes |
| `shouldStopAfterTurn(lastMsg)` | After inner loop, before follow-up check | yes |
| `prepareNextTurn(lastMsg)` | If not stopping; before follow-up append | yes |
| `beforeToolCall(call)` | Before each tool execution | yes |
| `afterToolCall(call, result)` | After each tool execution | yes |
| `convertToLlm(messages)` | Before `streamFn` call (final transform) | yes |
| `transformContext(messages)` | Before `streamFn` call (context shape) | yes |

All hooks are async and must resolve; rejections are uncaught by the loop.

---

## Implications for Iterate

Cross-referenced against `apps/os/src/domains/agents/design-improvements.md`.

### What to steal directly

**A. Never-throw `StreamFn` / `PiLlmDep` contract** (design-improvements.md —
supporting all items). Already in the port as `PiLlmDep.complete()`. The
existing agent processor does this correctly (`llm-request-completed` carries
failure state). Ensure cloudflare-ai provider never throws from its execution
loop (design-improvements.md item 8).

**B. `transformMessages()` two-pass normalization** (design-improvements.md
item 1). Iterate's normalization lives entirely in the browser UI reducer,
hardcoded per provider. Pi's approach — normalize at the agent/prompt-build
boundary, before the LLM sees messages — is strictly better. Port
`transform-messages.ts` logic into the agent processor's prompt-build path.
The raw wire events can remain for debugging; the normalized `output-delta`
(item 1 direction) becomes the UI's interface.

**C. Compaction trigger with stale-boundary guard** (design-improvements.md
item 4). Pi's `_checkCompaction` logic has three guards iterate must replicate:
1. Skip if aborted (user cancelled the turn).
2. Skip if assistant message pre-dates last compaction entry (prevents
   re-trigger on first post-compaction turn).
3. One-shot overflow recovery (`_overflowRecoveryAttempted`).

The port's `compactionFailedForTailOffset` and `compactionEpoch` fields
encode these guards in foldable state. This is the right direction.

**D. `findCutPoint` — never cut inside a tool-result pair** (design-
improvements.md item 4 supporting detail). When walking history to find a
compaction boundary, must never cut at a `toolResult` — only at user,
assistant, or bash-execution boundaries. Iterate's history entries use
stream offsets as provenance; the fold must implement the same "walk from
end, skip tool-result boundaries" logic.

**E. `previousSummary` anti-pile-up in compaction prompts** (design-
improvements.md item 4). On repeated compactions, iterative `UPDATE_SUMMARIZATION_PROMPT`
keeps the growing-summary-of-summaries problem bounded. Iterate's
`agent/history-compacted { summary }` should carry the summary forward for
the next compaction cycle.

**F. Ordered-result emission for parallel tool batches** (no existing
design-improvements.md item — new). Iterate should guarantee tool results are
appended in tool-call source order even when executing concurrently, to keep
history deterministic and replay safe.

### What conflicts with deterministic replay / event-sourcing

**G. Async hooks called at runtime** (design-improvements.md item 4 and
general). Pi's `getSteeringMessages()` and `getFollowUpMessages()` are called
during loop execution. In an event-sourced processor, the decision must be
pre-materialized in events; replaying cannot call live async hooks. The port
resolves this by requiring the `whileRunning: "steer" | "follow-up"` field
to be set at event-append time by the caller, not derived during replay.
This is correct but imposes a discipline on callers: they must know at write
time whether their message is a steer or a follow-up.

**H. AbortControllers are not event-sourceable** (design-improvements.md
items 8, 9). Pi's compaction and tool executions are aborted via
AbortControllers. In a `StreamProcessor`, AbortControllers are created
synchronously when processing events that START an execution, and stored in
in-memory maps (`#inFlightLlmRequests`, `#inFlightToolBatches`). They are
never in the event log. On restart (fresh instance), previous controllers are
gone — but the `#settle()` liveness recovery path detects in-progress state
with no live controller and re-starts the execution. This is the pattern the
port already implements. It means: the settle function must be called after
every batch, and it must tolerate missing controllers by re-launching.

**I. Context-window size is provider-owned** (design-improvements.md item 3).
Pi's compaction uses `this.model.contextWindow` (known at session creation
via the model-registry). Iterate's agent processor has no model registry —
the model is a bare string. The direction from design-improvements.md is
correct: the provider stamps `contextWindow` on `llm-request-completed` or
`llm-request-started`; the agent folds it into `lastKnownContextWindow`
state.

**J. Single-slot `currentRequest` blocks compaction concurrency**
(design-improvements.md item 5). Pi runs compaction serially (it blocks on
`agent_end` before checking; no concurrent requests). Iterate plans parallel
conversation + compaction lanes. The port's `run` state union
(`idle | streaming | executing-tools`) is single-slot. Adding a compaction
lane means the port needs a separate `compaction` slot — which
`PiProcessorContract` already has (`compaction: null | { requestedAtOffset,
summaryLlmRequestId, floorOffset, epoch }`). The settle function must gate
conversation-turn starts on the compaction slot being clear (or allow them to
coexist once openai-ws `#executionChain` serialization is addressed, item 7).

**K. openai-ws `previousResponseId` continuation chain**
(design-improvements.md item 6). Pi sends full message history on every
request; there is no server-side continuation chain. Iterate's openai-ws
provider uses server-side state via `previousResponseId`. A compaction event
must reset `#previousResponseId` to force a full resend from the compacted
history; the port must communicate this to the provider (e.g. via a
`resetContinuation: true` flag in the LLM request, or by having the
provider fold `history-compacted` events itself).

### No-ops / items not in pi

- **MCP** — pi deliberately has none. Iterate's capability-host model is an
  alternative approach that is already implemented.
- **Background bash** — no. Iterate's sandbox/workspace model handles
  long-running shell processes separately.
- **Chunk write amplification** (design-improvements.md item 10) — pi has no
  equivalent; it streams to TUI but does not durable-journal frames. Iterate
  needs the coalescing optimization independently.
- **O(history) re-fold per request** (design-improvements.md item 11) — pi
  re-reads messages from in-memory state, not from an event stream; this is
  not a problem for pi. Iterate must address this independently (checkpoint
  state or read from tail).

---

## Code Reference Quick-links

| Topic | File | Lines |
|---|---|---|
| Core loop | `~/src/github.com/badlogic/pi-mono/packages/agent/src/agent-loop.ts` | 1–748 |
| Parallel tool exec | same | 451–516 |
| Terminate batch check | same | 544 |
| AgentLoopConfig hooks | `~/src/github.com/badlogic/pi-mono/packages/agent/src/types.ts` | (AgentLoopConfig) |
| StreamFn type | same | (StreamFn) |
| transformMessages | `~/src/github.com/badlogic/pi-mono/packages/ai/src/api/transform-messages.ts` | 1–220 |
| Compaction logic | `~/src/github.com/badlogic/pi-mono/packages/agent/src/harness/compaction/compaction.ts` | 1–300 |
| _checkCompaction | `~/src/github.com/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts` | ~1835–1950 |
| Port contract | `apps/os/src/domains/pi/pi-processor-contract.ts` | (on `material-krypton`) |
| Port implementation | `apps/os/src/domains/pi/pi-processor-implementation.ts` | (on `material-krypton`) |
| Design improvements | `apps/os/src/domains/agents/design-improvements.md` | 1–128 |

---

## Related Issues / PRs

- **pi PR #1639** (iterate): pi coding agent port spike — https://github.com/iterate-com/iterate/pull/1639
- **pi blog post**: https://mariozechner.at/posts/2025-05-04-building-a-coding-agent/
- **pi issue tracker** (earendil-works/pi): issues closed with `closed-because-bigrefactor` label
  indicate the v0.80.0 model-registry merge was the primary structural "v2"
- **iterate design-improvements**: `apps/os/src/domains/agents/design-improvements.md`
