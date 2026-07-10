# OpenCode Architecture Research

Research date: 2026-07-09. OpenCode repo: `~/src/github.com/sst/opencode`. Worktree for 2.0 branch: `~/src/opencode-2.0`.

---

## TL;DR

OpenCode is a coding-agent CLI with a clean client/server split: a long-lived server process exposes sessions over HTTP+SSE; TUI, web, and IDE extensions are all clients. The v1 codebase (`packages/opencode/`) is stable and shipped. "v2" is an active ground-up rewrite (`packages/core/`) on the `v2` branch, with feature branches (`feat/core-v2-background-agent`, `feat/core-v2-overflow-recovery`, `execute-code-mode-v2`) ahead of it. The most interesting mechanism for iterate is the **durable/ephemeral event split**: v2 explicitly marks delta events (text chunks, tool-input deltas, reasoning fragments) as ephemeral (not stored, not replayed), while the "ended" boundary events are durable. This maps directly onto our design-improvements.md item #10. The **two-delivery steering model** (`steer` vs `queue`) and the **SessionRunCoordinator** run/wake/coalesce FSM are also directly applicable.

---

## What Is v2?

### Branch topology

| Branch | Package | Status | Description |
|---|---|---|---|
| `origin/dev` | `packages/opencode/` | Active stable | Main development, shipped to users |
| `origin/v2` | `packages/core/` | Active rewrite | Full ground-up rewrite; parallel to dev, 726 commits diverged each way |
| `origin/feat/core-v2-background-agent` | `packages/core/` | Feature branch | Background-agent work on top of v2 |
| `origin/feat/core-v2-overflow-recovery` | `packages/core/` | Feature branch | Overflow recovery on top of v2 |
| `origin/execute-code-mode-v2` | `packages/core/` | Feature branch | Code Mode as service + grouped/deferred tool registration |
| `origin/2.0` | `packages/opencode/src/v2/` | Abandoned spike | April 2026 exploration; session-event/entry schema sketch; not merged |

The `2.0` branch (`~/src/opencode-2.0`) is an abandoned early exploration. Do not confuse it with the v2 rewrite. The `v2` branch with `packages/core/` is the actual v2.

### Design discussions / public references

- No dedicated GitHub issues or PRs for "v2 design" were found via `gh issue list / pr list --repo sst/opencode --search "v2 core"`. The v2 work appears to be driven internally with individual feature PRs.
- The feature branches are PR-based on the `v2` branch: `feat/core-v2-background-agent`, `feat/core-v2-overflow-recovery`.
- The "execute-code-mode-v2" branch references internal issue `#35232` (grouped/deferred tools), `#35572` (split interpreter and stdlib), `#36026` (interpreter docs). These are in an internal tracker.
- Public announcement: none found. The `v2` branch is not yet released.

---

## Storage and Event Model

### v1 (packages/opencode/) — SQLite via Drizzle ORM

Persistence: SQLite. Three core tables: Sessions, Messages, Parts.

- **Session**: `{ id, parentID?, title, model, ... }` — a conversation; may have a parent for subagents.
- **Message**: `{ id, sessionID, role: "user"|"assistant", mode: "compaction"?, summary? }` — one turn.
- **Part**: typed rows for each content fragment within a message.

Part types (file: `~/src/github.com/sst/opencode/packages/opencode/src/session/message-v2.ts`):
```
TextPart        — { text }
ReasoningPart   — { text }
FilePart        — { url, mime }
ToolPart        — { tool, input, output, state: pending|running|completed|error }
CompactionPart  — { summary, tail_start_id? }
SubtaskPart     — { sessionID, task }
RetryPart       — { attempt, error }
StepStartPart / StepFinishPart
AgentPart
```

**No append-only event log in v1.** Parts are upserted by type; the compaction flow creates a new "compaction" message but keeps history rows in place.

The v1 event bus is in-process only: `~/src/github.com/sst/opencode/packages/opencode/src/bus/index.ts` — Effect PubSub, wildcard + per-type subscriptions, no persistence. SSE at `GET /event` fans out all bus events live; clients reconnect and re-fetch history from SQLite.

### v2 (packages/core/) — Append-only durable event log

File: `~/src/github.com/sst/opencode/packages/core/src/event.ts`

