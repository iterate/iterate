# Gemini CLI — Agent-loop deep-dive

**Repo:** github.com/google-gemini/gemini-cli (Apache-2.0, TypeScript)
**Checkout:** `~/src/github.com/google-gemini/gemini-cli` (depth=200)
**Date:** 2026-07-09

---

## TL;DR

Gemini CLI is a production-grade, TypeScript agentic loop that runs locally.
Its architecture is clean and well-separated: `GeminiClient` orchestrates
turns, `GeminiChat` serializes model calls, `Scheduler` coordinates parallel
tool execution, and `LocalAgentExecutor` drives subagent loops. Key findings
for iterate:

1. **Steering is real and nuanced.** The `InjectionService` + `pendingHintsRef`
   pattern is two delivery paths — not one. A hint received while a tool is
   awaiting execution is **prepended to the tool-response parts** (mid-turn
   injection). A hint received while the loop is idle becomes a **new user
   turn** (between-turns injection). The survey claim "adoptable without
   event-schema changes" is true in Gemini CLI's context because hints are
   plain text parts to the existing Gemini API — but iterate's event-sourced
   model would need either a new `llmRequestPolicy` arm or a new event type.
   Concrete translation sketched in the Implications section.

2. **Token limits are a hand-rolled switch statement.** A single `tokenLimit(model)`
   function maps known model strings to hard-coded sizes, defaulting to 1M.
   Directly addresses design-improvements.md item 3.

3. **Compression is blocking, two-pass LLM, char-count split.** Threshold at
   50% of window; keeps the newest 30% of history by char count; runs a
   summarize + verify pair of LLM calls. The `findCompressSplitPoint` function
   splits only at user turns that are NOT function responses — a constraint with
   important implications for iterate's event-to-prompt fold.

4. **Subagents are isolated `LocalAgentExecutor` instances** running their own
   `GeminiChat` with a scoped tool registry. Agents cannot call other agents
   (blocked at registration). Termination modes: GOAL / TIMEOUT / MAX_TURNS /
   ABORTED / ERROR / ERROR_NO_COMPLETE_TASK_CALL. A "grace period" (60s) final
   turn is attempted before giving up on TIMEOUT / MAX_TURNS.

5. **Checkpointing is append-only JSONL** with a `$rewindTo` record for undo.
   Resume re-loads the JSONL and replays messages into an in-memory map.
   A `$set: { messages: [...] }` checkpoint record lets compressions write a
   clean snapshot rather than an ever-growing delta log.

---

## Architecture overview

```
packages/cli/
  src/ui/
    AppContainer.tsx          — root UI component; routes input to hints vs queries
    hooks/useGeminiStream.ts  — React hook; drives Turn loop from the UI layer
    hooks/useExecutionLifecycle.ts — background process management
    contexts/UIStateContext.tsx — React context; hintBuffer = in-flight typed text

packages/core/
  src/
    core/
      client.ts              — GeminiClient: session orchestrator
      geminiChat.ts          — GeminiChat: serializes model calls via sendPromise
      turn.ts                — Turn: one model call cycle; emits GeminiEventType
      tokenLimits.ts         — tokenLimit(model) switch statement
    scheduler/
      scheduler.ts           — Scheduler: parallel tool execution with states
      types.ts               — CoreToolCallStatus, ToolCallRequestInfo
    context/
      chatCompressionService.ts — blocking two-pass LLM compression
    config/
      injectionService.ts    — InjectionService: central hub for mid-run input
    utils/
      fastAckHelper.ts       — buildUserSteeringHintPrompt, generateSteeringAckMessage
    services/
      chatRecordingService.ts — JSONL session persistence + rewind + resume
    agents/
      local-executor.ts      — LocalAgentExecutor: subagent loop
      types.ts               — AgentTerminateMode, LocalAgentDefinition, RunConfig
```

### Execution flow

```
AppContainer.handleFinalSubmit / handleHintSubmit
  └─ (hint path) InjectionService.addInjection()
  └─ (query path) GeminiClient.sendMessageStream()
        └─ processTurn()
              ├─ tryCompressChat()           ← blocking, checks 50% threshold
              ├─ Turn.run()
              │     ├─ GeminiChat.sendMessageStream()   ← awaits sendPromise
              │     │     └─ makeApiCallAndProcessStream()
              │     │           ├─ retryWithBackoff(apiCall)
              │     │           └─ processStreamResponse()
              │     └─ yields GeminiEventType variants
              └─ Scheduler.schedule()        ← tool execution
                    └─ _processNextItem()
                          └─ Promise.all(parallelizable tools)
```

