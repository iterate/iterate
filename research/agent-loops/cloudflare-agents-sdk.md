# Cloudflare Agents SDK — Deep Research

**Date:** 2026-07-09  
**Repo:** `~/src/github.com/cloudflare/agents` (git pulled to latest)  
**Compared against:** `apps/os/src/domains/agents/` (iterate's event-sourced agent runtime)

---

## TL;DR

The Cloudflare Agents SDK provides `Agent<Env, State, Props>` (in `packages/agents`) — a Durable Object wrapper with SQLite state, WebSocket hibernation, scheduling, MCP integration, durable fibers, and sub-agent facets. Layered on top is `@cloudflare/think` ("Project Think"), an opinionated chat agent harness with session/message management, compaction, resumable streaming, multi-turn recovery, HITL approvals, channels, and an extension system.

The fundamental architectural difference: CF agents keep mutable DO state + broadcast snapshots; iterate keeps an immutable append-only event log + folds it forward. CF gets simpler ergonomics for single-agent state sync; iterate gets replayability, crash recovery by construction, and auditable history — at the cost of O(history) replay on every request (design-improvements.md item 11).

---

## What "Project Think" Is

**Answer:** Project Think is Cloudflare's officially-named, shipping SDK layer — the npm package `@cloudflare/think` — announced April 15, 2026 at https://blog.cloudflare.com/project-think/. It is not a demo, codename, or separate repo; it is a production-grade opinionated chat agent harness built directly on top of the base `Agent` class.

- Blog post: https://blog.cloudflare.com/project-think/
- npm: `@cloudflare/think`
- Docs: https://developers.cloudflare.com/agents/think/
- Package in repo: `packages/think/`
- Design doc: `~/src/github.com/cloudflare/agents/design/think.md`
- Roadmap: `~/src/github.com/cloudflare/agents/design/think-roadmap.md`

The name "Think" signals deliberate agent reasoning — Cloudflare's answer to the question of what opinionated conventions belong on top of a raw DO-based agent loop.

**Class hierarchy:**  
```
partyserver.Server → Agent<Env, State, Props> → Think<Env, State, Props> → YourAgent
```

`AIChatAgent<Env, State, Props>` (also exported from `packages/agents`) is the lower-level predecessor: it handles the same chat turn/stream lifecycle but without Think's Session abstraction, compaction, context blocks, FTS5, multi-session, or extension system. Think is the path forward; AIChatAgent remains first-class and maintained (see `design/rfc-ai-chat-maintenance.md`).

---

## SDK Architecture

### Base: `Agent<Env, State, Props>`

**File:** `~/src/github.com/cloudflare/agents/packages/agents/src/index.ts` (13,058 lines)  
**Key lines:** class definition at ~line 1774; `setState` at ~line 1726; `subAgent` at ~line 7700; `runFiber` at ~line 5347.

`Agent` extends partyserver's `Server` (itself a thin Durable Object wrapper that adds WebSocket connection management and hibernation). Core features:

**Persistent state** — `this.setState(state)` stores a JSON blob in an SQLite table called `cf_agents_state` (one row, key `"state"`). The getter is lazy: first read hits SQLite, subsequent reads use an in-memory cache pinned to the DO instance. The SQLite storage itself survives eviction; the in-memory cache does not — reads after wake re-query the table. On first access the state falls back to `this.initialState`.

**WebSocket hibernation** — `static options = { hibernate: true }` by default. The partyserver layer registers a `webSocketMessage` hibernatable handler. The Agent class wraps `onConnect` to send a full state snapshot on every new connection (including reconnects after hibernation). Clients always get the current state before any new events.

**Scheduling** — `this.schedule(when, callback, data)` and `this.scheduleEvery(interval, callback, data)` write to the `cf_agents_schedules` SQLite table and arm DO alarms. Alarms fire the named method. `scheduleEvery` re-arms automatically. `@callable` decorator marks a method as browser-invokable over WebSocket RPC.

**Durable fibers (`runFiber`)** — persists function invocations to SQLite so they can be re-entered after DO eviction. A fiber records its `callback` name and arguments in `cf_agents_runs`; on wake the framework re-invokes incomplete fibers in order. The fiber can call `stash(value)` to checkpoint intermediate values, which are available as `recovery.stash` on re-entry. `onFiberRecovered` is a lifecycle hook. `fiberRecoveryMaxAgeMs` (default: 1 hour) controls how old a dangling fiber entry must be before the framework attempts recovery (prevents phantom re-runs when a fiber completes normally during eviction).

**keepAlive** — `keepAlive()` increments an internal counter (`_keepAliveRefs`). While `_keepAliveRefs > 0`, the DO alarm system fires a heartbeat every `keepAliveIntervalMs` (default 10s) to prevent eviction. `keepAliveWhile(fn)` wraps an async function, incrementing on entry and decrementing on exit. Used inside streaming turns to prevent the DO from sleeping mid-stream. Sub-agent facets acquire keepAlive tokens that are held on the root alarm owner.

**OOM circuit breaker** — `maxAlarmMemoryLimitStrikes` (default: 3). If the DO is reset from memory pressure `N` times in a row (detected by counting alarm-based resets), the DO seals itself (rejects new connections and requests) and emits an `alarm:memory_limit_reset` observability event.

**Sub-agents (Facets)** — `this.subAgent(ClassName, name)` creates a DurableObjectStub for a child Agent with the given name. The parent embeds a `_cf_parent_path` metadata into the child; `this.parentAgent(Cls)` inverts the reference. Facets are separate DOs — isolated SQLite, isolated eviction — but colocated by convention (same account, same colo if using named IDs). The parent's keepAlive tokens extend into child facets. Agent tool children can be re-attached after parent eviction via `_reattachAgentToolRunToTerminal`.

**MCP client** — `this.mcp` is an `MCPClientManager`. Agents connect to external MCP servers via `this.mcp.connect(...)`. The manager handles stdio/SSE/HTTP transports, per-server connection pooling, and reconnection. Elicitation support was added in PR #1903 (July 9, 2026). `McpAgent` is the flip side: a DO class that _serves_ an MCP endpoint, routing stdio/SSE/HTTP transports to an MCP server object. Persistent DO-based OAuth is also supported (`do-oauth-client-provider.ts`).

**Observability** — `this.observability` emits typed events (`AgentObservabilityEvent`). Events cover: `state:update`, `rpc`, `rpc:error`, `message:request/response/clear/cancel/error`, `tool:result`, `tool:approval`, `schedule:create/execute/cancel/retry/error`, `queue:create/retry/error`, `submission:create/status/error`, `action:ledger:replayed`, `alarm:memory_limit_reset`. These are internal SDK events, not persisted; consumers must attach their own sink via `onObservabilityEvent` or similar.

---

## Topic-by-Topic Analysis

### Tool Calls

**Integration:** Tools are standard Vercel AI SDK `ToolSet` — the `tool({ description, parameters, execute })` helper. `streamText()` drives the agentic loop; the SDK passes `tools` to each call. Tool calls are streamed to the client in real time as the model produces them.

**Human-in-the-Loop (HITL):** Design doc: `~/src/github.com/cloudflare/agents/design/think-execute-hitl.md`. When a tool needs approval, it returns `{ status: "paused", executionId, pending }` as a normal tool output. The model narrates the pause and the turn ends naturally. The client can call `approveExecution(executionId)` or `rejectExecution(executionId)` — both are `@callable` methods that resume the paused execution. The approval can arrive hours later; the durable fiber keeps the execution registered. The `ToolSetConnector` maps individual tools to `needsApproval: true`. Observability events: `tool:approval { toolCallId, approved }`.

**Agent Tools:** (`design/rfc-detached-agent-tools.md`) A child Think/AIChatAgent runs as an AI SDK tool — `agentTool(ChildClass, name)`. The child keeps its own messages, tools, SQLite, and resumable stream. The parent broadcasts `agent-tool-event` frames for inline UI rendering. Parent eviction is handled by `_reattachAgentToolRunToTerminal` (two-pass: inspect then re-attach still-running children in parallel, each with its own timeout budget).

**iterate comparison (design-improvements.md):** iterate's "codemode" is a single tool: emit one async JS function whose return value is the next input. This is simpler but inextensible without rearchitecting the tool surface. The CF SDK's AI SDK integration makes arbitrary tool sets first-class. HITL is not present in iterate's current design; the closest primitive would be pausing on a pending `input-added` event with a specific channel/type.

---

### Truncation / Context Management

**Not present in base `Agent`.** Context management lives in Think's `Session` class.

**Session compaction:** `~/src/github.com/cloudflare/agents/packages/agents/src/experimental/memory/session/session.ts`. The session stores messages in an SQLite table with a `parent_id` column (tree-structured for branching/regeneration). A recursive CTE reconstructs the linear chain for any branch head.

`compactAfter(tokenThreshold, options)` registers a token threshold. After each assistant message, the session estimates token count (via a custom `tokenCounter` or a built-in estimator). When the threshold is exceeded, it fires the registered `onCompaction(fn)` callback with the full message history, receives a `CompactResult`, and stores it as an overlay in `assistant_compactions`. The overlay is non-destructive — the full history is still readable via `getHistory({ includeCompacted: true })`; the model's context view uses the compacted summary + tail.

Iterative compaction is supported: subsequent compactions extend from the earliest existing compaction's start, so each overlay trims progressively more history.

**ContextBlocks:** Model-writable persistent memory attached to the session. The model can read and write named blocks that persist across turns (think scratchpad / facts). FTS5 full-text search over message history is also provided.

**iterate comparison (items 3, 4, 11):** iterate has no compaction today. The design is well-specified in design-improvements.md items 3+4: typed usage folded from events → utilization = totalTokens/contextWindow → `history-compacted { floorOffset, summary }` event. The CF approach is notably similar in spirit (overlay, non-destructive, tail preserved) but theirs is on an in-DO object while iterate's would be an event on the stream — meaning the compaction event is itself replayable and race-free by construction (design-improvements.md item 4 notes this explicitly).

---

### Steering / Message Concurrency

**AIChatAgent** (the lower-level class) has `messageConcurrency` strategies extracted into a `SubmitConcurrencyController` (exported from `agents/chat`): `queue` | `latest` | `merge` | `drop` | `debounce`.

- `queue`: new submits wait behind the current turn.
- `latest`: a new submit cancels the pending one.
- `merge`: pending submits are merged into the current context.
- `drop`: overlapping submits are silently dropped.
- `debounce`: waits N ms before admitting, coalescing rapid submits.

Think also picks up the same `SubmitConcurrencyController` (CHANGELOG entry for shared extraction).

**iterate comparison (item 5):** iterate's `pendingTriggerOffset` is effectively `queue` semantics — a single waiting slot. The design-improvements.md item 5 proposes lanes (conversation vs compaction) with per-lane generation counters. The CF approach of named strategies is a user-facing API choice; iterate's is a lower-level invariant of the processor contract.

---

### Sub-agents

**`this.subAgent(ClassName, name)`** creates a DurableObjectStub for a child Agent (any Agent subclass, including Think or AIChatAgent). The child:
- Has its own isolated SQLite database.
- Is a separate DO instance — separate eviction, separate lifecyle.
- Is given a `_cf_parent_path` so it can call `this.parentAgent(ParentClass)` to reach back.
- Is referenced by name; if you call `subAgent(Cls, "foo")` twice you get the same DO.

**Agent Tools** are the "agent-as-AI-tool" variant — the parent orchestrates a child Turn via the AI SDK tool protocol, streaming child progress as `agent-tool-event` frames. The child gets `reportProgress()` to send interim updates.

**iterate comparison:** iterate has no sub-agent primitive. The closest pattern is spawning a separate agent instance via `itx.agents.create(...)`, but there's no structured parent/child lifecycle or result-collection protocol. Agent Tools are particularly interesting for iterate's codemode pattern: the "agent running a script" could itself be a sub-agent tool.

---

### Compaction

Covered above. Key design differences from iterate's planned approach:

| CF Think Session | iterate planned (design-improvements.md items 2–4) |
|---|---|
| Overlay stored in DO SQLite | `history-compacted` event appended to stream |
| Non-destructive (full history readable) | Non-destructive (events remain; compaction event is tail) |
| `compactAfter(tokenThreshold)` callback | Processor-owned; fires after `utilization` threshold |
| Token counter is pluggable | Provider owns `model → contextWindow` mapping |
| Compaction blocks the turn lane | Initially blocking; item 5 proposes non-blocking compaction lane |
| FTS5 full-text search over messages | No equivalent planned |

---

### Interruptions / Cancellation

**AbortSignal threading:** `streamText()` receives an `AbortSignal`. When the client sends a `cf_agent_chat_cancel` WebSocket message, the framework aborts the current streaming call. The AI SDK respects the signal and cancels the HTTP request to the provider.

**iterate comparison (item 9):** iterate's `llm-request-cancelled` updates the fold but the provider execution keeps running. The openai-ws socket-read loop doesn't see the cancellation signal; the cloudflare-ai processor has no abort propagation at all. This is a known gap — the CF SDK's signal threading is the pattern to follow.

---

### Resumable Streaming

**Design:** Each response chunk is written to SQLite (via `ResumableStream`). When a WebSocket client reconnects (or a new tab opens), it sends `cf_agent_stream_resume_ack` with the last chunk index it received. The framework replays buffered chunks from that index. This survives DO eviction: the chunk buffer is in SQLite, so it's durable. The `isReplayChunk()` helper lets stream broadcasters skip re-broadcasting tool-call replay chunks that would visually regress UI state (AI SDK v6 mutates existing tool parts in-place on `toolCallId` match).

**keepAlive during streaming:** `keepAliveWhile(streamText(...))` prevents eviction while a turn is running. If eviction happens anyway (OOM, DO reset), `chatRecovery` takes over.

**chatRecovery:** When `chatRecovery = true` (or a `ChatRecoveryConfig`), every turn entry path is wrapped in `runFiber()`. On DO eviction mid-turn, the fiber is re-entered; the engine consults the last stored chunk to determine whether to continue (resume) or retry (restart). The `ChatRecoveryAdapter` seam (`~/src/github.com/cloudflare/agents/packages/agents/src/chat/recovery-engine.ts`) provides `_chatRecoveryContinue` and `_chatRecoveryRetry` schedule callbacks.

**iterate comparison:** iterate's crash recovery is the event-sourced fold — replay everything up to the request's offset, restart the request. This is semantically equivalent to `chatRecovery = retry` but is automatic and requires no special configuration. The difference: CF's resumable-stream approach lets the client pick up mid-stream on reconnect (chunk-level fidelity), while iterate replays the response from scratch (token-level duplication at the model). Iterate does journal raw frames as events, but the UI has to re-fold them — it's not a "resume from offset N" protocol.

---

### Timeouts

**Do-alarm-based:** `keepAliveIntervalMs` (default 10s) governs the heartbeat that prevents eviction. If no keepAlive is active and no connections remain, the DO goes to sleep naturally after Cloudflare's inactivity period (~30s-few minutes).

**Fiber recovery age:** `fiberRecoveryMaxAgeMs` (default: 1 hour). Fibers older than this are eligible for recovery; fresh fibers are left alone (they may still be completing normally).

**Agent tool timeouts:** Child agent tool runs have explicit timeout budgets (`DEFAULT_AGENT_TOOL_RECOVERY_TIMEOUT_MS`). The two-pass re-attach logic gives each child its own timeout so a slow child can't block siblings.

**iterate comparison:** iterate has no explicit per-turn timeout today. The `consecutiveLlmFailures` counter provides a soft circuit breaker; the `MAX_CONSECUTIVE_SCRIPT_TURNS` constant (24) limits codemode self-loops. There's no equivalent of keepAlive — the DO is kept alive by Cloudflare's default inactivity window.

---

### Background Processes / Scheduling

**`this.schedule(when, callback, data)`** — one-shot. `when` is a `Date`, delay number (ms), or cron string. Writes a row to `cf_agents_schedules`, arms a DO alarm. On alarm fire, the framework executes the named method with the stored data.

**`this.scheduleEvery(interval, callback, data)`** — recurring. Re-arms automatically after each execution.

**Workflows integration:** Not present in the base SDK. There are no Cloudflare Workflows bindings in the Agent class itself. Workflows can be called from inside an Agent method via normal env bindings, but there's no first-class integration.

**Email/queue adapters:** The observability type includes `queue:create`, `queue:retry`, `queue:error` events — the agent can enqueue work. There's no dedicated `onEmail` handler in the base Agent class; email inbound requires a separate Queue Consumer or Email Worker that dispatches to the Agent via `fetch` or DO stub.

**iterate comparison:** iterate's `itx.agents.scheduler` provides cron-style scheduling that appends `scheduled-input` events to the agent stream. The CF approach stores schedules in SQLite alongside state — both survive eviction, but the CF approach is tied to DO alarms while iterate's scheduler is a separate DO.

---

### Streaming / How Chunks Reach the Client

**Path:** `streamText()` → AI SDK internal streaming → `toUIMessageStream()` → Agent's WebSocket broadcast → client `useAgentChat()` hook.

**Protocol:** The `cf_agent_chat_*` WebSocket message family:
- `cf_agent_chat_request` — client submits a new turn
- `cf_agent_chat_response` — server streams AI SDK data stream protocol chunks
- `cf_agent_chat_cancel` — client cancels the current turn
- `cf_agent_tool_result` — client provides a tool result (HITL approval path)
- `cf_agent_stream_resume_ack N` — client requests replay from chunk N

**State snapshot on connect:** On every new WebSocket connection (including post-hibernation), the server sends the current `setState()` value to the client. The `useAgent` hook's `onStateUpdate` fires. This is separate from the chat stream.

**iterate comparison (items 1, 10):** iterate journals raw wire frames as events (one `stream.append` per frame — the write-amplification problem of item 10). The UI reconstructs the response by re-folding all events. CF's model is structurally different: chunks go to a separate resumable buffer, not the main event log. This means CF's streaming doesn't pollute the event log, but it also means you can't replay the exact streaming sequence as part of an audit trail. Iterate's approach gives you a full event history; CF's gives you ergonomic real-time streaming with a separate durable buffer.

---

### Significant PRs / Design Archaeology

Drawn from `packages/agents/CHANGELOG.md` and `packages/think/CHANGELOG.md`:

- **PR #1903** (July 9, 2026) — MCP elicitation support added to `MCPClientManager`.
- **PR #1826 / #1831** — Fiber recovery and OOM circuit breaker finalized.
- **PR #1695** — `runFiber` + `stash` API shipped; durable execution recovery.
- **PR #1613** — ResumableStream shipped; chunk buffering + `cf_agent_stream_resume_ack` protocol.
- **Think roadmap phases 0–5** (all complete per `design/think-roadmap.md`):
  - Phase 0: extract shared chat primitives from AIChatAgent
  - Phase 1: Session integration (tree-structured messages, compaction)
  - Phase 2: branching / regeneration
  - Phase 3: programmatic API (`saveMessages`, `continueLastTurn`)
  - Phase 4: `chatRecovery` (fibers wrapping every turn entry)
  - Phase 5: `messageConcurrency` strategies (queue/latest/merge/drop/debounce)
- **Blog post** — "Project Think: building the next generation of AI agents on Cloudflare" (Apr 15, 2026): https://blog.cloudflare.com/project-think/
- **RFC: Think Channels** — `design/rfc-think-channels.md`: generalizes notification delivery (web/voice/email/push) via `configureChannels()` and `deliverNotice()`. v1 shipped.
- **RFC: Think Turns** — `design/rfc-think-turns.md`: seven admission paths, `_admitTurn` spine, `addMessages` API. All shipped.
- **RFC: Think Execute HITL** — `design/think-execute-hitl.md`: HITL bridge for durable code execution approvals.

---

## Architecture Comparison: Snapshot vs Event-Sourced

### CF Agents (Snapshot Model)

```
User message
    ↓
onChatMessage() / _admitTurn()
    ↓
streamText() — AI SDK
    ↓
Chunks → ResumableStream (SQLite) → WebSocket broadcast
    ↓
setState(newState) → SQLite blob → WebSocket snapshot broadcast
    ↓
Session.appendMessage() → cf_agent_chat_messages row
```

**Wins:**
- Ergonomic: `setState({ count: 1 })` and all clients receive the new state instantly.
- Streaming resume is chunk-precise: client reconnects at exactly where it left off.
- compaction is non-destructive and pluggable at a high level (`compactAfter(N)`).
- chatRecovery is a one-liner opt-in that survives DO eviction during streaming.
- HITL pause/resume is first-class and persisted via fiber IDs.
- Sub-agent / facet pattern is mature, with bidirectional parent↔child stubs.

**Costs:**
- State is mutable: a bug can corrupt state silently; no audit trail of changes.
- No causal ordering: two concurrent `setState()` calls can interleave without a merge strategy.
- Context window management is a configuration concern (compactAfter threshold) not an intrinsic property of the turn model.
- Recovery is bolted on (chatRecovery opt-in wraps with fibers); if not enabled, eviction mid-turn loses progress.

### iterate (Event-Sourced Model)

```
User input
    ↓
stream.append(agent/input-added)
    ↓
Processor fold: reduce(state, event) → new state
    ↓
Side effect: stream.append(agent/llm-request-scheduled)
    ↓
Provider: buildPrompt by folding events up to request offset
    ↓
Provider: journal raw frames as stream events
    ↓
Browser: fold events → UI state
    ↓
Recovery: replay fold from any offset — no special recovery mode needed
```

**Wins:**
- Full audit trail: every state change is a first-class event with an offset.
- Crash recovery by construction: replay the fold — no chatRecovery flag needed.
- Compaction is a first-class event (`history-compacted { floorOffset, summary }`) — race-free, replayable, and the provider can include/exclude it by offset.
- Context window management can be precise: provider owns `model → contextWindow` mapping and stamps it on events.
- The event log is the source of truth for every subscriber (stream view, audit, analytics).

**Costs (matching design-improvements.md items):**
- **Item 11:** O(history) re-fold on every request — grows unbounded; CF's Session doesn't have this (it reads the compacted linear chain).
- **Item 10:** One `stream.append` per wire frame — write amplification; CF buffers chunks in a separate resumable stream, no event-log pollution.
- **Item 1:** Normalization boundary in the browser (provider-specific dialects); CF's AI SDK abstraction normalizes at the SDK layer.
- **Item 9:** Cancellation doesn't abort the provider; CF's AbortSignal threads through.
- **Item 5:** Single `currentRequest` slot serializes everything; CF's `messageConcurrency` strategies give explicit semantics.
- **Items 2–3:** Usage is untyped, no context-window mapping; CF's AI SDK integration normalizes usage automatically.
- **Items 6–7:** openai-ws `previousResponseId` and `executionChain` are internal serialization artifacts with no CF equivalent (CF uses standard AI SDK with per-request calls).
- **Item 8:** cloudflare-ai lacks orphan-recovery sweep; CF's fiber model handles this at the framework level.

---

## Implications for iterate (Design-Improvements Cross-Reference)

### Item 1 (Normalized streaming-delta abstraction)
CF's AI SDK integration outputs normalized `UIMessage` parts (text, tool-call, reasoning) regardless of provider. The `toUIMessageStream()` function handles dialect translation. **Action:** adopt a provider-agnostic `agent/output-delta { channel, delta }` event that providers translate to before appending, so the browser fold only speaks one dialect.

### Items 2 + 3 (Untyped usage, no context-window limits)
CF normalizes usage automatically via the AI SDK (`usage.promptTokens`, `usage.completionTokens`). The `model → contextWindow` mapping lives in AI SDK model definitions. **Action:** providers normalize to `{ inputTokens, outputTokens, totalTokens }` and stamp `contextWindow` on `llm-request-started`; the processor folds `utilization`.

### Item 4 (Compaction)
CF's `Session.compact()` + `compactAfter(N)` is the most mature compaction implementation in the wild. Key implementation detail: overlay is non-destructive (full history remains in SQLite; model's context view uses the overlay). The CF pattern maps cleanly to iterate's `history-compacted` event: append the event, providers filter history by `floorOffset`. One advantage of iterate's approach: the compaction event is part of the audit log and can be replayed.