v2 introduces a proper append-only event log with two SQLite tables:
- `EventTable`: `{ id, aggregate_id, seq, type, data }` — one row per durable event, monotonic seq per aggregate.
- `EventSequenceTable`: `{ aggregate_id, seq, owner_id }` — latest committed seq + optional owner (for leadership/claim).

**Publish** writes to `EventTable` and bumps `EventSequenceTable`, then fans out to an in-process PubSub. **Projectors** run synchronously on publish (e.g. to write to auxiliary tables like `SessionInputTable`).

**`events.log({ aggregateID, after?, follow? })`** — the core read primitive. Returns historical events from SQLite up to the current seq, then optionally transitions to live via PubSub subscription. Emits a `Synced` marker at the replay watermark. This is the "read from compaction forward" primitive.

**Durable vs Ephemeral events** — the central v2 design decision:

File: `~/src/github.com/sst/opencode/packages/core/src/session/event.ts`

```typescript
// Durable (stored, replayed):
SessionEvent.Text.Started      — { sessionID, assistantMessageID, stepID }
SessionEvent.Text.Ended        — { sessionID, assistantMessageID, text }  // full final text
SessionEvent.Tool.Input.Ended  — { sessionID, ..., input: string }        // full final input
SessionEvent.Reasoning.Ended   — { sessionID, ..., text: string }
SessionEvent.Compaction.Started / Compaction.Ended
SessionEvent.Step.Started / Step.Ended / Step.Failed
SessionEvent.Tool.Called / Tool.Success / Tool.Failed
SessionEvent.Prompted { delivery: "steer" | "queue" }
SessionEvent.PromptLifecycle.Admitted / PromptLifecycle.Promoted
SessionEvent.InterruptRequested
SessionEvent.Tool.Progress     — durable bounded checkpoint (not every chunk)

// Ephemeral (live-only, NOT stored):
SessionEvent.Text.Delta        — stream fragment
SessionEvent.Tool.Input.Delta  — partial tool JSON
SessionEvent.Reasoning.Delta   — thinking fragment
SessionEvent.Compaction.Delta  — compaction-LLM streaming text
```

The comment on `Text.Delta` in the source:
> "Stream fragments are live-only; Text.Ended is the replayable full-value boundary"

The `Durable` manifest (`packages/core/src/event.ts:79`) gates what is written to `EventTable`. Ephemeral events are published to the in-process PubSub (for live SSE clients) but never written to SQLite.

**History load** (`~/src/github.com/sst/opencode/packages/core/src/session/history.ts`): finds the latest `Compaction.Ended` event, reads all durable events from that seq forward. System messages (above the baseline) are merged in separately. The "read from compaction forward" model is explicit: pre-compaction events are inaccessible from the runner after compaction.

**Session projection** — `packages/core/src/session/store.ts`:
- `store.context(sessionID)`: projected `SessionEntry` list (User / Assistant / Compaction entries) for prompt building.
- `store.get(sessionID)`: session metadata.

`SessionEntry` (v2 projected view, `packages/core/src/session/store.ts` aggregates from event projectors):
```typescript
// User entry — from Prompted event
// Assistant entry — from Step.Started → Text.Ended + Tool.Called + Tool.Success/Failed
// Compaction entry — from Compaction.Ended
```

The v2 model is: **events are truth, projections are derived**. The runner rebuilds context from the projection on each turn (not by re-folding raw events).

---

## Streaming / SSE Protocol

### v1

File: `~/src/github.com/sst/opencode/packages/opencode/src/server/routes/instance/event.ts`

- `GET /event` — SSE endpoint, subscribes to all bus events.
- Wire format: `data: {"type":"session.message.updated","properties":{...}}\n\n`
- Heartbeat every 10 seconds: `data: {}\n\n`
- `server.connected` event on client connect; `server.instance.disposed` closes the stream.
- Clients re-fetch SQLite history on reconnect; the event stream carries only live deltas (no replay).

Bus event categories visible on the SSE stream:
- `session.updated`, `session.message.updated` — full message rows (for UI fold)
- `session.status` — `idle | retry | busy`
- Tool progress, file events, etc.

**v1 key property**: SSE events carry full denormalized objects (whole message rows), not diffs. The TUI re-renders from the full state.

### v2