---

## Core loop (`client.ts`, `turn.ts`, `geminiChat.ts`)

### Turn serialization

`GeminiChat.sendMessageStream()` awaits a `sendPromise` chain before firing
any new model call:

```
~/src/github.com/google-gemini/gemini-cli/packages/core/src/core/geminiChat.ts
line 350–360 (approx)
```

This means exactly one model call is in flight per `GeminiChat` instance at
any time — the same single-slot invariant as iterate's `currentRequest`. The
`sendPromise` stores the previous call's completion promise; each new call
chains via `.then(doThisCall)`.

### Event types (17 variants)

Defined at `turn.ts:55–74` as `GeminiEventType`:

```
Content, ToolCallRequest, ToolCallResponse, ToolCallConfirmation,
UserCancelled, Error, ChatCompressed, Thought, MaxSessionTurns,
Finished, LoopDetected, Citation, Retry, ContextWindowWillOverflow,
InvalidStream, ModelInfo, AgentExecutionStopped, AgentExecutionBlocked
```

The internal `StreamEventType` (4 variants) is lower-level:
`CHUNK | RETRY | AGENT_EXECUTION_STOPPED | AGENT_EXECUTION_BLOCKED`.
`Turn.run()` translates `StreamEvent → GeminiEventType` for consumers.

### Session turn limit

`MAX_TURNS = 100` per `GeminiClient` session (`client.ts`). Subagents use
`DEFAULT_MAX_TURNS = 30` (`agents/types.ts:51`).

### Loop detection

`LoopDetectionService` detects repetitive patterns in model output. On
detection `_recoverFromLoop()` injects a system feedback text and recurses
into `sendMessageStream()` — simple but synchronous.

### AbortController propagation

`AbortSignal` is passed through `sendMessageStream` → `makeApiCallAndProcessStream`
→ the `GenerateContentConfig.abortSignal` field on the SDK call.  Whether HTTP
is actually aborted depends on the SDK implementation; the same gap documented
for other agents (design-improvements.md item 9) exists here.

### Mid-stream retry

`MID_STREAM_RETRY_OPTIONS = { maxAttempts: 4, initialDelayMs: 1000, useExponentialBackoff: true }`
at `geminiChat.ts`. Connection-phase retries use a separate `retryWithBackoff()`.

---

## Steering (`injectionService.ts`, `fastAckHelper.ts`, `AppContainer.tsx`, `useGeminiStream.ts`)

### Mechanism overview

The survey's "hintBuffer" label is imprecise. The actual implementation has
three layers:

1. **`InjectionService`** (`packages/core/src/config/injectionService.ts`) —
   central service; stores an `injections: Array<{text, source}>` array;
   pub-sub via `onInjection/offInjection`; sources are `'user_steering'` or
   `'background_completion'`.

2. **`pendingHintsRef`** (`AppContainer.tsx:1146`) — React ref accumulating
   submitted hint strings until the loop is ready to consume them. This is what
   the survey was calling "hintBuffer".

3. **`hintBuffer` in `UIStateContext.tsx:209`** — React state for the text
   *currently being typed* in the hint input box. Not a buffer of submitted
   hints; just the in-progress keystroke state.

### Two delivery paths

**Path A — mid-turn (during tool execution):**

In `useGeminiStream.ts:2023–2031`, after tool calls complete but **before**
sending their results back to the model, the hook calls `consumeUserHint()`.
If a hint is pending, `responsesToSend.unshift({ text: buildUserSteeringHintPrompt(hintText) })`.
The model's next turn sees: `[hint text part] + [function response parts]` as
one user turn. The hint rides inside the existing tool-result message.

**Path B — between turns (loop idle):**

In `AppContainer.tsx:2316–2343`, a `useEffect` triggered by `pendingHintCount`
state change checks: if streaming is Idle AND no tool awaiting confirmation,
calls `consumePendingHints()` then `submitQuery([{ text: buildUserSteeringHintPrompt(pendingHint) }])`.
The hint becomes an independent new user turn.

### Prompt wrapping

`buildUserSteeringHintPrompt(hintText)` at `fastAckHelper.ts:67–70`:

```
User steering update:
<user_input>
{normalized hint text}
</user_input>
Internal instruction: Re-evaluate the active plan using this user steering update.
Classify it as ADD_TASK, MODIFY_TASK, CANCEL_TASK, or EXTRA_CONTEXT.
Apply minimal-diff changes only to affected tasks and keep unaffected tasks active.
Do not cancel/skip tasks unless the user explicitly cancels them.
Acknowledge the steering briefly and state the course correction.
```

