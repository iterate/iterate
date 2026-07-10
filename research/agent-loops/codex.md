# OpenAI Codex CLI — Agent Runtime Deep Dive

Research date: 2026-07-09  
Source: `~/src/github.com/openai/codex` (`--depth=1` of `origin/main`)  
Audience: iterate team designing an event-sourced agent runtime on Cloudflare DOs.

---

## TL;DR (headline findings)

1. **One turn at a time** — `Session` enforces a single active turn via `Mutex<Option<ActiveTurn>>`; there is no parallel-LLM-request support inside one session.
2. **Op/EventMsg is the complete protocol** — the SQ/EQ split (Op = user→agent, EventMsg = agent→user) gives ~20 Ops and ~60 EventMsg variants as the full contract.
3. **Compaction is a separate unary HTTP call** — `/responses/compact`, never WebSocket, never reusing `previous_response_id`. The chain is always broken after compaction.
4. **WebSocket continuation is fragile** — reuse requires model + instructions + tools + reasoning effort + service tier to all be identical across turns; any mismatch drops to a fresh connection.
5. **Exec has hard limits** — 10 s default timeout, 1 MB output cap, `exit 124` on timeout; background-process polling is architecturally expensive (one full API turn per poll).
6. **Multi-agent is explicit-only** — subagents are never spawned automatically; max 6 concurrent threads, max depth 1 by default.
7. **Rollout JSONL grows forever** — 3 GB files have been observed; compaction shrinks model context but not the persisted log; there is no automatic rotation.
8. **Cloud best-of-N is 1–4 independent agents** — selected at task submission; results compared side-by-side in TUI; no automated scoring.
9. **AGENTS.md is the primary instruction layer** — loaded once at session start, layered global→repo-root→cwd; 32 KiB default cap per combined chain.
10. **The continuation-vs-compaction problem exists identically** — Codex's own code notes this (`client.rs` line 16); compaction always resets `previous_response_id` (confirmed: compact call goes to `/responses/compact` unary, not through the WebSocket session).

---

## Crate map (`codex-rs/`)

| Crate | Role |
|---|---|
| `protocol` | `Op` enum (SQ), `EventMsg` enum (EQ), all protocol types |
| `core` | `Session`, turn loop, exec, compaction, streaming, client |
| `rollout` / `rollout-trace` | JSONL persistence, resume, raw trace events |
| `cloud-tasks` / `cloud-tasks-client` | Cloud task TUI, best-of-N, apply/diff |
| `exec` / `exec-server` | Shell execution server, timeout, output caps |
| `code-mode` / `code-mode-host` | Codemode cell runtime |
| `app-server` | Daemon for Desktop/IDE; `thread/resume`, `thread/turns/list` |
| `thread-store` | Local rollout storage and lookup |
| `agent-graph-store` | Multi-agent DAG state |
| `mcp-server` | Codex as MCP server (`codex mcp` command) |
| `skills` | Skill discovery and loading |

---

## 1. Tool Calls

**Shell tool (`exec_command` / `shell_command`).**  
Every exec call goes through `codex-rs/core/src/exec.rs`. The model emits a tool call; the core runner spawns a subprocess via the exec server. Key constants (exec.rs):

```
DEFAULT_EXEC_COMMAND_TIMEOUT_MS = 10_000   // line 58
EXEC_OUTPUT_MAX_BYTES            = 1 MB     // DEFAULT_OUTPUT_BYTES_CAP
MAX_EXEC_OUTPUT_DELTAS_PER_CALL  = 10_000  // line 80
EXEC_TIMEOUT_EXIT_CODE           = 124      // line 65
IO_DRAIN_TIMEOUT_MS              = 2_000   // pipe drain after kill, line 89
```

`ExecExpiration` variants (exec.rs): `Timeout(Duration)`, `DefaultTimeout`, `Cancellation(CancellationToken)`, `TimeoutOrCancellation { timeout, cancellation }`.

**`apply_patch` tool.**  
Dedicated crate `apply-patch`. Goes through the same approval policy path as exec.