v2 separates durable events (in EventTable, replayable) from ephemeral events (SSE-only). Clients that reconnect call `events.log({ aggregateID: sessionID, follow: true })` to get history-then-live in one stream. The Synced marker tells the client when replay is complete and live begins.

Ephemeral delta events (`Text.Delta`, `Tool.Input.Delta`, `Reasoning.Delta`) are emitted only on the live PubSub subscription; they do not appear on reconnect replay. The `Text.Ended` event carries the full assembled text and IS replayed.

This is a clean analogue to our agent stream's distinction between "raw chunk journal" and normalized output events.

---

## Tool Calls

### v1

File: `~/src/github.com/sst/opencode/packages/opencode/src/tool/tool.ts`

```typescript
Tool.Def = { id, description, parameters, execute(args, ctx): Effect<ExecuteResult> }
Tool.Context = { sessionID, messageID, agent, abort: AbortSignal, callID, extra,
                 messages, metadata(), ask() }
```

- Tools are registered by ID; the session runner builds the advertised set per request.
- Parallelism: tool calls within a single step start eagerly (each as an Effect fiber); the runner awaits all before continuing. `Deferred.make<void>()` per call.
- No parallelism across steps — steps are sequential.
- Permission gates: `allow/deny/ask` rules per tool name, with wildcard patterns. The `ask()` function in `Tool.Context` presents a permission prompt to the user; declining halts the drain via `PermissionV2.DeclinedError`.
- Tool output is written as a ToolPart (v1) or as `Tool.Success`/`Tool.Failed` events (v2).

### v2

File: `~/src/github.com/sst/opencode/packages/core/src/session/runner/llm.ts`

- Tools are registered in a `ToolRegistry` service and materialized per-request via `tools.materialize({ permissions, model })`.
- Each `tool-call` event from the LLM stream starts a fiber immediately (`FiberSet`); all owned fibers are joined before continuation.
- Tool calls are durably recorded before side effects (`Tool.Called` event) — "record before execute" pattern.
- Failed permission or `QuestionTool.CancelledError` → `UserInterruptedError` → `Effect.interrupt` (drain halts).
- `StepFailedError` for `permission.rejected` → recorded as `Step.Failed` event.
- Tool outputs are written as `Tool.Success` / `Tool.Failed` events, durably stored.
- `ToolOutputStore`: side-table for large tool outputs (avoids bloating EventTable rows).

**Tool result settlement is gated by `uninterruptibleMask`**: once a tool starts, its result publication cannot be interrupted mid-write.

---

## Truncation and Overflow Recovery

### v1 thresholds

File: `~/src/github.com/sst/opencode/packages/opencode/src/session/overflow.ts`
```typescript
usable(cfg, model) = model.limit.input - reserved
reserved = min(20_000, maxOutputTokens)
isOverflow(tokens, model) = tokens.total >= usable
```

File: `~/src/github.com/sst/opencode/packages/opencode/src/session/compaction.ts`
```typescript
PRUNE_MINIMUM    = 20_000  // tokens below which pruning is not attempted
PRUNE_PROTECT    = 40_000  // tokens to protect from pruning
TOOL_OUTPUT_MAX_CHARS = 2_000  // max chars preserved per tool output
DEFAULT_TAIL_TURNS = 2
MIN_PRESERVE_RECENT_TOKENS = 2_000
MAX_PRESERVE_RECENT_TOKENS = 8_000
```

`prune()` erases old tool output text (marks `time.compacted`) in-place. `select()` estimates tail budget, preserves recent N turns, computes head vs recent split.

### v2 thresholds

File: `~/src/github.com/sst/opencode/packages/core/src/session/compaction.ts`
```typescript
DEFAULT_BUFFER         = 20_000
DEFAULT_KEEP_TOKENS    = 8_000
TOOL_OUTPUT_MAX_CHARS  = 2_000
SUMMARY_OUTPUT_TOKENS  = 4_096
```

Settings come from config documents (`{ auto, buffer, tokens }`), not hardcoded config objects. Same 8-section (v1) / 6-section (v2) summary template (see below).