### Fast-ack model call

`generateSteeringAckMessage()` in `fastAckHelper.ts:113` fires a separate
LLM call (model key `'fast-ack-helper'`, 1200ms timeout) to generate a brief
UI acknowledgment ("Understood. Adjusting plan.") before the main loop
processes the hint. Falls back to `"Understood. {hint}"` on timeout or error.

### Subagent injection

`LocalAgentExecutor.runInternal()` at `local-executor.ts:627–735` maintains
its own `pendingHintsQueue` and `pendingBgCompletionsQueue`. It subscribes to
`InjectionService.onInjection()` at startup and consumes queued hints by
prepending them to the `currentMessage.parts` at the top of each loop
iteration (between turns). Background completions are unshifted before hints
so the model sees: `[bg-output] + [hints] + [tool-results]`.

### Background completions

`formatBackgroundCompletionForModel(output)` wraps process output in
`<background_output>` XML tags with the instruction to treat it as data, never
as instructions. Mirrors the prompt-injection defense used for steering hints.

---

## Tool calls / Scheduler (`scheduler/scheduler.ts`, `scheduler/types.ts`)

### Tool state machine

```
Validating → Scheduled → Executing → { Success | Error | Cancelled }
                    ↓
             AwaitingApproval  (user confirmation required)
```

`schedule()` enqueues if already processing, else starts a batch via
`_startBatch()` → `_processQueue()` → `_processNextItem()`.

### Parallel execution

`_isParallelizable()` returns false for `update_topic` and `EDIT_TOOL_NAMES`
(file-editing tools); respects `wait_for_previous: false` arg (default true
meaning sequential by default unless declared parallel). Parallelizable tools
in the same batch run via `Promise.all`. Edit tools are forced sequential to
prevent conflicting writes.

### Sandbox expansion

On `sandbox_expansion_required` error, the scheduler re-asks user for
confirmation with elevated sandbox permissions and re-executes. This is a
retry pattern inside the scheduler, not surfaced to the LLM as an error.

### Tool chaining

`tailToolCallRequest`: one tool can return a request for another tool in its
response; the scheduler detects this and chains execution without returning to
the model. Lets tool stacks compose without an extra LLM round-trip.

### Cancellation

`cancelAll()` clears the queue and updates statuses to Cancelled — but does
NOT issue an HTTP abort or kill any in-progress execution. Same gap as
design-improvements.md item 9.

---

## Truncation / Compaction (`chatCompressionService.ts`, `tokenLimits.ts`)

### Token limit registry

`tokenLimit(model: string): number` at `tokenLimits.ts:23–39`:

```typescript
switch (model) {
  case GEMMA_4_31B_IT_MODEL:
  case GEMMA_4_26B_A4B_IT_MODEL:
    return 256_000;
  case PREVIEW_GEMINI_MODEL: case DEFAULT_GEMINI_MODEL:
  case PREVIEW_GEMINI_FLASH_MODEL: case DEFAULT_GEMINI_FLASH_MODEL:
  case DEFAULT_GEMINI_FLASH_LITE_MODEL:
    return 1_048_576;
  default:
    return DEFAULT_TOKEN_LIMIT; // 1_048_576
}
```

Used in two places: `processTurn()` for the `ContextWindowWillOverflow` check,
and `ChatCompressionService` for the 50% threshold computation.

### Compression trigger

`DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5` — fires when
`lastPromptTokenCount >= tokenLimit(model) * 0.5`. `lastPromptTokenCount` is
updated from `usageMetadata.promptTokenCount` on each streaming chunk.

### `findCompressSplitPoint()` at `chatCompressionService.ts`

Character-count walk through history. Default `fraction = 0.7` — tries to
leave 70% of history in the "compress" pile and keep 30% as the tail.
**Critical constraint:** only splits at user turns that are NOT function
responses. If the 70% boundary falls in the middle of a tool-call exchange,
the split walks forward to the next clean user turn. This means the actual
split ratio can deviate significantly from 70/30.

The tail head after splitting must be a `model` turn (so the Gemini API sees
valid alternating history). Function responses without their preceding model
turn are not safe split points.

### Compression algorithm

1. `truncateHistoryToBudget()` — reverse-iterates, keeps full recent function
   responses within `COMPRESSION_FUNCTION_RESPONSE_TOKEN_BUDGET = 50_000`
   tokens; saves oversized older ones to temp files (they become file references
   in history).