**Plan tool.**  
`EventMsg::PlanUpdate` and `EventMsg::PlanDelta` (protocol.rs ~line 1400s). Streaming plan updates arrive as deltas.

**Approval policies (protocol.rs `AskForApproval`):**  
`UnlessTrusted` (default), `OnRequest`, `Granular`, `Never` (yolo mode).  
Guardian: automatic safety reviewer that can veto a tool call before it reaches approval.

**Parallel tool calls.**  
The model can emit multiple tool calls in a single response item. `responses_request_properties_match` (client.rs line 306) checks `parallel_tool_calls` flag when deciding WebSocket reuse.

---

## 2. Truncation / Output Caps

**Exec output** is capped at `EXEC_OUTPUT_MAX_BYTES` (1 MB) and at most `MAX_EXEC_OUTPUT_DELTAS_PER_CALL` (10 000) `ExecCommandOutputDelta` events. On breach, remaining output is dropped; the tool result message indicates truncation.

**Context window / token budget** is tracked in `codex-rs/core/src/session/token_budget.rs`:

- `maybe_record()` — fires after each inference response.
- When `tokens_until_compaction <= reminder_threshold_tokens`, a `TokenBudgetReminder` is injected into the conversation as a system message before the next turn.
- When token budget is exhausted, auto-compaction fires (see §5).

**EventMsg::TokenCount** (protocol.rs ~line 1370) is emitted each turn with total context window usage.

**AGENTS.md** is truncated at `project_doc_max_bytes` (32 KiB default, configurable). Files closer to cwd appear later (higher precedence) and are loaded last; the chain is cut once the combined byte limit is reached.

---

## 3. Steering (Queued User Input / Mid-Turn Interrupts)

**Op enum** (protocol.rs line 527) — complete user-to-agent command vocabulary:

```rust
pub enum Op {
    Interrupt,
    CleanBackgroundTerminals,
    RealtimeConversationStart(ConversationStartParams),
    UserInput { items, final_output_json_schema, responsesapi_client_metadata,
                additional_context, thread_settings },
    ThreadSettings { thread_settings },
    InterAgentCommunication { communication },
    ExecApproval { id, turn_id, decision },
    PatchApproval { id, decision },
    ResolveElicitation { server_name, request_id, decision, content, meta },
    UserInputAnswer { id, response },
    RequestPermissionsResponse { id, response },
    DynamicToolResponse { id, response },
    RefreshMcpServers { config },
    ReloadUserConfig,
    Compact,
    SetThreadMemoryMode { mode },
    ThreadRollback { num_turns },
    Review { review_request },
    ApproveGuardianDeniedAction { event },
    Shutdown,
    RunUserShellCommand { command },
}
```

**Interrupt handling** (core/src/session/session.rs ~line 3960):  
`interrupt_task()` calls `abort_all_tasks(TurnAbortReason::Interrupted)` and cancels in-flight MCP startup if no active turn exists.

**Steered user input** (handlers.rs line 63–65, 411, 420):  
Mid-turn new user input calls `sess.interrupt_task()` first, then enqueues the new input. This is the same code path as a bare interrupt.

**Turn abort reasons** (rollout-trace/src/protocol_event.rs):  
`TurnAbortReason`: `Interrupted`, `Replaced`, `ReviewEnded`, `BudgetLimited` — all map to `ExecutionStatus::Cancelled`.

---

## 4. Subagents / Multi-Agent

**Protocol events** (protocol.rs ~line 1370–1430):  
`CollabAgentSpawnBegin/End`, `CollabAgentInteractionBegin/End`, `SubAgentActivity`, `InterAgentCommunication`.

Two protocol versions exist: multi-agent v1 (older, some lifecycle bugs) and v2 (`AgentResultObserved` in trace, child→parent delivery via `EdgeId`).

**Configuration defaults** (from OpenAI docs):

```
agents.max_threads            = 6      // concurrent open threads
agents.max_depth              = 1      // root=0, direct child can spawn, no deeper nesting
agents.job_max_runtime_seconds = 1800  // for spawn_agents_on_csv workers
```

