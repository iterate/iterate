# Vercel eve — Architecture Deep Dive

**Repo:** https://github.com/vercel/eve (cloned at `~/src/github.com/vercel/eve`)
**Launch:** June 17 2026. Public beta. ~48 releases in 3 weeks as of July 2026.
**Blog:** https://vercel.com/blog/introducing-eve, https://vercel.com/blog/agent-stack

---

## TL;DR

eve is a filesystem-first agent framework ("agent is a directory") built on top of a
proprietary durable workflow SDK (`@workflow/core`, vendored into the package as
`#compiled/@workflow/core/index.js` — no separate public repo found). Every agent
conversation is a _durable workflow_; within a workflow, every LLM + tool-loop
iteration is an atomic _step_ (`"use step"` directive). Steps are the checkpoint
boundary. State is embedded directly in step results, not appended to a separate
event log. Compaction is triggered by context-window utilization, runs as a blocking
`generateText` call, and rewrites `session.history` in place. Subagents are tools;
parents call children by starting a new child workflow and awaiting its completion.
The HTTP event stream is NDJSON with 26 named event types.

The key comparison point with iterate: eve's durability is **step-result embedding**
(the snapshot travels _inside_ the workflow step return value), while iterate's is
**event-log replay** (full stream re-fold per request). Both achieve crash recovery;
eve cannot audit or replay individual LLM responses, and non-determinism inside a
step is not replay-safe by design.

---

## Architecture

### 1. Framework compile step

`compileAgent()` at
`~/src/github.com/vercel/eve/packages/eve/src/compiler/compile-agent.ts:1`
runs filesystem discovery (`discoverAgent()`) and writes compiler artifacts
(`CompiledAgentManifest`). Discovery resolves the conventional directory layout:

```
agent/
  agent.ts            ← defineAgent({ model, compaction, limits, ... })
  instructions.md
  tools/              ← defineTool({ description, inputSchema, execute })
  skills/
  subagents/
  channels/           ← defineChannel(), slackChannel(), discordChannel(), ...
  schedules/          ← defineSchedule({ cron, run }) or <name>.md
```

Tools, subagents, skills, schedules, and channels are all discovered via file-path
conventions. There is no central registry file. A compile error (e.g. missing
`execute` on a non-client-resolved tool) throws `CompileAgentError` at build time.

### 2. Runtime

The runtime entry is `workflowEntry` (stable name). At the top of each session:

1. **Driver workflow** (`"use workflow"`) starts, pinned to the deployment that
   called `start()`. Its job is to manage park/resume across the whole conversation.
   `STABLE_WORKFLOW_NAMES = new Set(["workflowEntry", "turnWorkflow"])` — these
   two function names are version-stable identifiers so cross-deployment routing works
   (see `~/src/github.com/vercel/eve/packages/eve/src/execution/workflow-runtime.ts`).

2. For each user message, the driver dispatches a **turn workflow**
   (`turnWorkflow`, `"use workflow"`) via `startWorkflowPreferLatest`. Turn
   workflows run on the _latest_ deployment (not the pinned driver). The driver
   `await`s the turn's result via a `TurnInboxPayload` hook.

3. Inside the turn workflow, `turnStep()` (`"use step"`) is called in a `while(true)`
   loop. Each iteration is one durable checkpoint.

4. `turnStep` returns `DurableStepResult` with `action: "continue" | "done" | "park" | "dispatch-workflow-runtime-actions"`.

5. `"continue"` means a tool call was resolved and the loop continues immediately
   with the same step function. `"done"` means the assistant produced a final reply.
   `"park"` means wait for user input or HITL. `"dispatch-workflow-runtime-actions"`
   means a subagent or long-running action was dispatched.

### 3. Workflow SDK layer

The Workflow SDK (`@workflow/core`) is **not a separate public open-source repo**.
It is vendored into the eve package as
`~/src/github.com/vercel/eve/packages/eve/src/internal/workflow/runtime.ts` (which
re-exports from `#compiled/@workflow/core/runtime.js`). The SDK provides:
- `"use workflow"` / `"use step"` TypeScript directives → durable boundaries
- `createHook`, `resumeHook` → durable inbox/outbox primitives
- `getRun`, `start`, `getWorkflowMetadata` → workflow control plane
- `setWorld(world)` → pluggable backend (Vercel default; custom via `agent.ts` experimental.workflow.world)