2. `findCompressSplitPoint(contents, 0.7)` — char-count boundary.
3. Summarize the compress-pile with LLM: format as `<state_snapshot>` XML;
   an `anchorInstruction` merges any previous snapshot from prior compression.
4. Verify the summary with a second LLM call checking completeness.
5. Check that the result is actually smaller than the original.
6. Build new history: `[user: summary, model: "Got it. Thanks for the additional context!"] + tail`.

On `COMPRESSION_FAILED_INFLATED_TOKEN_COUNT`, sets `hasFailedCompressionAttempt = true`
and future auto-compressions skip the LLM summarization and only truncate
(drop the compress pile, keep the tail). This is a permanent degradation flag
per session/executor instance.

### Compression is blocking

`tryCompressChat()` is called at the **top of every turn** in both
`GeminiClient.processTurn()` and `LocalAgentExecutor.executeTurn()`. There is
no parallel compression lane. The conversation fully pauses during the two LLM
summarization calls.

---

## Interruptions / Cancellation

`AbortController` is propagated consistently through the call stack:

- `GeminiClient.sendMessageStream(signal)` → `Turn.run(signal)` → `GeminiChat.sendMessageStream(signal)` → `GenerateContentConfig.abortSignal`
- Scheduler receives signal via `scheduleAgentTools({ signal })` in `LocalAgentExecutor`
- `Turn.run()` yields `UserCancelled` event if `signal.aborted` at turn end

However: the scheduler's `cancelAll()` only updates state; no HTTP abort is
issued to in-flight Gemini API calls. The WebSocket / HTTP stream from the SDK
may continue delivering tokens to a dropped consumer.

`AgentTerminateMode.ABORTED` is distinct from TIMEOUT/MAX_TURNS and triggers
no grace period recovery attempt.

---

## Timeouts

### Subagent timeout (`local-executor.ts:584–603`)

`DeadlineTimer` wraps a `setTimeout` + `AbortController`. Combined signal:
`AbortSignal.any([externalSignal, deadlineTimer.signal])`.

User confirmation time is excluded: `onWaitingForConfirmation` callback
calls `deadlineTimer.pause()` / `.resume()` around user confirmation waits.
This prevents long confirmation delays counting against the agent's time budget.

### Grace period

On TIMEOUT or MAX_TURNS, `executeFinalWarningTurn()` gives the agent one more
turn with a 60-second grace period (`GRACE_PERIOD_MS = 60 * 1000`) to call
`complete_task`. The model is instructed to immediately call `complete_task`
with its best answer. If the grace turn succeeds (GOAL), the agent exits
cleanly with `terminateReason = GOAL`.

### `DEFAULT_MAX_TIME_MINUTES = 10` (`agents/types.ts:56`)
### `DEFAULT_MAX_TURNS = 30` (`agents/types.ts:51`)

Both are overridable via `LocalAgentDefinition.runConfig`.

---

## Subagents (`agents/local-executor.ts`, `agents/types.ts`)

### Isolation model

Each `LocalAgentExecutor` gets:
- An isolated `ToolRegistry` cloned from the parent's, with `update_topic`
  and agent-kind tools blocked (`local-executor.ts:196–207`)
- Its own `ChatCompressionService` instance
- Its own `GeminiChat` initialized with `chat.initialize(undefined, 'subagent')`
- A scoped `AgentLoopContext` with `promptId = agentId` (UUID) and
  `parentSessionId` pointing to the main session

Agents cannot call other agents — the registration loop at `local-executor.ts:193`
explicitly skips `tool.kind === Kind.Agent`.

### Injection inheritance

Subagents subscribe to the parent's `InjectionService` on startup (`local-executor.ts:641`)
and accumulate hints in their own `pendingHintsQueue`. This means user steering
hints broadcast to ALL currently-running local agents simultaneously.

### Completion protocol

Agents MUST call `complete_task` to signal success. Stopping without doing so
is `AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL` and triggers the grace
period. The `CompleteTaskTool` sets `taskCompleted = true` and captures
`submittedOutput`; the subagent loop exits on the next iteration check.

### Remote agents

`RemoteAgentDefinition` with `agentCardUrl/agentCardJson` — communicates via
A2A protocol (Agent-to-Agent SDK). Fetches an AgentCard, resolves auth, and
calls remote endpoints. Remote agents are excluded from this deep-dive.

---