**Overflow detection in v2 LLM runner** (`~/src/github.com/sst/opencode/packages/core/src/session/runner/llm.ts`):
- `isContextOverflowFailure(event)` checks the provider error event type.
- If overflow occurs before any assistant output and a `recoverOverflow` hook is present, the runner calls `compaction.compactAfterOverflow(...)` and returns `RestartAfterOverflowCompaction`.
- The outer `runStep` loop then retries `attemptStep` without the overflow-recovery hook (one-shot: a post-compaction step cannot trigger another overflow compaction).
- If compaction was already pending (`SessionInput.pendingCompaction`), overflow recovery is skipped.

---

## Compaction

### v1

File: `~/src/github.com/sst/opencode/packages/opencode/src/session/compaction.ts`

Trigger: `processor.ts` sets `ctx.needsCompaction = true` when overflow is detected in the stream. Compaction runs inline in the step loop (blocking).

`processCompaction()`:
1. Creates a new "compaction" message (`mode: "compaction", summary: true`).
2. Builds summary prompt from 8 sections.
3. Calls LLM synchronously.
4. On success with `auto: true`: replays the overflow-triggering user message into a fresh step.

Summary template (v1, 8 sections): Goal, Constraints & Preferences, Progress (Done/In Progress/Blocked), Key Decisions, Next Steps, Critical Context, Relevant Files.

### v2

File: `~/src/github.com/sst/opencode/packages/core/src/session/compaction.ts`

Summary template (v2, 6 sections): Objective, Important Details, Work State (Completed/Active/Blocked), Next Move, Relevant Files. Deliberately more concise.

Compaction events:
- `SessionEvent.Compaction.Started` — durable, marks start.
- `SessionEvent.Compaction.Delta` — ephemeral (live SSE only).
- `SessionEvent.Compaction.Ended { messageID, reason: "auto"|"manual", text, recent }` — durable, the replay boundary.

**`Compaction.Ended` is the history floor**: `SessionHistory.load` finds the latest `Compaction.Ended` row and reads durable events from that seq forward. Events before that seq are never replayed to the runner.

Pending compaction gates new user inputs: `SessionInput.hasPending(db, sessionID, "steer")` returns false if `pendingCompaction` is set. The runner must drain the compaction before accepting steering.

Compaction is NOT a separate lane in the current code — it runs inline in `attemptStep` via `compactIfNeeded` before the LLM call. Non-blocking parallelism is future work (per the runner comments).

---

## Steering (User Messages Mid-Run)

### v1

File: `~/src/github.com/sst/opencode/packages/opencode/src/session/processor.ts`

v1 is simpler: the `doom loop` check (`consecutiveToolCalls >= DOOM_LOOP_THRESHOLD = 3`) and `shouldBreak` flag. Mid-run user messages are not modeled explicitly; the user can interrupt (ESC) which aborts the current stream.

### v2

File: `~/src/github.com/sst/opencode/packages/core/src/session/event.ts`, `input.ts`, `runner/llm.ts`

v2 introduces **two-phase prompt admission**:

1. `Prompted` event is published with `delivery: "steer" | "queue"`.
2. `PromptLifecycle.Admitted` — durable, written by `SessionInput.admit()`. Writes to `SessionInputTable`.
3. `PromptLifecycle.Promoted` — durable, written when the runner is ready to incorporate the input.

**`delivery: "steer"`** — mid-run user message that overrides the current context window. The runner incorporates all pending steers before the next LLM call without waiting for tool completion. Steers are promoted at the start of the next step.

**`delivery: "queue"`** — message that waits until the current turn fully completes before starting a new turn. Queue messages are promoted only when `needsContinuation` is false.

Runner outer loop (`~/src/github.com/sst/opencode/packages/core/src/session/runner/llm.ts`):
```typescript
while (openActivity) {
  for (let step = 0; step < MAX_STEPS; step++) {
    needsContinuation = yield* runTurn(sessionID, promotion)
    promotion = "steer"  // after first turn, always check for steers
    if (!needsContinuation) needsContinuation = yield* hasPending(db, sessionID, "steer")
    if (!needsContinuation) break
  }
  openActivity = yield* hasPending(db, sessionID, "queue")
  promotion = openActivity ? "queue" : undefined
}
```

Steers are consumed every step (even mid-tool-loop). Queue items start new top-level run cycles.

---

## SessionRunCoordinator (Run/Wake/Coalesce)