Step results are the persistence boundary. The snapshot of the full session
(`DurableSessionSnapshot`) is embedded in the step return value. The Workflow SDK
stores this as part of the step's recorded output. On retry or replay, the step
return value is replayed from the store; the step body does not re-execute.

---

## Topics

### Tool calls

**Definition:** `defineTool({ description, inputSchema, outputSchema?, execute, approval? })`
at `~/src/github.com/vercel/eve/packages/eve/src/public/definitions/tool.ts`.
Each tool file under `agent/tools/` exports a default `ToolDefinition`.

**Discovery:** Filesystem. `discoverAgent()` walks `agent/tools/` and compiles each
file into a `SessionToolDefinition`. Tools are stored on `HarnessSession.agent.tools`
(schema only, no execute fn — tools are re-resolved each step from the compiled
bundle).

**Execution:** Inside `turnStep`, `buildToolSet()` wraps each tool with
`wrapToolExecute()`. If `execute === undefined` the tool is client-resolved (HITL
only). Otherwise the harness runs `execute(input, toolContext)` after the model
emits the tool call.

**Sandbox vs in-runtime:** Tools can spawn sandbox processes (`ctx.sandbox.run(...)`)
or run in-process. The sandbox is an isolated microVM (Vercel Sandbox / Docker /
microsandbox / just-bash adapters). Sandbox sessions are pinned per durable session
(`sandboxState` on `DurableSession`). Abort signals propagate to all sandbox ops via
`bindSandboxAbortSignal()` at
`~/src/github.com/vercel/eve/packages/eve/src/execution/sandbox/abort-bound-session.ts`.