## Background processes (`hooks/useExecutionLifecycle.ts`)

`registerBackgroundTask(pid, command, initialOutput, completionBehavior?)`:

- `completionBehavior: 'silent' | 'notify' | 'inject'`
- On process exit, if `'inject'`: calls
  `config.injectionService.addInjection(output, 'background_completion')`
- Consumers (`LocalAgentExecutor`, `useGeminiStream`) subscribe to
  `InjectionService` and deliver background completion text wrapped in
  `<background_output>` tags at the next opportunity

`backgroundCurrentExecution()` moves a running shell to background; Ctrl+B
toggles background task list visibility in the UI.

`ShellExecutionService` (shell PTYs) and `ExecutionLifecycleService`
(non-shell executables) both support backgrounding via the same mechanism.

---

## Checkpointing / Resume (`services/chatRecordingService.ts`)

### Storage format

Append-only JSONL file. Four record types:
1. **Partial metadata** — initial line: `{ sessionId, projectHash, startTime, ... }`
2. **Message record** — one line per turn: `{ id, timestamp, type: 'user'|'gemini', content, toolCalls, thoughts, tokens }`
3. **Metadata update** — `{ $set: { lastUpdated, summary, memoryScratchpad, messages } }`
4. **Rewind record** — `{ $rewindTo: messageId }` — undo/branch support

Subagent sessions are nested under `chats/<parentSessionId>/` directory.

### Compression checkpointing

When compression succeeds, `updateMessagesFromHistory()` is called with the
new (compressed) history. This appends a `{ $set: { messages: [...] } }` record
that collapses the prior delta log into a single checkpoint. On reload, the
reader processes this record by clearing `messagesMap` and rebuilding from
the checkpoint array — avoiding linear scan of the full pre-compression history.

### Resume

`ChatRecordingService.initialize(resumedSessionData)` reloads the JSONL, plays
it into an in-memory map (rewinding on `$rewindTo` records), then continues
appending to the same file with a new session ID update. Legacy JSON (non-JSONL)
files are migrated to JSONL on first resume.

### Summary on goal

`saveSummary(summary)` appends `{ $set: { summary } }`. For subagents,
`getTruncatedSummary()` clips the result to 200 chars for storage.

---

## Implications for iterate

### Steering — the central finding (new design-improvements item)

Gemini CLI's steering is two delivery paths unified by `InjectionService`:

**Path A (mid-turn):** hint prepended to the next tool-result batch as a text
part — `responsesToSend.unshift({ text: buildUserSteeringHintPrompt(hint) })`.
No new API message; rides the existing function-response user turn.

**Path B (between turns):** hint becomes a new user query when the loop is
idle — `submitQuery([{ text: buildUserSteeringHintPrompt(hint) }])`.

For iterate's event-sourced model, these map to two different mechanisms:

**Option A — new `llmRequestPolicy` arm: `steer-current-request`:**
A hint arriving while `currentRequest` is in-flight queues to
`pendingSteerText`. When the provider assembles the next tool-result message
(after current tool calls complete), it prepends the hint as a text part.
This requires the provider to read `pendingSteerText` from agent state before
building the function-response message. Minimal schema change: one new state
field and one new policy arm.