### Item 5 (Single currentRequest slot)
CF's `messageConcurrency` strategies provide explicit semantics for the four cases (queue/latest/merge/drop). **Action:** when iterate adds a compaction lane, adopt named-lane terminology rather than ad-hoc mutex logic. The CF pattern of per-controller state (pending-enqueue protection, debounce timers) is worth lifting directly.

### Item 6 (openai-ws previousResponseId + compaction)
This is a CF-specific gap for iterate: the CF SDK makes a fresh `streamText()` call on each turn (standard stateless API), so there's no server-side context chain to break. iterate's openai-ws provider keeps a continuation chain that compaction must reset. **Action:** `history-compacted` handler in openai-ws provider must zero `#previousResponseId`.

### Item 9 (Cancellation abort propagation)
CF threads an `AbortSignal` from the client `cf_agent_chat_cancel` message into `streamText()`. This is the correct pattern — **action:** `llm-request-cancelled` event handler in the provider should call `abortController.abort()` on the in-flight request.

### Item 10 (Chunk write amplification)
CF's ResumableStream keeps chunks in a separate SQLite buffer, not the main message log. The event log (message history) only grows per turn, not per chunk. **Action:** coalesce raw frame events OR make them best-effort while the normalized `output-delta` lane carries the UI. The ResumableStream design is an existence proof that "durable chunk buffer" ≠ "event log pollution."