File: `~/src/github.com/sst/opencode/packages/core/src/session/run-coordinator.ts`

A per-session FSM:

```
idle → draining → draining+pending_rerun → idle
```

- **`run(key)`**: explicit drain (must execute). Dominates `wake` when coalescing. Returns when drain completes.
- **`wake(key, seq?)`**: advisory wake after durable work is recorded. Coalesces: only the newest seq is retained if multiple wakes arrive during a drain.
- **`interrupt(key, seq?)`**: stops the current ownership chain.
- **`awaitIdle(key)`**: wait until FSM is idle.

`SessionExecution.resume(sessionID)` — explicit drain (one provider attempt).
`SessionExecution.wake(sessionID, seq?)` — advisory wake; coalesces.
`SessionExecution.interrupt(sessionID, seq?)` — stops current chain.

The seq parameter on wake/interrupt allows stale operations to detect they've been superseded.

This is analogous to iterate's `pendingTriggerOffset` pattern but more explicit: the FSM states are named, and `run` vs `wake` semantics are formally distinguished.

---

## Subagents

### v1 — task tool

File: `~/src/github.com/sst/opencode/packages/opencode/src/tool/task.ts`

- `TaskTool` creates a child session (`sessions.create({ parentID: ctx.sessionID, ... })`).
- Can resume an existing task by `task_id` (idempotent re-entry).
- Returns `task_id` in output for resumption.
- Abort propagation: `ctx.abort.addEventListener("abort", cancel)` — parent ESC propagates to child.
- Permission restrictions: `canTask`, `canTodo` control what the sub-session's tools can do.
- The sub-session is a full session; it runs in the same server process.

### v2

`packages/core/src/tool/subagent.ts` exists in `execute-code-mode-v2`. v2 subagents are full sessions, same model.

---

## Interruptions

### v1

ESC → `abort` signal → provider stream subscription cancelled → `AbortedError` recorded as a Part. Tool fibers are also interrupted via the shared abort signal. The `doom_loop` threshold (3 consecutive identical tool calls) auto-halts the step loop.

### v2

`SessionEvent.InterruptRequested` — durable event. The runner checks for this signal.

LLM runner handles interruption in `uninterruptibleMask`:
- `streamInterrupted` → `FiberSet.clear(toolFibers)` → `failUnsettledTools("Tool execution interrupted")` → `failAssistant("Step interrupted")`.
- `userDeclined` (`PermissionV2.DeclinedError` or `QuestionTool.CancelledError`) → `Effect.interrupt` (drain halts).
- `permissionRejected` → `UserInterruptedError`.

All unsettled tool calls receive explicit `Tool.Failed` events before the step failure event. The sweep pattern (`failInterruptedTools`) also runs at the start of each drain to close any tools left open by a previous interrupted drain.

---

## Timeouts

### v1

File: `~/src/github.com/sst/opencode/packages/opencode/src/tool/shell.ts` (v1, in packages/opencode):
```typescript
DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000   // 2 min default
MAX_TIMEOUT_MS     = 10 * 60 * 1_000  // 10 min cap
```

No session-level timeout; per-tool timeout only.

### v2 shell tool

File: `~/src/github.com/sst/opencode/packages/core/src/tool/shell.ts` (in execute-code-mode-v2 branch):
Same constants as v1. `MAX_CAPTURE_BYTES = 1024 * 1024` (1 MB stdout cap).

Background shell: `background: true` in tool input → returns `BACKGROUND_STARTED` immediately with `status: "running"`. The shell runs to completion and emits a `Tool.Progress` event (durable) when done. The runner then wakes to continue. Message to model: "You will be notified automatically when the command finishes. DO NOT sleep, poll, or proactively check on its progress."

`Tool.Progress` is explicitly durable in v2 (see event.ts) — it's a bounded checkpoint for long-running tools, not a per-chunk event.

---

## Background Processes

### feat/core-v2-background-agent branch

This branch adds explicit background-agent support. The key change is in `SessionInput`:

The `delivery` field plus `SessionRunCoordinator.wake()` together enable background execution: a background agent can append durable events (e.g. tool results, shell completions) and then call `wake(sessionID)` to trigger a new drain without blocking the caller.

The `run()` vs `wake()` distinction in the coordinator is what makes this safe: `run()` must have a pending prompt to execute; `wake()` is advisory and coalesces. A background shell finishing only needs to `wake`, not `run`.