**Framework tools:** `ask_question` (HITL), `code_mode` (codemode), `final_output`
(structured result). `ask_question` has no `execute` — it is client-resolved.
Authored tools with the same name as a framework tool replace the framework tool
(see GitHub issue #203 for the HITL collision bug and its fix via `defineClientTool`
in PR #204).

### Truncation / context limits

No hard per-request truncation. Instead, compaction fires at a utilization threshold
(see Compaction section below). If the session hits
`maxInputTokensPerSession` (default 40M for root sessions), eve refuses to start
the next model call — the call that crosses the limit is allowed to finish; later
calls are blocked.
`maxOutputTokensPerSession` is a separate cap (unset by default).
Both are authored in `agent.ts` via `limits` and stored on `HarnessSession.limits`.
Source: `~/src/github.com/vercel/eve/packages/eve/src/shared/agent-definition.ts:151-207`.

### Steering (continuationToken, messages while running)

**continuationToken** is a stable string identifier for the parked session. It is
generated at session creation and stored on `HarnessSession.continuationToken`. The
driver workflow uses it as the inbox hook token (`createHook({ token: continuationToken + ":inbox" })`).

A new user turn is delivered via `resumeHook(continuationToken, payload)`. The inbox
delivers it to the turn workflow's `waitForRuntimeActionResults` loop or, when parked,
to the driver which dispatches a new turn workflow.

**Resume payload shapes:**
- New session: `POST /eve/v1/session` with `{ message }`
- Continue parked: `{ continuationToken, message }`
- HITL response: `{ continuationToken, inputResponses: [{ toolCallId, optionId?, text? }] }`
- `actions.requested` approval: same flow, resolved via authorization callbacks

Source: `~/src/github.com/vercel/eve/packages/eve/src/protocol/message.ts` (the
`HandleMessageRequestBody` type).

Messages sent while a turn is in flight are buffered in `bufferedDeliveries` on the
turn workflow and delivered at the next park boundary
(see `turnWorkflow.ts:59-63` — `bufferedDeliveries: DeliverHookPayload[]`).

### Subagents (parent-calls-child-as-tool)

Subagents live under `agent/subagents/<id>/` (same directory structure as a root
agent). They are exposed to the parent model as tools. When the model calls the
subagent tool:

1. `buildSubagentRunInput()` derives `childContinuationToken`, splits the parent's
   remaining token quota evenly across any concurrent fanout, and builds `RunInput`.
2. `dispatchTurnStep()` starts a child `turnWorkflow` on latest deployment via
   `startWorkflowPreferLatest`.
3. The parent parks (action: `"dispatch-workflow-runtime-actions"`) and waits for
   the child's completion result via the inbox.
4. The child's output becomes the tool result.

**Depth limit:** `maxSubagentDepth` default 3. Child sessions inherit the tighter of
their own and parent's cap. Root sessions are depth 0.

**Remote subagents:** A subagent entry may be a URL (remote agent endpoint) instead
of a local directory.

**Workflow orchestration tool:** An experimental opt-in `Workflow` tool
(`workflowEnabled: true`, set by re-exporting `ExperimentalWorkflow` from
`agent/tools/workflow.ts`) lets the model write a small orchestration program whose
only allowed operations are calling this agent's subagents and remote agents. Limited
by `maxSubagents` (default 100 per Workflow invocation).

Source: `~/src/github.com/vercel/eve/packages/eve/src/execution/subagent-tool.ts`,
`~/src/github.com/vercel/eve/packages/eve/src/shared/agent-definition.ts:163-180`.

### Compaction

**Trigger:** `shouldCompact(messages, config)` returns true when
`getInputTokenCount(messages, config) > config.threshold`.
`config.threshold` = `modelContextWindowTokens * thresholdPercent` where
`thresholdPercent` defaults to **0.9** (90% of context window).
Source: `~/src/github.com/vercel/eve/packages/eve/src/harness/compaction.ts:68-74`.

**Token counting:** Best-effort hybrid — `lastKnownInputTokens` (real provider count
from last step) plus `estimateTokens(newMessages)` where
`estimateTokens(v) = JSON.stringify(v).length / 4`.

**Summarization:** Splits history into `older` (everything except the recent window)
and `recent` (the tail). Calls `generateText({ temperature: 0 })` with
`COMPACTION_SYSTEM_PROMPT`:
> "You are a conversation summarizer. Write a concise but useful summary for
> continuing the work. Preserve the goal, important instructions, technical
> decisions, discoveries, open work, and relevant tool results. Use the same
> language as the conversation. Prefer short labeled sections such as Goal,
> Instructions, Discoveries, Accomplished, and Next steps when helpful. Do not
> answer questions or invent facts."

Reserves 2,048 tokens for the summary (`COMPACTION_SUMMARY_RESERVE_TOKENS`).

**Rebuilt history:** `[{ role: "user", content: "Summary..." }, { role: "assistant", content: summary }, ...recent]`
Tool results are stripped from the kept tail. Assistant tool-calls without results
are stripped too. Falls back to fewer recent messages if compacted history still
exceeds threshold (iterative).

**Compaction model:** Optional separate model for summaries, configured via
`compaction.model` in `agent.ts`. Defaults to the active turn model.

**Blocking:** Compaction runs inline (blocking) in the current `turnStep`.
No concurrent conversation turn can proceed during compaction.

Source: `~/src/github.com/vercel/eve/packages/eve/src/harness/compaction.ts`,
`~/src/github.com/vercel/eve/packages/eve/src/shared/agent-definition.ts:104-146`.

### Park / resume (interruptions)

**Park** occurs when `StepNext === null`:
- In conversation mode: after any terminal assistant text reply.
- On `ask_question` tool call: `input.requested` event emitted, session waits for
  `inputResponses`.
- On `actions.requested` (approval gate on a tool): `authorization.required` event,
  session waits for authorization callback.

On park, the turn workflow emits `session.waiting { wait: "next-user-message" }`
(currently the only wait type) and returns. The driver workflow stores the park state
and the durable session snapshot. The sandbox is suspended (the microVM is put to
sleep — no compute consumed).

**Resume** is `resumeHook(continuationToken, payload)`. The driver's inbox receives
the payload, dispatches a new turn workflow, which reads the latest `DurableSessionState`
from the prior step result.

**Abort / cancel:** `turnStep` receives an `abortSignal`. When cancelled, the step's
in-flight model call and sandbox operations are aborted. GitHub issue #126 / #134
documents a client-side bug where aborting mid-stream lost the `continuationToken` —
fixed in #118/#127. The durable session is preserved across cancellations; the next
message correctly continues the existing conversation.

### Timeouts and background processes

**Timeouts:** No explicit per-session wall-clock timeout authored in eve. The
Workflow SDK's own runtime enforces step-level retry bounds (PR `fix(eve): harness -
add bounded durable task retries`, commit 3da5def5). Individual tool calls can pass
an `abortSignal`. Sandbox operations accept per-call abort signals.

**Schedules:** Files under `agent/schedules/` (TypeScript or markdown). Cron
expression + either a markdown prompt (fire-and-forget agent invocation) or a
`run` handler (`{ receive, waitUntil, appAuth }`). The `waitUntil` API extends the
cron task's lifetime past handler return for background async work (parked workflow
sessions, in-flight fetches).
Source: `~/src/github.com/vercel/eve/packages/eve/src/public/definitions/schedule.ts`.

**Long-running sandbox work:** Sandbox processes can be spawned (`spawn()` vs
`run()`) for long-lived background tasks within a turn. Abort signals propagate
from the turn to the sandbox. No explicit maximum runtime for sandbox processes
was found in the source.

### Streaming (event stream)

**Protocol:** `application/x-ndjson; charset=utf-8`, version `18` (`EVE_MESSAGE_STREAM_VERSION`),
format `"ndjson"`. Each event is a JSON object on a single line with `{ type, ...payload }`
plus optional `meta: { at: string }` (ISO timestamp, stamped before writing).

Source: `~/src/github.com/vercel/eve/packages/eve/src/protocol/message.ts`.

**Full event type union** (`HandleMessageStreamEvent`):

| Type | Description |
|------|-------------|
| `session.started` | Session opened; carries `RuntimeIdentity` metadata |
| `session.waiting` | Session parked; `wait: "next-user-message"` |
| `session.completed` | Session terminated normally |
| `session.failed` | Session terminated with error; carries `code`, `message`, `details` |
| `turn.started` | Model turn beginning |
| `turn.completed` | Turn done |
| `turn.failed` | Turn threw; carries error |
| `step.started` | Durable step starting |
| `step.completed` | Step done; carries `usage: { inputTokens, outputTokens, costUsd, cacheReadTokens, cacheWriteTokens }` |
| `step.failed` | Step threw after retries |
| `message.received` | User message received |
| `message.appended` | Streaming text delta from model |
| `message.completed` | Full assistant message assembled |
| `reasoning.appended` | Streaming thinking/reasoning delta |
| `reasoning.completed` | Full reasoning block assembled |
| `result.completed` | Structured output result (task mode) |
| `subagent.started` | Child subagent turn started |
| `subagent.called` | Parent called a subagent tool |
| `subagent.completed` | Subagent returned; carries output |
| `subagent.event` | Child event proxied to parent stream |
| `actions.requested` | Tool approval gate triggered; carries tool call list |
| `action.result` | Approved tool completed; carries result |
| `input.requested` | `ask_question` or HITL tool parked; carries input schema |
| `authorization.required` | OAuth/connection challenge; carries auth URL |
| `authorization.completed` | Auth resolved |
| `compaction.requested` | Compaction triggered |
| `compaction.completed` | Compaction summary generated |

**Delta events:** `message.appended` and `reasoning.appended` are incremental deltas.
`message.completed` carries the full assembled text. Clients subscribe to the stream
and reconstruct from deltas or wait for completed events.

**Resumability after disconnect:** The NDJSON stream is written to the durable Workflow
stream (via `parentWritable`). A reconnecting client reads from the workflow-owned
stream using `getReadable`. GitHub issue #134 ("Stream reconnect exhaustion silently
clears the session while the durable turn continues") documents a client-side bug
where reconnect exhaustion could lose the session, but the server-side durable stream
remains intact. The turn keeps running after the client disconnects.

---

## Durability story: is the step journal an event log?

**Short answer: no, not in the same sense as iterate's event log.**

| Dimension | eve (workflow steps) | iterate (event-sourced stream) |
|-----------|---------------------|-------------------------------|
| Persistence unit | Step return value (snapshot embedding) | Individual domain events appended to stream |
| Granularity | One step = one LLM call + tool-loop continuation | One event per message, tool call, chunk, etc. |
| Replay | Step re-runs from stored return value on retry (step body not re-executed on success) | Full stream re-fold per request (O(history)) |
| Auditability | Only latest snapshot visible; no per-event history | All events permanently on stream; full audit trail |
| Non-determinism | LLM calls are inside steps; result is stored, not replayed — non-determinism is suppressed by caching the output | LLM call events (chunks, completions) are permanent record; replay = re-fold, not re-call |
| Compaction | Rewrites `history` in-place inside a step; prior state not retained | `history-compacted` event _appended_; prior state remains on stream; audit-safe |
| Crash mid-step | Step re-runs from the last stored step result (prior step output, not mid-step state) | Append is idempotency-keyed; partial writes are harmless |

**Key insight:** eve's Workflow SDK stores _step results_ (the completed output), not
a journal of everything that happened during the step. Two turns deep in a session,
you can see the current `DurableSession` snapshot and the inputs to each step, but you
cannot reconstruct the raw model responses from individual turns unless they appear in
`history`. Compaction actively destroys older history. There is no event log.

In iterate terms: eve has a _state machine with checkpointed transitions_, not an
_event log_. The distinction matters for:
- **Auditability**: iterate can reconstruct any prior state by replaying to an
  offset; eve cannot recover pre-compaction context.
- **Non-determinism**: iterate treats LLM responses as recorded facts (events);
  eve's step-output caching achieves the same for the execution path but not for
  the raw response stream (chunks are not stored per-turn).
- **Tooling**: iterate's stream can be re-processed by new processors without
  re-running the agent; eve would need to re-run the agent.

---

## Design archaeology (GitHub issues / PRs)

Notable design signals from the active issue tracker:

**#203 / #204 — HITL authored tool collision (resolved):** No way to author a
client-resolved tool — `normalizeToolDefinition` required `execute`, causing a
duplicate `tool_result` when the same call parked for HITL input. Fixed by
introducing `defineClientTool()` (client-resolved marker, no executor) and rejecting
mixed shapes at compile + runtime. Good signal: the HITL / execution boundary is a
genuine design tension they are actively resolving.

**#126, #134 — Client stop / stream reconnect:** Stopping a response mid-stream
cleared the client's `continuationToken`, creating a new durable session instead of
continuing. Durable stream intact server-side; client state management was the bug.
Fixed in #118/#127. The durable session persists across client disconnects.

**#50 — Shared tools across root agents:** No first-class mechanism for sharing tools
across multiple root agents (only subagent sharing works). Suggests the directory model
is per-agent, no global tool registry.

**Dynamic model selection (PR #581):** `defineDynamic({ fallback, events })` for
switching models mid-session based on stream events. Merged. Shows the event stream
is used not just for display but for runtime control flow.

**Codemode:** `code_mode` is a framework tool (alongside `ask_question` and
`final_output`). It is excluded from the action runner's approval list:
`excludedActionToolNames: new Set([ASK_QUESTION_TOOL_NAME, CODE_MODE_TOOL_NAME, FINAL_OUTPUT_TOOL_NAME])`.
This confirms eve has a direct equivalent of iterate's codemode.

---

## Implications for iterate (cross-referencing design-improvements.md)

### Item 1 — Normalized streaming delta (`output-delta` event)

eve: `message.appended` / `reasoning.appended` are normalized provider-agnostic
deltas with a `channel` discriminator (text vs reasoning). They are emitted by the
harness, not the provider, so provider dialect is hidden from consumers. The event
type absorbs growth; a new channel (e.g. tool-call delta) is added to the union, not
a new event category. **This is exactly the proposed direction for iterate.** The
eve stream event schema is a concrete design reference.

### Item 2 — Usage is untyped and never folded

eve: `step.completed` carries `{ inputTokens, outputTokens, costUsd, cacheReadTokens,
cacheWriteTokens }` — a typed, stable shape. It is provider-agnostic and normalized
at the harness layer, not the provider layer. `step.completed` fires once per durable
step (one LLM call), making it the natural fold point for `lastKnownUsage`. This
validates iterate's direction of normalizing usage at the provider boundary before
appending to the stream.

### Item 3 — Context window limits exist nowhere

eve: Model context window is resolved at startup via the AI Gateway's model catalog
(metadata lookup). It is available to `CompactionConfig.threshold` =
`contextWindowTokens * thresholdPercent`. The gateway lookup approach means eve
doesn't hardcode window sizes. For iterate: the provider owns the model→contextWindow
mapping; an alternative is an explicit `llmConfig.contextWindowTokens` override
(same as eve's `modelContextWindowTokens` escape hatch) for models not in any
catalog.

### Item 4 — Compaction (the goal)

eve's compaction is **blocking**: the summarization `generateText` call runs inside
the current `turnStep` before the loop continues. Tool results are stripped from the
kept tail. The summary is always `[user: "Summary...", assistant: <summary>, ...recent]`.
The compaction model can be a separate cheaper model.

For iterate, the event-sourced design is strictly superior for the compaction record:
`agent/history-compacted { floorOffset, summary }` is an append-only event that
preserves the full prior history on the stream. Eve's approach destroys older
history — there is no pre-compaction state unless you archived it separately.
The blocking vs non-blocking question (item 4's "sequencing lean") is orthogonal to
the event shape.

### Item 5 — Single `currentRequest` slot

eve runs one LLM call per step, one step at a time per turn (the `while(true)` loop
is sequential). A compaction summary call would block the conversation turn because
both run inside the same step loop. This is the same bottleneck iterate has.
Eve's architecture does not solve parallel-lane LLM calls; it simply doesn't need
to because the step boundary serializes everything. Iterate's design is more
ambitious (parallel lanes) and the step-serialization constraint is deliberate in eve.

### Item 6 — openai-ws `previous_response_id` continuation vs compaction

eve has no equivalent: it always resends the full `session.history` to the model
each step. The AI SDK's `generateText` / `streamText` use the messages array directly.
There is no server-side continuation chain to break. For iterate, this means the
`#previousResponseId` reset on compaction (item 6) is an iterate-specific concern
with no analog in eve's design.

### Item 10 — Chunk write amplification

eve's event stream does write one NDJSON line per `message.appended` event (per
streaming chunk). However: (a) writes go to the Workflow SDK's durable writable
stream, not directly to a DO-SQLite append per event; (b) back-pressure is handled
by the writable stream, not by awaiting individual appends in the socket-read loop.
The architecture is different enough that the per-chunk await pattern iterate has
(item 10) does not arise in eve.