**Option B — new event type `agent/steer-hint { text, arrivalOffset }`:**
The hint is appended to the stream as an explicit durable event.
Providers fold `steer-hint` events: any hint with `arrivalOffset` between the
previous request's offset and the current one gets prepended to the next
function-response turn. Between-turn hints (arrivalOffset after the last
request's completion) become a new user turn.
This is more event-sourced-natural: hints are durable, replayable,
unambiguous about which request they influenced.

**Recommendation:** Option B. It fits our existing principle that anything
affecting model behavior is a stream event (not ephemeral side-channel state).
The `agent/steer-hint` event also unblocks a future "hint history" UI (show
user every steering hint that shaped the conversation). The between-turns path
is identical to our existing `pendingTriggerOffset` + `after-current-request`
policy — only the mid-turn path is genuinely new.

The `buildUserSteeringHintPrompt` XML wrapping and `USER_STEERING_INSTRUCTION`
classification prompt are immediately adoptable verbatim — purely a text
formatting concern, no architecture dependency.

### Token limit registry — item 3

Gemini CLI's `tokenLimit(model)` in `tokenLimits.ts` is the direct answer to
design-improvements.md item 3. The iterate version should live in each
provider processor (the provider owns the model dialect):

- `cloudflare-ai` provider: model → contextWindow map (Llama/Mistral/Gemma sizes)
- `openai-ws` provider: model → contextWindow map (gpt-4o, o1, etc.)

The provider stamps `contextWindow` on `llm-request-started` or
`llm-request-completed`; the agent folds `lastKnownContextWindow`; utilization
= `lastKnownUsage.totalTokens / lastKnownContextWindow`. This is prerequisite
for item 4 (compaction trigger).

Gemini CLI's pattern of `DEFAULT_TOKEN_LIMIT = 1_048_576` as the fallback for
unknown models is pragmatic and correct: fail open (don't compress unnecessarily)
rather than fail closed (compress too aggressively on unknown models).

### Compression split point — item 4

`findCompressSplitPoint()` reveals two critical constraints for iterate's
`history-compacted { floorOffset, summary }` design:

**Constraint 1:** Split only at clean user turns, never in the middle of a
tool-call exchange. For iterate's event fold, this means the `floorOffset`
for a compaction event must point to the start of a turn where the preceding
model response has no outstanding tool calls — i.e., a user turn not carrying
`functionResponse` parts. The agent processor needs to walk backwards from the
proposed floor to find the nearest safe split point.

**Constraint 2:** The kept tail must start with a model turn (Gemini API
alternation requirement). Iterate uses a rebuilt prompt (not raw history
replay), so this is less constraining — but the principle holds: don't split
a turn pair.

**Constraint 3:** Function responses above `COMPRESSION_FUNCTION_RESPONSE_TOKEN_BUDGET`
are saved to temp files and referenced. Iterate doesn't have a local filesystem
equivalent. The analogous approach would be to store oversized tool results in
R2 (already done for script results via the workspace) and reference the file
URL in history — exactly the same direction as the script-spill PR (#1793).

Gemini CLI's two-pass LLM compression (summarize → verify) is notably more
expensive than single-pass. For iterate's first compaction implementation,
single-pass is likely sufficient and much simpler to reason about in the
event-sourced fold. The verify step adds latency and a second LLM slot.

### Compaction is blocking — item 4 + item 5

Confirmed: Gemini CLI compresses blocking (at the top of every turn). No
parallel compaction lane. The iterate design goal of non-blocking compaction
via a separate lane (item 5) remains genuinely novel — no prior art in any
surveyed system.

### Grace period on timeout — new item candidate

Gemini CLI's `executeFinalWarningTurn()` pattern (60s grace period with a
must-call-complete_task instruction on timeout/max-turns) is worth adopting
in iterate's agent processor. Currently iterate has no "soft landing" for
agents that hit limits — they terminate abruptly. A grace-period turn with
`pendingTriggerOffset` suppression (so no new user input arrives during it)
would match this pattern in our event-sourced model.

### Subagent injection inheritance

The pattern of subscribing a subagent's injection listener to the *parent*
`InjectionService` — so steering hints broadcast to all running local subagents
simultaneously — has an iterate analog: steer-hint events appended to the main
project stream would be visible to all agent processors subscribing to that
stream. Whether this is the right behavior (broadcast vs. targeted) is a
product decision, but the mechanism maps cleanly.

### ChatRecordingService → no direct iterate equivalent

Iterate's streams ARE the persistent log. The `ChatRecordingService` is solving
the same problem (durable conversation history with rewind support) that
iterate solves with its event stream append-only log + `pendingTriggerOffset`
bookmarking. The `{ $rewindTo: messageId }` mechanism maps to our stream's
ability to ignore events after a given offset. The `{ $set: { messages } }`
compression checkpoint maps exactly to our proposed `agent/history-compacted`
event — a single record that replaces prior history without deleting it.

---

## Design archaeology notes

The git checkout is shallow (depth=200), so commit history for individual files
is limited — most files show only a single boundary commit. PR search did not
surface explicit steering/compression introduction PRs in the 200-commit window.
The steering mechanism (`InjectionService`, `fastAckHelper.ts`) shows copyright
2026, suggesting it is recent. The `local-executor.ts` file is large (1526 lines)
and mature — subagent support is clearly not new.

Key PRs found in the window:
- `#28063` (2026-06-21): "fix: resolve workspace publish failures and scheduler
  event loop starvation" — confirms the scheduler had a real-world starvation
  bug (related to `_processQueue` event loop behavior)
- `#27971` (2026-07-07): "fix(core): strip thoughts from scrubbed history turns
  and resolve thought leakage" — shows thinking/reasoning tokens are explicitly
  scrubbed from resumable history, an important privacy/correctness concern