---

## Code Mode (execute-code-mode-v2)

Key commits:
- `refactor(core): make Code Mode a service` — Code Mode extracted as an Effect service (`CodeModeService`), not a tool.
- `feat(core): expose server API in Code Mode` — the Code Mode interpreter can call back to the OpenCode server API.
- `feat(core): expose deferred tools through execute` — deferred tools (defined at runtime) exposed to Code Mode.
- `refactor(codemode): split interpreter and stdlib` — interpreter and standard library are separate.
- `feat(core): add grouped and deferred tool registration` — tools can be grouped and registered lazily.

This is NOT the same as iterate's "codemode" (where the model's only tool is an async JS function). OpenCode's Code Mode is an interpreter environment (likely a JS/TypeScript REPL) that runs alongside the model, not a replacement for the tool loop.

---

## Implications for Iterate

Mapping to `apps/os/src/domains/agents/design-improvements.md`:

### Item #1 — Normalized streaming-delta abstraction

OpenCode v2 solves this cleanly. **The channel model**: `Text.Delta` (ephemeral), `Tool.Input.Delta` (ephemeral), `Reasoning.Delta` (ephemeral). All are distinct event types on the same PubSub. The UI folds three event types, not one per provider. The "ended" boundary events carry the full assembled value.

**Apply to iterate**: the `agent/output-delta { channel: "text" | "thinking", delta }` direction in design-improvements.md matches exactly. The channel enum absorbs growth without new event types. Ephemeral means: publish to SSE consumers live, never write to the agent stream.

### Item #10 — Chunk write amplification

OpenCode v2 **solves this at the design level**. Delta events are declared ephemeral in a manifest (`Durable.get(event.type)`); the publish path never writes them to SQLite. The `Text.Ended` event (durable) carries the full assembled text. This is the right architecture.