### Item 11 (Re-fold on every request)
CF's `Session.getHistory()` returns the compacted linear chain directly — O(compacted history), not O(all history). After compaction, the re-read cost is bounded. For iterate: compaction bounds the prompt but not the replay (events remain). **Action:** checkpointed agent state for prompt building (read the processor's folded state instead of a fresh fold); or a "read from tail" optimization for the currency check.

### Not in design-improvements.md — worth considering:

- **ContextBlocks:** CF's model-writable persistent memory (facts/scratchpad persisting across turns) has no iterate equivalent. Could map to a special `agent/context-block-updated` event.
- **Channels:** CF's `deliverNotice()` generalizes notification delivery across web/voice/email. iterate's `output-added` is implicitly the "web" channel; multi-channel delivery would need explicit `DeliveryKind` tagging on outputs.
- **FTS5 search:** CF's `Session` includes full-text search over message history. Not a current iterate pain point but worth noting for future agent memory features.
- **HITL:** Not present in iterate. The CF fiber-based pause/resume pattern (a tool returns a paused status, `approveExecution()` resumes it durably) maps well to iterate's event model: a `tool-approval-requested` event with an `executionId` that a later `tool-approved` / `tool-rejected` event references.

---

## Key Reference Paths

| Topic | Path |
|---|---|
| Agent base class | `~/src/github.com/cloudflare/agents/packages/agents/src/index.ts` |
| Think design doc | `~/src/github.com/cloudflare/agents/design/think.md` |
| Think roadmap | `~/src/github.com/cloudflare/agents/design/think-roadmap.md` |
| HITL design | `~/src/github.com/cloudflare/agents/design/think-execute-hitl.md` |
| Channels RFC | `~/src/github.com/cloudflare/agents/design/rfc-think-channels.md` |
| Turns RFC | `~/src/github.com/cloudflare/agents/design/rfc-think-turns.md` |
| Session (compaction, ContextBlocks, FTS5) | `~/src/github.com/cloudflare/agents/packages/agents/src/experimental/memory/session/session.ts` |
| Chat recovery engine | `~/src/github.com/cloudflare/agents/packages/agents/src/chat/recovery-engine.ts` |
| MCP client | `~/src/github.com/cloudflare/agents/packages/agents/src/mcp/client.ts` |
| MCP agent (server-side) | `~/src/github.com/cloudflare/agents/packages/agents/src/mcp/index.ts` |
| Observability events | `~/src/github.com/cloudflare/agents/packages/agents/src/observability/agent.ts` |
| iterate design improvements | `/Users/jonastemplestein/.superset/worktrees/iterate/rigorous-squash/apps/os/src/domains/agents/design-improvements.md` |
| iterate agent processor contract | `/Users/jonastemplestein/.superset/worktrees/iterate/rigorous-squash/apps/os/src/domains/agents/agent-processor-contract.ts` |