**`spawn_agents_on_csv`** (experimental): reads a CSV, spawns one worker subagent per row, waits for all to finish, exports a combined results CSV with `job_id`, `item_id`, `status`, `last_error`, `result_json`. Each worker must call `report_agent_job_result` exactly once.

**Custom agents**: TOML files in `~/.codex/agents/` (global) or `.codex/agents/` (project). Must define `name`, `description`, `developer_instructions`. Optional: `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`. Built-ins: `default`, `worker`, `explorer`.

**Child agent sandboxing**: inherits parent's live sandbox policy and any `/permissions` or `--yolo` overrides from the parent session.

**Known issues:**  
- `multi_agent_v1.close_agent` can hang for hours on an unresponsive subagent (issue #24389).
- Orphaned subagents with no lifecycle controls (issue #19197).

---

## 5. Compaction

### Auto-compact trigger

`codex-rs/core/src/compact.rs`:  
When the token budget reminder fires (token_budget.rs), `run_inline_auto_compact_task` is called automatically. Manual compact is `run_compact_task` (from `Op::Compact` or `/compact` slash command).

### Summarization flow

1. Calls model with `SUMMARIZATION_PROMPT` (system prompt) against the current history.
2. `collect_user_messages()` — filters summaries and retained user messages up to `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` (compact.rs line 53).
3. `build_compacted_history()` — retained user messages + summary appended as the last item.
4. `sess.replace_compacted_history()` — atomically swaps live history.
5. `EventMsg::ContextCompacted` emitted.
6. `EventMsg::Warning` emitted: accuracy may be degraded after compaction.

### `previous_response_id` reset (iterate design-improvements.md item 6)

Compaction makes a **fresh unary HTTP call** to `RESPONSES_COMPACT_ENDPOINT = "/responses/compact"` (client.rs line 159). This call:
- Is **not** routed through the WebSocket session (`compact_conversation_history()` at client.rs line 537 bypasses `WebsocketSession`).
- Returns a new response, but **no `response_id`** from this call is stored as the continuation `previous_response_id`.
- `sess.replace_compacted_history()` causes the next regular turn to start with the full compacted history as `input[]`, with `previous_response_id = None`.

This means Codex's compaction **does** reset the continuation chain — exactly the behavior iterate needs. The server-side KV chain is broken by compaction. The compacted history is sent in full on the next request.

`InitialContextInjection` enum (compact.rs): `BeforeLastUserMessage` (mid-turn auto-compact) or `DoNotInject` (pre-turn or manual).

**Hooks**: `run_pre_compact_hooks` (can abort compaction) and `run_post_compact_hooks`.

### Token-budget compaction (alternative path)

`compact_token_budget.rs`: no model call — `sess.start_new_context_window(world_state)` replaces context without summarization. Useful when the model should not spend tokens on summarizing.

### Trace events

`CompactionRequestStarted/Completed/Failed` (rollout-trace/compaction.rs — one per retry attempt) + `CompactionInstalled` (checkpoint with `input_history` and `replacement_history`). Compaction can retry the upstream call before installing; `CompactionTraceContext` holds the stable `compaction_id` across retries.

---

## 6. Interruptions

**`Op::Interrupt`** → `session.rs interrupt_task()` ~line 3960:
- Calls `abort_all_tasks(TurnAbortReason::Interrupted)`.
- Cancels pending MCP server startup if no active turn.
- Does **not** abort an in-flight HTTP/WebSocket call to the model at the network layer — the model call continues until its response stream closes or times out. (iterate design-improvements.md item 9.)

**`RawTraceEventPayload::InferenceCancelled`** (raw_event.rs line 120): records why the stream was abandoned before `response.completed`. The partial response payload (completed output items before cancellation) is preserved.

**Known gap (issue #29439):** Codex continues executing tool calls after SIGINT cancellation — i.e., the model's already-emitted tool calls in the queue are still run even after the user interrupts.

**MCP interrupt gap (issue #26956):** Codex never tells MCP servers to stop after a tool call interrupt/timeout.

---

## 7. Timeouts

**Exec timeouts** (exec.rs):

| Constant | Value |
|---|---|
| `DEFAULT_EXEC_COMMAND_TIMEOUT_MS` | 10 000 ms |
| `IO_DRAIN_TIMEOUT_MS` | 2 000 ms (pipe drain after kill) |
| `EXEC_TIMEOUT_EXIT_CODE` | 124 |
| `EXEC_OUTPUT_MAX_BYTES` | 1 048 576 (1 MB) |

`ExecExpiration::TimeoutOrCancellation { timeout, cancellation }` is the typical exec handle — whichever fires first terminates the process.

**Model-call deadlines.** No hard per-turn model-call timeout was found in the open source code. Issue #24260 reports a `gpt-5.5 xhigh` turn stalling 30 minutes before first output. The system relies on the HTTP client's connection-level timeout and the provider's own server-side limits.

**WebSocket reconnect.** Issue #30933 ("stream repeatedly reconnects then falls back after websocket closes before response.completed") — WebSocket drops before `response.completed` are handled as fatal, falling back to HTTP.

**`job_max_runtime_seconds`** (for `spawn_agents_on_csv` workers): defaults to 1 800 s (30 min); each worker that exceeds this is marked as a failed row in the output CSV.

---

## 8. Background Processes / Long-Running Exec

Codex handles long-running exec via the "background terminals" model: the model starts a process, the process continues running, and the model polls it via `write_stdin ""` to check for new output.

**Polling architecture problem (issue #13733):** Each `write_stdin` poll triggers a full API turn with complete conversation history. The turn loop (core codex.rs ~line 4869):
1. `exec_command` → process spawns → partial output returned.
2. `needs_follow_up = true` → history cloned for next request.
3. Model sees process still running → issues `write_stdin` with empty input.
4. `process_manager.rs` waits `MIN_EMPTY_YIELD_TIME_MS` (5 s) → returns `"(no new output)"`.
5. `needs_follow_up = true` again — loop.

A 60-second `cargo build` generates ~12 polling turns. Each re-transmits full history. This is a fundamental tension between the Responses API continuation model (`previous_response_id` avoids resending history) and the polling requirement.

**Feature request (issue #3968):** Background terminal sessions with detach/reattach — not yet implemented. Long-running processes today require keeping the CLI open or using external tools like `tmux`.

---

## 9. Streaming

**Transport layers:**

- **WebSocket** (primary for multi-turn): `WebsocketSession` in client.rs. Connection is reused across turns when `responses_request_properties_match()` returns true (model, instructions, tools, reasoning effort, service tier, and several other fields must all match). `previous_response_id` from the last response is set on the next request.
- **HTTP SSE** (fallback): used when WebSocket reuse is impossible or connection drops.
- **Compaction endpoint**: always unary HTTP to `/responses/compact` — never WebSocket.

**Streaming delta events** (protocol.rs):

```
AgentMessageContentDelta(AgentMessageContentDeltaEvent) // text delta
ReasoningContentDelta(ReasoningContentDeltaEvent)        // reasoning delta
ReasoningRawContentDelta(ReasoningRawContentDeltaEvent)  // raw reasoning bytes
PlanDelta(...)                                            // plan tool streaming
ExecCommandOutputDelta(...)                              // shell output delta
```

**`StreamError(StreamErrorEvent)`** (protocol.rs line 1414): model stream errors are surfaced as a typed event variant rather than panicking.

**`previous_response_id` chain** (client.rs ~line 1249):

```rust
previous_response_id: Some(last_response.response_id),
```

The `response_id` is captured from each `InferenceCompleted` trace event (raw_event.rs line 105) and stored in `WebsocketSession.last_response`. On the next turn, it is sent as `previous_response_id`, letting the server skip resending the full history over the wire.

**Connection reuse guard** (client.rs lines 1177, 1232): `responses_request_properties_match()` is called before reuse; a mismatch forces `WebsocketSession::default()` (no continuation). The `input` field itself and `client_metadata` are intentionally excluded from the match — only session-level settings matter.

**Realtime/WebRTC** (crate `realtime-webrtc`): separate path for `Op::RealtimeConversationStart`, used for voice/real-time mode, not standard turn-based use.

---

## 10. Rollout / Session Persistence

**JSONL file**: written to `~/.codex/sessions/rollout-<timestamp>-<uuid>.jsonl` by `RolloutRecorder` (rollout/recorder.rs).

**Resume**: `RolloutReconstruction` (session/rollout_reconstruction.rs) replays the JSONL to rebuild `previous_turn_settings`, `reference_context_item`, `world_state_baseline`. Handles `ThreadRollback` by skipping segments. `TurnReferenceContextItem` tracks `NeverSet / Cleared / Latest` — cleared by later compaction.

**Scalability cliff (issue #25215):** `load_rollout_items()` does `read_to_string()` on the entire file. A 3 GB JSONL from a multi-day `/goal` run made the Desktop app-server crash on resume. The turn-list path also re-replays the entire rollout on every request. Compaction keeps the model-visible context small, but the JSONL keeps growing. No rotation or pruning is implemented.

**App-server protocol** (`ThreadResumeParams`, `ThreadStartParams`, `TurnStartParams`, `TurnInterruptParams`, etc.) — these are the JSON-RPC messages the Desktop/IDE extension sends to the Codex daemon.

---

## 11. Cloud Codex (chatgpt.com tasks)

### How cloud tasks run

Source: `developers.openai.com/codex/cloud/environments` and `codex-rs/cloud-tasks/`.

1. Container created from `codex-universal` base image (Python, Node, common tools pre-installed). Repo checked out at specified branch/SHA.
2. **Setup script** runs with full internet access in a separate Bash session. `export` does not persist into the agent phase — use `~/.bashrc` or environment settings instead.
3. **Maintenance script** (optional): runs when a cached container is resumed. Useful for `npm install` / `pnpm install` after dependency changes.
4. Internet access locked to configured level (off by default during agent phase). All traffic via HTTP/HTTPS proxy.
5. Agent runs in a terminal-command loop, reads `AGENTS.md` for lint/test commands.
6. Container state cached for up to 12 hours. Cache invalidated on setup script / env var / secrets changes.

**Secrets** are available only during setup, removed before agent starts.

### Best-of-N

CLI: `codex cloud exec --env ENV_ID --attempts N "prompt"` (N = 1–4, cloud-tasks/cli.rs lines 39–60). N independent agents run the same task in parallel. Results shown side-by-side in TUI (Tab/Shift-Tab to cycle). User picks which diff to apply. No automated scoring — human selects best attempt.

`TaskSummary.attempt_total` tracks how many attempts were requested; `TurnAttempt.attempt_placement` identifies each attempt (cloud-tasks-client/api.rs).

### CLI↔Cloud handoff / resume

`codex cloud status <TASK_ID>`, `codex cloud apply <TASK_ID>` — apply the cloud diff locally. `/resume` in the TUI resumes a saved rollout thread. Cloud tasks back-end lives at `https://chatgpt.com/backend-api` (or override via `CODEX_CLOUD_TASKS_BASE_URL`). Auth via ChatGPT login (`codex login`).

There is no seamless "hand off to cloud mid-session and resume locally" flow; the transfer boundary is the diff (cloud produces a patch, you apply it locally).

### AGENTS.md in cloud

Same layered loading as CLI: global (`~/.codex/AGENTS.md` or `AGENTS.override.md`), repo root, nested dirs. Agent reads it once at session start. Used to find project-specific lint and test commands.

### `codex mcp` — Codex as an MCP server

`codex mcp` exposes two tools: `codex()` (start a task) and `codex-reply()` (continue a task). This is how the OpenAI Agents SDK orchestrates Codex CLI workers in multi-agent pipelines (Agents SDK cookbook).

---

## 12. Notable GitHub Issues

| # | Topic | Key insight |
|---|---|---|
| 25215 | Rollout JSONL size | 3 GB file; `read_to_string` on resume crashes app-server; no rotation |
| 29439 | Post-cancel tool calls | Tool calls continue executing after SIGINT |
| 26956 | MCP interrupt | MCP servers not notified on tool timeout/interrupt |
| 30933 | WebSocket reconnect loop | Drop before `response.completed` → fatal → HTTP fallback |
| 13733 | Background process polling | Each `write_stdin` poll = one full API turn with full history |
| 24389 | Subagent hang | `close_agent` can hang hours on unresponsive child |
| 29540 | Multi-agent fan-out | TUI summarization for multi-agent v2 |
| 3968 | Background terminals | Feature request: detach/reattach long-running processes (not implemented) |
| 31607 | Compact + model error loop | Model error during compaction triggers re-compact → loop |
| 25394 | `/resume` context loss | `codex resume` compression drops recent context |
| 28227 | Goal auto-continuation | Does not resume after transient network disconnect |
| 22858 | Stop hook on interrupt | Stop hook not fired on Esc interrupt |
| 19197 | Orphaned subagents | No lifecycle controls for persistent orphaned subagents |

---

## 13. Implications for iterate's Agent Processor

Cross-referenced with `apps/os/src/domains/agents/design-improvements.md`.

### Item 4 — Compaction via `agent/history-compacted { floorOffset, summary }`

Codex emits `EventMsg::ContextCompacted` after installing the new history. The rollout records a `CompactionInstalled` event with `input_history` and `replacement_history`. iterate's equivalent should record both pre- and post-compaction history as immutable events on the stream — exactly the approach in the design-improvements doc.

Codex's `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` cap on retained user messages is a concrete reference budget. The 20k token floor is kept verbatim (not summarized) so the summary has grounding.

### Item 5 — Single `currentRequest` slot

Codex also has exactly one active turn per session (`Mutex<Option<ActiveTurn>>`). All subagent parallelism happens at the session level, not within one session. iterate's design is consistent with this. Parallel-request lanes (item 5) would require multiple session instances, which Codex achieves by spawning subagent sessions.

### Item 6 — `previous_response_id` vs compaction (KEY)

Codex resolves this by routing compaction through a completely separate HTTP call (`/responses/compact`) that never touches the WebSocket session. After compaction, `WebsocketSession.last_response` is cleared (or never set for the compaction call), so the next turn starts fresh. The session checks `responses_request_properties_match()` before attempting to reuse the WebSocket; a mismatch forces a new connection.

**iterate's implication**: a compaction event landing in the stream must set `previousResponseId = null` in the processor state before the next LLM request is issued. The compaction request itself should never chain off the existing `previousResponseId`. This is already identified in the design-improvements doc — Codex confirms it is the correct fix.

### Item 9 — Cancellation never aborts provider execution

Codex has the same gap (issue #29439). `interrupt_task()` sets the abort token, but the in-flight WebSocket stream continues draining until the provider closes it or the HTTP client times out. iterate should consider the same approach: mark the request as cancelled in state, drain the response but discard output, then proceed to the next trigger.

### Item 11 — Full stream re-read per request

Codex addresses this with the rollout + WebSocket continuation model: `previous_response_id` tells the server to include history server-side, so the client only sends new input items. Without `previous_response_id`, Codex must send the full history as `input[]` — same O(n) cost iterate currently pays. This validates the design-improvements.md suggestion to maintain a running compacted history rather than re-folding the full stream each time.

### Background process polling

Codex's polling-per-API-turn design (issue #13733) is a cautionary tale. If iterate ever needs to surface long-running script output, it should use an out-of-band progress channel (workspace file, streaming R2 spill) rather than re-submitting the full history each poll — which is exactly what the `#1793` spill PR already does for script results.

### Cloud containers vs DO isolation

Codex cloud runs in ephemeral containers (12 h cache). iterate runs agent logic in Cloudflare DOs with workspace R2. The two models are structurally analogous (isolated environment per agent instance, setup via a startup mechanism, agent phase with restricted network). The key difference: Codex containers have a full Linux filesystem; iterate agents use the @cloudflare/shell + R2 workspace.

### Subagent depth limits

Codex defaults to `max_depth = 1` with a comment that deeper nesting "can turn broad delegation instructions into repeated fan-out." iterate's current single-path agent tree is conservative but correct. Any multi-agent extension should gate depth explicitly.