### Item 11 — Every request re-folds the whole stream

eve has no equivalent problem: session state is embedded in step results and
materialized once per step (`readDurableSession` reads the snapshot from the prior
step's return value — `O(1)`, not `O(history)`). This is the central advantage of
eve's approach. Iterate's full re-fold per request (item 11) is the price of pure
event-sourcing. The mitigation iterate is considering (checkpointed agent state for
prompt building, reading from processor's own reduced state) is essentially what eve
does by default.

---

## File reference index

| Topic | File |
|-------|------|
| Stream event schema (complete) | `~/src/github.com/vercel/eve/packages/eve/src/protocol/message.ts` |
| Session types (HarnessSession, StepNext, StepFn) | `~/src/github.com/vercel/eve/packages/eve/src/harness/types.ts` |
| Compaction implementation | `~/src/github.com/vercel/eve/packages/eve/src/harness/compaction.ts` |
| Durable step (turnStep, `"use step"`) | `~/src/github.com/vercel/eve/packages/eve/src/execution/workflow-steps.ts` |
| Turn workflow (`"use workflow"`, park/resume loop) | `~/src/github.com/vercel/eve/packages/eve/src/execution/turn-workflow.ts` |
| Durable session store (snapshot embedding) | `~/src/github.com/vercel/eve/packages/eve/src/execution/durable-session-store.ts` |
| Agent definition (compaction config, limits) | `~/src/github.com/vercel/eve/packages/eve/src/shared/agent-definition.ts` |
| Workflow SDK re-exports (vendored) | `~/src/github.com/vercel/eve/packages/eve/src/internal/workflow/runtime.ts` |
| Sandbox abort propagation | `~/src/github.com/vercel/eve/packages/eve/src/execution/sandbox/abort-bound-session.ts` |
| Schedule definition | `~/src/github.com/vercel/eve/packages/eve/src/public/definitions/schedule.ts` |
| Context step (ALS setup) | `~/src/github.com/vercel/eve/packages/eve/src/context/run-step.ts` |
| iterate design-improvements | `apps/os/src/domains/agents/design-improvements.md` |