**Apply to iterate**: declare per-provider chunk events as ephemeral (live-broadcast only, not appended to the stream). The normalized `agent/output-delta` (item #1) is also ephemeral. The `agent/llm-request-completed` carries the full assembled output (already true for our `output-added` event).

### Items #3 and #2 — Context-window limits, usage normalization

OpenCode v2: `calculateCost(model.cost, tokens)` in the runner — tokens are typed (`{ input, output, reasoning, cache: { read, write } }`) and the model carries `limit.input`. Usage is normalized at the LLM-package boundary, not per-provider.

**Apply to iterate**: provider normalizes to `{ inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens }` before appending `agent/llm-request-completed`. The agent folds `lastKnownUsage` + `contextWindowTokens` (from model config) → `utilization`. Item #3's "model → contextWindow" lookup lives in the provider, stamped on the event.

### Item #4 — Compaction design

OpenCode v2's `Compaction.Ended` as the **history floor** is the exact pattern design-improvements.md describes: `agent/history-compacted { floorOffset, summary }` replacing history up to `floorOffset`. The "read from compaction forward" in `SessionHistory.load` is the equivalent.

Two key learnings:
1. **Pending-compaction gate**: `hasPending(db, sessionID, "steer")` returns false while compaction is pending. Prevents steering from racing a compaction in flight.
2. **One-shot overflow recovery**: the `recoverOverflow` hook is passed once and cleared after firing. A post-compaction step cannot trigger another compaction → prevents loops.

### Item #5 — Single currentRequest slot

OpenCode v2 does NOT solve this yet. The runner is still sequential per session — `attemptStep` is one step at a time. The coordinator comment says "Replace local ownership with durable multi-node ownership when clustered" is future work. They're in the same boat. The compaction runs inline in `attemptStep` (before the LLM call), not in a parallel lane.

The design-improvements.md direction (lanes with per-lane generation counters) is ahead of where OpenCode is.

### Item #6 — previousResponseId continuation vs compaction

OpenCode doesn't use the Responses API continuation chain — each step sends full message history. The `compactIfNeeded` check runs before `llm.stream(request)`. Because there's no continuation chain, compaction naturally resets the context: the next request is built from the compacted history, full-stop.

**Implication for iterate**: when we compact, we must break the `#previousResponseId` chain in the openai-ws provider. The "full history rebuild after compaction" is not a regression — it's required. Design-improvements.md item #6 is confirmed as necessary.

### Items #8 and #9 — Orphan sweep, cancellation

OpenCode v2's `failInterruptedTools()` runs at the START of each drain — it sweeps for tools left in `streaming` or `running` state from a previous interrupted drain and publishes `Tool.Failed` for each. This is the orphan-recovery pattern.

The `uninterruptibleMask` around tool-result publication ensures partial writes don't happen. Tool cancellation (stream interrupted) → `FiberSet.clear` → all tool fibers cancelled → `failUnsettledTools` sweep.

**Apply to iterate**: the cloudflare-ai provider needs the equivalent of `failInterruptedTools` (item #8). Cancellation should `FiberSet.clear` any in-progress tool fibers, not just update the fold (item #9).

### Item #11 — O(history) replay per request

OpenCode v2 addresses this via the **projected history** in `SessionStore`: `store.context(sessionID)` returns already-projected `SessionEntry` rows, not raw events. The runner calls `SessionHistory.entriesForRunner(db, session.id, checkpoint.baselineSeq)` which reads from the latest compaction forward. This is bounded by construction: compaction truncates the event log floor.

However, within a session (before first compaction), they still re-load history on every step. The design note in the runner: "Coalesce streamed deltas and add covering projected-history indexes" is listed as future work.

**For iterate**: the projection tables (indexed reads of projected state) are the right direction. The agent processor's `buildAgentLlmRequestBody` re-folding all events is the analogous problem; checkpointed state (or reading from projected assistant history) would solve it. Compaction bounds the stream length, making item #11 manageable even without a separate index.

### Steering model maps to pendingTriggerOffset

OpenCode v2's `delivery: "steer" | "queue"` is a more explicit version of iterate's `pendingTriggerOffset`. The two-phase `Admitted → Promoted` lifecycle ensures:
- Admitted events are durable (the prompt is not lost on crash).
- Promoted events trigger the runner.
- The runner only promotes what it can currently absorb.

This is a cleaner design than `pendingTriggerOffset` (a scalar offset). **For iterate**: the `Admitted`/`Promoted` distinction would let us distinguish "prompt received" from "prompt incorporated into the current turn" — useful for accurate delivery guarantees and crash recovery.

---

## Key File References

All paths below are absolute into `~/src/github.com/sst/opencode`.

| Topic | File | Lines |
|---|---|---|
| v2 durable/ephemeral event split | `packages/core/src/session/event.ts` | 1–512 |
| Append-only event log (v2) | `packages/core/src/event.ts` | 1–400 |
| LLM runner — main loop, steering, overflow | `packages/core/src/session/runner/llm.ts` | 1–711 |
| Run coordinator FSM | `packages/core/src/session/run-coordinator.ts` | 1–200 |
| Compaction (v1) — thresholds, select, prune | `packages/opencode/src/session/compaction.ts` | 1–500 |
| Compaction (v2) — template, service | `packages/core/src/session/compaction.ts` | 1–200 |
| Overflow detection (v1) | `packages/opencode/src/session/overflow.ts` | 1–50 |
| Session input — delivery, admit, promote | `packages/core/src/session/input.ts` | 1–360 |
| History load (v2) — compaction floor | `packages/core/src/session/history.ts` | 1–150 |
| SSE event stream (v1) | `packages/opencode/src/server/routes/instance/event.ts` | 1–80 |
| Bus/PubSub (v1) | `packages/opencode/src/bus/index.ts` | 1–100 |
| Task tool (subagents) | `packages/opencode/src/tool/task.ts` | 1–150 |
| Shell tool — background, timeout | `packages/core/src/tool/shell.ts` | 1–80 (execute-code-mode-v2 branch) |
| v1 message/part schema | `packages/opencode/src/session/message-v2.ts` | 1–300 |
| v1 processor — doom loop, tool dispatch | `packages/opencode/src/session/processor.ts` | 1–300 |

Iterate files cross-referenced:
- `apps/os/src/domains/agents/design-improvements.md` — 11 open items
- `apps/os/src/domains/agents/agent-processor-contract.ts` — event/state schema

---

*Document path: `/Users/jonastemplestein/.superset/worktrees/iterate/rigorous-squash/research/agent-loops/opencode.md`*
