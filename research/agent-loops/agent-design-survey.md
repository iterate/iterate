# Coding-Agent / Agent-Loop Design Survey

**Audience:** iterate team building an event-sourced agent runtime on Cloudflare Durable Objects.
**Scope:** cross-cutting design patterns and notable open-source agents NOT covered by the six
sibling deep-dives (pi-mono, OpenCode v2, Claude Code, OpenAI Codex, Cloudflare Agents SDK, Vercel eve).
**Date:** 2026-07-09

---

## PART 1 — Design Space

### 1. Tool-Call Interfaces: Schema-Based vs. Code Execution (Codemode)

The fundamental fork in tool-call design is whether the model communicates intent through a
**structured schema** (JSON-described tools, JSON-returned calls) or through **executable code**
that the runtime evaluates.

**Schema-based tools** (the mainstream) represent each capability as a typed descriptor with
`name`, `description`, `parameters` (JSON Schema). The model emits a structured JSON object; the
runtime dispatches to the matching handler. This pattern is universal across OpenAI function
calling, Anthropic tool-use, Google Gemini, and the Model Context Protocol. It is easy to audit,
easy to approve-gate, and maps cleanly to typed languages. The downside is combinatorial
explosion: every new capability needs a new schema, and multi-step retrieval requires the model
to make multiple sequential round-trips.

**Code execution** (codemode) gives the model a single "run this code" primitive. The model
synthesizes logic, branches, and tool calls inline; the runtime evaluates the code and feeds
results back. Anthropic calls this "Code Mode" and ships `@cloudflare/codemode`
(https://developers.cloudflare.com/agents/tools/codemode/) with `createCodeTool` +
`DynamicWorkerExecutor`. The durable runtime runs in DO SQLite; approvals are implemented as
abort-and-replay. Cloudflare claims 80% token reduction versus an equivalent multi-tool schema
approach because the model produces a complete program rather than a chain of JSON round-trips.

Hugging Face's **smolagents** (https://github.com/huggingface/smolagents) makes the dichotomy
explicit at the class level: `CodeAgent` (default — Python, using `exec`) vs.
`ToolCallingAgent` (JSON). Their benchmark comparison shows CodeAgent outperforming
ToolCallingAgent on multi-step tasks while using fewer turns, reinforcing that code generation
subsumes tool composition. smolagents supports multiple executor backends (local, E2B, Modal,
Docker, Blaxel) and an import allowlist for sandboxing.

**Iterate's codemode** follows the same principle: the model's only "tool" is emitting one
`async function` in a fenced code block; `extractAsyncJsSnippet` parses it; the runtime
evaluates it and feeds the result back. This eliminates the tool-schema maintenance surface
entirely. The tradeoff is that the model must know the in-scope API surface (itx RPC stubs) via
the system prompt and progressive discovery (`codemode.search()`, `codemode.describe()` in
Cloudflare's version; iterate's equivalent is the full `itx` surface documented in
`DEFAULT_AGENT_SYSTEM_PROMPT`).

**Key tension:** code execution requires a capable code-producing model. Schema tools degrade
more gracefully with weaker models, which matters for cost tiering.

---

### 2. Context Truncation and Management

Every agent loop collides with the provider's finite context window. Strategies form a spectrum
from passive windowing to active semantic compression.

**Sliding window (drop oldest):** the simplest strategy — keep the last N messages. Zero extra
inference cost; zero semantic loss awareness. Implemented in most basic frameworks as the fallback.

**Prefix summarization / recursive compaction:**
- **Letta/MemGPT** (https://docs.letta.com/guides/core-concepts/messages/compaction/) is the most
  sophisticated open implementation. Strategies: `sliding_window` (default, summarizes the oldest
  30%); `all` (summarizes the whole history); `self_compact_sliding_window` and `self_compact_all`
  (the agent itself writes the summary, exploiting its own understanding of what mattered).
  Implementation details: `clip_chars` 50K on summaries to bound summary size; recursive
  summarization if the summary still exceeds limit; increment eviction in 10% steps when needed;
  messages pending human approval are never evicted.
- **LangGraph/LangMem** (https://langchain-ai.github.io/langmem/guides/summarization/) uses a
  `SummarizationNode` that maintains a `running_summary` string; `max_tokens_before_summary`
  triggers it; the summarize step runs as a separate graph node so the main graph's checkpointed
  state is unaffected.
- **Anthropic API** (via the `compact_20260112` beta): configurable threshold (minimum 50K
  tokens, default 150K), custom instructions for what to preserve, `pause_after_compaction`
  flag, streaming compaction events so the client can observe the boundary. This is provider-side
  compaction — the provider summarizes and the client's `previous_response_id` chain is reset.
- **OpenAI Responses API** (https://platform.openai.com/docs/guides/compaction): `/responses/compact`
  standalone endpoint; inline `context_management.compact_threshold`; produces an opaque
  compaction item in the chain; server-side compaction fires mid-stream. ZDR-compatible with
  `store=false`.
- **Amp (Sourcegraph):** intentionally has NO automatic compaction. The philosophy is "curated
  context beats comprehensive context" — the agent selects specific files rather than loading
  everything, so context rarely fills to the ceiling. When it does, the user manually starts a
  new thread. The Amp team expressed concern that post-compaction the "agent got dumber."

**Practitioner evidence:** multiple production teams report triggering compaction at 70-75%
utilization (not 95-98%) avoids mid-task truncation artifacts. A structured summary prompt —
listing open tasks, recent decisions, current file contents — outperforms a generic "summarize
the conversation" prompt.

**Implications for iterate:** items 2, 3, and 4 in `design-improvements.md` form a sequenced
plan: normalize typed usage → add contextWindow mapping → implement `history-compacted` event.
The Letta `self_compact` approach is relevant because iterate's models (Kimi K2) are already
producing code; having the agent itself write the compaction summary may be the highest-fidelity
option.

---

### 3. Mid-Run Steering and Human-in-the-Loop Injection

How can a user correct, redirect, or add context while an agent is actively running?

**Queue-and-drain:** the client enqueues new messages in a buffer; the buffer is drained and
injected as user messages before the next model turn. Gemini CLI implements this (PR #19307):
`hintBuffer` / `hintMode` UI state; `consumePendingHints()`; `buildUserSteeringHintPrompt()`
wraps queued hints into a single injection; the system prompt mandates the model to acknowledge
them. The key insight is that the injection must arrive at the "right" turn boundary — not
spliced into the middle of a streaming response.

**Direct inject / interrupt:** force the model's current response to abort, synthesize a user
turn with the steering message, and continue. This is more responsive but requires the provider
to support mid-stream abort cleanly. The Anthropic API's `pause_after_compaction` callback and
the `onSuspended` callback in Mastra's durable agents follow this shape. Cline exposes a
`permissionHandler` callback in the Agent Communication Protocol (ACP) for programmatic control.

**Approval gates (suspend-and-resume):** the agent surface a proposed action (tool call, file
write, shell command) and suspends until the user approves or rejects. If rejected, the agent
receives a synthetic error and continues. Mastra's `createDurableAgent`
(https://mastra.ai/docs/agents/durable-agents) implements this as `onSuspended` callback +
`resume(runId, data)` after approval. Cloudflare's codemode approval mechanism is abort-and-replay:
the runtime throws an `ApprovalRequired` error, the agent aborts, and when the human approves,
the run is replayed with the approval in context.

**Aider:** as of mid-2026, mid-run steering is NOT implemented despite open feature requests
(#4872, #4006). Aider is session-based and turn-blocking; users must wait for the current turn
to complete.

**Key insight:** queue-and-drain at turn boundaries is low-risk and works with any provider.
Direct abort requires provider cooperation. The choice between them determines how responsive
the UX feels to corrections — critical for long-running agentic tasks.

**Iterate's current model:** inputs queue via `pendingTriggerOffset`; the `LlmRequestPolicy`
(`dont-trigger-request | interrupt-current-request | after-current-request`) governs which path
is taken. `interrupt-current-request` exists in the schema but cancellation never actually aborts
the provider execution (design-improvements.md item 9). The Gemini CLI queue-and-drain approach
could be layered on top of the existing queuing machinery without any provider changes.

---

### 4. Multi-Agent / Subagent Architectures

When a task is too large for one context window, systems spawn specialized subagents. The
canonical motivation is context isolation.

**Anthropic's multi-agent research system**
(https://www.anthropic.com/engineering/multi-agent-research-system, June 2025): orchestrator
(Claude Opus) spawns 3-5 parallel Claude Sonnet subagents; a separate CitationAgent does a final
pass. Subagents don't communicate with each other — only through the orchestrator. The key
finding: 90.2% improvement over single-agent baseline, at ~15x token cost. The lead agent
writes a plan to external memory before its own context fills. This "context isolation is THE
motivation" framing now appears across the industry.

**Factory Droid Missions** (https://factory.ai/news/missions-architecture): the most
architecturally rigorous public design. Orchestrator/Worker/Validator role separation. Workers
each get a fresh context with a narrow spec. Validators are fresh agents that see only the
output (no prior reasoning context — explicitly chosen because an agent that implemented
something is biased toward confirming its own work). Test-driven development at two scales:
per-worker unit tests + orchestrator-defined validation contract written BEFORE features are
specified. External state in shared artifacts (validation contract, feature list, knowledge base)
so no agent needs the full picture. Median worker runs: 51 assistant turns for implementation,
30 for validation.

**Kilo Code** (https://kilo.ai, rebuilt April 2026 on OpenCode server): parallel subagents in
an Agent Manager with per-agent git worktrees so parallel agents don't conflict on file writes.
Two-level hierarchy: parent delegates to subagents but subagents cannot spawn subagents
(as of v7.2.10 — flat by design because recursive spawning adds overhead without commensurate
capability gain per their testing).

**smolagents:** `managed_agents` parameter — the manager passes tasks as tool calls; subagents
return a final answer; parallel execution via `max_tool_threads` (thread-pool on the manager).

**Amp:** `Task` tool spawns subagents; main agent receives only the final summary, not the
subagent's internal trajectory.

**Practical tradeoffs:**
- Inter-subagent communication is almost universally omitted — agents are isolated; the
  orchestrator is the only coordinator. This simplifies correctness reasoning significantly.
- Subagent results arriving out-of-order must be handled — most systems use a final merge
  pass by the orchestrator.
- Worktree-per-agent (Kilo Code) is the only pattern that supports truly parallel file writes
  without conflict.

---

### 5. Context Compaction in Event-Sourced Systems

This section expands on §2 specifically for systems that journal events (as iterate does).

**The fundamental duality:** in an event-sourced agent, "compaction" has two distinct meanings
that must not be conflated:
1. **Prompt compaction** — reducing the number of tokens sent to the provider per turn.
2. **Event-log compaction** — reducing the number of events on the append-only stream.

Most frameworks address only (1). Iterate's design-improvements.md item 4 targets (1) via a
`history-compacted` event that short-circuits prompt rebuild for events before `floorOffset`.
The event log itself remains full-fidelity — this is correct because replaying the log should
remain deterministic.

**LangGraph's checkpointing model**
(https://langchain-ai.github.io/langgraph/concepts/persistence/): state is checkpointed at
every node boundary via pluggable savers (`PostgresSaver`, `SqliteSaver`, `RedisSaver`). The
checkpoint IS the compacted state — there is no separate log. Long-term memory lives in a
separate `Store` abstraction keyed by `(namespace, key)`. This means LangGraph's "compaction"
is always snapshot-based, not event-sourced; it cannot replay deterministically to an
intermediate state.

**Temporal/Restate/Inngest approach** (journaling frameworks, not agent-specific): every LLM
output is recorded once in the journal and replayed on recovery. The journal is NOT compacted —
only trimmed after workflow completion. Large LLM payloads require a payload codec (store in
blob storage, keep handle in journal). The rule is: record once, deterministic code, idempotent
tools. This is the closest analogue to iterate's design.

**Mastra durable agents** (https://mastra.ai/docs/agents/durable-agents, June 2026): wrap the
agent loop inside a durable workflow where each step can be memoized and replayed. PubSub layer
caches events for late-subscriber replay (`observe(runId, { offset })`). Inngest-backed variant
adds step-level retry and a monitoring dashboard. This is memoized execution, not event-sourcing
— the state is a workflow snapshot, not a fold over a log.

**Key insight for iterate:** the `history-compacted` event approach is sound and unique — it
preserves full event-log fidelity while bounding prompt size. The race-free property
(requests before the event rebuild the old prompt; requests after get the compacted one) is a
genuine advantage of the event-sourced model over checkpoint-based systems.

---

### 6. Interruptions and Cancellation

User-initiated cancellation of an in-flight agent turn is harder than it looks.

**What cancellation must accomplish:**
1. Stop the provider execution (abort the HTTP/WS call, stop paying for tokens).
2. Surface a clean error to the agent loop so it can decide next action.
3. Not leave the agent state machine in an inconsistent half-state.

**The "silent abandon" anti-pattern:** many systems update their internal state ("request is
cancelled") but do not abort the provider. The provider runs to completion, consuming tokens and
blocking the socket. iterate's `llm-request-cancelled` event falls into this category (design-
improvements.md item 9). Goose's context revision removes old content from history but does not
abort in-flight provider calls.

**AbortController propagation:** the correct fix, universally. The `AbortController` is created
at the start of the provider call; the cancellation signal is propagated into the fetch/WebSocket
call. Mastra's `DurableAgent.abort()` flips an internal AbortController that surfaces as an
`AbortError` inside the LLM execution step. Google's ADK (`adk.dev/runtime/cancel/`) uses
`AbortSignal.timeout()` for deadline-based cancellation.

**Partial-result handling:** when the model is mid-response, what happens to the tokens already
received? Two schools:
- Discard entirely (clean state, may lose useful partial output).
- Commit partial output as a truncated message (preserves information, requires the reducer to
  handle `is_truncated` flag).

**Background-process timeout leakage:** Claude Code has a documented bug (#15153) where a
background bash process that exceeds its timeout does NOT surface a `tool_result` error to the
agent — the session continues without knowing the process failed. This is the cancellation
propagation problem in the tool layer. The fix pattern (from Coder's agent work, PR #23132): use
explicit `run_in_background=true` with rich schema descriptions so the model knows when to use
it; detect trailing `&` and auto-promote; send `SIGKILL` to the entire process group (negative
PID), not just the shell.

**Iterate:** cancellation path exists in the event schema but the abort is not propagated into
the provider. For openai-ws, the live WebSocket call must be explicitly aborted; for
cloudflare-ai, the streaming HTTP request must be aborted via `AbortController`. The
`#executionChain` in openai-ws serializes all executions, so an un-aborted cancelled request
blocks the next one (item 7 in design-improvements.md).

---

### 7. Timeouts and Watchdogs

Agent loops must protect against hung tools, unresponsive providers, and infinite self-loops.

**Consecutive-failure breakers:** iterate's `MAX_CONSECUTIVE_LLM_FAILURES = 3` and
`MAX_CONSECUTIVE_SCRIPT_TURNS = 24` (from the 2026-07-07 self-loop incident) are the pattern.
Anthropic's Claude Code surfaces `consecutiveAutocompactCount` thresholds. The key is that the
breaker fires on the FOLD path, not on a timer — a fold-time check is race-free.

**Per-tool timeouts:** the GAIA agent framework (amd/gaia PR #1591) adds a `@tool(timeout=...)`
decorator with a default of 180s, a per-tool override, and a cooperative cancel event checked
at step boundaries. Short defaults force fast iteration; long-running tools explicitly opt out.
Factory Droid's Terminal-Bench report notes: "using short default timeouts led to better average
performance by cutting long, unproductive waits and failing fast."

**Process group signaling:** when a tool spawns a subprocess, the timeout signal must reach the
entire process group (`kill -pgid`, not just the shell PID) or child processes escape cleanup.
Coder's PR #23132 documents this gap in most agent implementations.

**Provider-level watchdogs:** provider HTTP calls can hang at the network level (TCP established,
server silent). The correct guard is a deadline on the HTTP client, not just the tool. `AbortSignal.timeout(ms)` in the fetch call.

**Orphan sweeps:** after a crash/eviction, requests that were "in flight" may never complete.
iterate's openai-ws processor has a post-batch orphan sweep that fails `requested`-status
requests with no live execution owner (the t42 wedge fix). cloudflare-ai lacks this (item 8).
The orphan-sweep pattern should be applied to every new provider and every new request lane.

---

### 8. Background Processes and Long-Running Tools

Many agentic tasks require starting a process (dev server, test runner, compiler) that must
outlive the current tool call and be inspectable across multiple future turns.

**The core problem:** most tool-call frameworks model execution as synchronous request-response.
A process that takes 30 minutes doesn't fit. Three patterns emerge:

**Fire-and-forget with handle:** the tool starts the process, returns a handle (PID or job ID),
and subsequent tool calls query the handle for stdout/status. This requires the runtime to
maintain a process registry that survives between tool calls. Claude Code's `Bash` with
`run_in_background: true` follows this pattern.

**Yield-and-resume (session continuation):** the tool starts the process and yields a
`session_id`; a future tool call with the same `session_id` resumes where it left off. OpenAI
Codex uses this pattern. Requires the runtime to persist session state across tool calls.

**Streaming tool results:** the tool emits incremental output events as the process runs; the
agent loop can query new events. iterate's script execution results fit here — results are
committed when complete, then the agent receives them as the next input.

**Process registry concerns:**
- **Cleanup:** zombie processes accumulate if not explicitly tracked and killed on session end.
  Coder's PR #23132 adds process group tracking for cleanup.
- **Reuse vs. isolation:** Factory's "Droid Computers" persist the filesystem and process
  memory across sessions ("ephemeral sandboxes were a natural starting point but stateful
  workflows need stateful environments"). This is the opposite of iterate's per-turn sandbox.
- **Spill to workspace:** iterate spills oversized script results (>30K chars) to a workspace
  file so the agent can page through them (`SCRIPT_RESULT_HISTORY_LIMIT = 30,000`). This is a
  pragmatic workaround for the lack of a streaming tool result primitive.

**iterate-specific:** the current model runs each script to completion before feeding results
back. Long-running scripts (build, test suite) block the turn. A yield-and-resume or
streaming-result primitive would let the agent issue checkpoints mid-script, observe partial
output, and decide to cancel early.

---

### 9. Streaming — Chunks, Resumability, and Write Amplification

Streaming provider responses to the client raises multiple design questions.

**Normalized delta events:** every provider emits its own streaming format. OpenAI's Responses
API emits `response.output_text.delta` with `type` fields; Anthropic emits `content_block_delta`
with `type: "text_delta" | "thinking_delta"`; Cloudflare AI emits `text` fragments. Translating
provider-specific frames into a normalized `output-delta { channel: "text" | "thinking", delta }`
event at the emitter boundary keeps the consumer (browser UI, downstream subscribers) decoupled.
This is item 1 in design-improvements.md and mirrors how Mastra's `DurableAgent` uses PubSub
with an `observe(runId, { offset })` API to replay cached events for reconnecting clients.

**Resumability:** Mastra's durable agent PubSub caches published events so a client that
disconnects mid-stream can reconnect and replay missed events from a known offset
(https://mastra.ai/reference/agents/durable-agent). This is essentially what iterate's stream
already provides — a client can read from any offset — but Mastra's `observe()` + cleanup()
lifecycle makes it a first-class client API.

**Write amplification:** every streaming chunk committing as a durable event is expensive. At
200+ frames per response, each with an awaited `stream.append`, the socket reader is
back-pressured by storage writes. Known mitigations:
- Coalesce: buffer frames for N milliseconds or M bytes before committing.
- Split lanes: commit the normalized `output-delta` at the coalesced rate; keep the raw-frame
  journal as best-effort (can lag or drop under pressure without affecting correctness).
- Deferred journal: write raw frames to an ephemeral buffer; commit to the durable log only at
  turn completion (loses streaming fidelity for crash recovery but eliminates write amplification).
This is item 10 in design-improvements.md.

**Client-side folding cost:** every turn in iterate re-reads and re-folds the entire stream
(item 11). LangGraph avoids this by keeping reduced state checkpointed at each node; Temporal
avoids it by memoizing each step's output. For iterate, the event-sourced model makes
re-folding natural but it grows O(history). The `history-compacted` event bounds the prompt-
relevant fold; a separate "processor state checkpoint" (reducing the fold to events SINCE the
last checkpoint) would bound the total fold work independently.

---

### 10. Durability and Event-Sourcing

**The event-sourced agent model** (iterate's approach) appends every observable fact — inputs,
outputs, LLM requests, script executions, results — to an immutable log. The agent state is
always a pure `reduce()` fold over that log. Side effects are idempotency-keyed against events
on the log. Crash recovery is replay from offset 0 (or from a checkpoint offset if compacted).

**Comparison with major alternatives:**

| Pattern | Representative | Recovery | Parallelism | Compaction |
|---------|---------------|----------|-------------|-----------|
| Event-sourced | iterate | Replay from 0 | Serialized by fold | `history-compacted` event |
| Workflow journaling | Temporal, Restate, Inngest | Step memoization | Step-level parallel | Log trim post-completion |
| Graph checkpointing | LangGraph | Load last checkpoint | Branch-level | Snapshot at node |
| PubSub + workflow | Mastra durable | Replay cached events | Step-parallel | In-workflow summary step |
| Mutable state | Inngest AgentKit | Workflow retry | N/A | Not needed |

**Temporal/Restate/Inngest** (https://blog.particula.tech/temporal-restate-inngest-comparison/):
journal-and-replay for durable execution. LLM outputs are recorded once; replayed deterministically
on crash. Large LLM payloads need a codec (store bytes in blob storage, keep handle in journal)
because journals have payload size limits — an analogue to iterate's spill-to-workspace pattern.
Three rules that apply equally well to iterate: record outputs once, write deterministic
reduction code, make tools idempotent.

**Inngest AgentKit** (https://agentkit.inngest.com): "Network of agents" with shared mutable
state, a Router, and `step.run()` for durable steps. State is a shared dict — NOT event-sourced,
NOT foldable. The Inngest orchestration engine handles fault tolerance; agents are stateless
between steps. Lower fidelity than iterate's model; simpler to operate.

**LangGraph:** checkpointing persists the full graph state at every node boundary. Long-term
memory in a separate `Store` abstraction. Human-in-the-loop via node-level `interrupt()`.
Cannot replay to an arbitrary intermediate state without a checkpoint there — the full event log
is not preserved.

**Key advantages of iterate's pure event-sourced model:**
- Arbitrary replay to any offset without external state.
- Race-free compaction: the `history-compacted` event is just another event; the fold handles it
  transparently; concurrent requests don't race on state updates.
- Perfect auditability: every decision is derivable from the log.

**Key disadvantages vs. workflow-journaling (Temporal/Restate):**
- O(history) fold cost per turn grows unboundedly (item 11).
- No built-in step-level retry (retries must be expressed as events).
- No first-class parallel execution lanes (item 5 — currently single `currentRequest` slot).

---

## PART 2 — Notable Open-Source Agents

### Amp (Sourcegraph)

Amp is a commercially available, closed-source coding agent from Sourcegraph built on a
worker/oracle dual-model architecture. The "worker" model executes tasks while the "oracle" model
(typically a stronger model) provides judgment at key decision points. Amp's approach to context
is deliberately curative: the agent selects specific files via semantic search rather than loading
entire codebases, so context windows rarely fill. There is intentionally no automatic compaction
— the team is concerned post-compaction quality degradation ("the agent got dumber"). Long tasks
use manual thread handoffs. The `Task` tool spawns subagents that execute in isolated context
windows; the parent receives only the final summary. Amp defines a layered tool system:
built-in tools → toolboxes (curated collections) → MCP servers → Skills (project-specific
instructions loaded from `AGENTS.md` files). The AGENTS.md format, now found in 60K+ GitHub
projects, was popularized by Amp. Permission model: per-tool allow/reject/ask/delegate decisions.
String-replacement edits (not full-file rewrites) for precise, reviewable changes.

### Aider

Aider (https://aider.chat) is one of the oldest open-source coding agents, predating most
current tools. It operates as a CLI that connects to provider APIs and implements a full
ReAct-style loop against a git-tracked working directory. Key architectural choices: changes are
committed to git as the agent works (so undo is `git reset`); the agent maintains a "chat files"
set of explicitly included files plus an `aider-ignore` exclusion list; context is assembled by
concatenating file contents rather than RAG retrieval. Aider supports many providers and models
and is heavily used for benchmarking (SWE-bench leaderboard). Mid-run steering is NOT
implemented — user must wait for the current turn to complete (open issues #4872, #4006).
Context management is limited to explicit file control — no compaction. Aider's main contribution
to the field is proving that git-native commit-per-change is an excellent audit and undo
primitive.

### Cline

Cline (https://github.com/cline/cline) is a VS Code extension implementing a ReAct loop with
explicit tool calls for file reads, edits, shell commands, and browser control. Architecture is
session-based (no persistence across VS Code restarts). Cline is notable for pioneering MCP-as-
extension: MCP servers are treated as first-class capability extensions, not an afterthought.
The Agent Communication Protocol (ACP) provides a programmatic interface with a `permissionHandler`
callback for automated approval/rejection — enabling integration tests and CI use. No mid-run
steering; no automatic compaction. With 50K+ GitHub stars and Roo Code's sunset in May 2026,
Cline absorbed a large portion of the Roo community. The extension's source is fully transparent
(Apache-2.0) — all prompts, context policies, and tool dispatching are readable.

### Goose (Block)

Goose (https://github.com/block/goose) is Block's open-source coding agent, rewritten in Rust
for its core with a Python/TypeScript tooling layer. Architecture is MCP-first: every capability
is expressed as an MCP server, including Goose's own built-in tools. The agent implements a
ReAct loop with "context revision" — a strategy that removes old or irrelevant context from the
conversation window rather than summarizing it, using a faster/smaller model for the revision
step. Goose supports both CLI and desktop GUI interfaces and implements the ACP (Agent
Communication Protocol) as both server and client for inter-agent communication. The Rust core
provides significant performance advantages for the inner loop. Context revision is a middle
ground between windowing (drops by age) and summarization (semantic loss) — it attempts to
retain relevant content regardless of age, but requires the revision model to correctly judge
relevance.

### Crush (Charm)

Crush (https://github.com/charmbracelet/crush) is a terminal-first coding agent from Charm,
the creators of the Bubble Tea TUI framework. Built in Go; uses Bubble Tea for its interactive
TUI. Notable features: LSP integration for diagnostics (error squiggles, symbol lookup) and
symbols (go-to-definition, find-references) — bringing IDE-grade context into a terminal agent
without a VS Code dependency. Multi-model support; session-based (no durability). Licensed under
FSL-1.1-MIT (source-available with a commercial restriction that expires after 2 years). Crush
was contested: the OpenCode team alleged it was derived from OpenCode without proper attribution,
which Charm disputed; the episode highlighted the fragility of attribution in rapid open-source
forks. 25K+ stars on GitHub. The LSP integration is Crush's primary differentiator — most agents
either lack LSP entirely or depend on VS Code's LSP client.

### Gemini CLI

Gemini CLI (https://github.com/google-deepmind/gemini-cli) is Google's official open-source
terminal agent. It is notable for two architectural contributions: (1) its mid-run steering
implementation (PR #19307) — a `hintBuffer` that queues messages during active agent turns and
drains them as user messages before the next response, with `buildUserSteeringHintPrompt`
injecting them into continuation prompts including sub-agent queries; (2) its tool system allows
"tools that use tools" — sub-tools compose via the same dispatch layer as top-level tools.
Gemini CLI is Apache-2.0 open-source, well-documented, and actively maintained by Google. The
context window for Gemini 2.5 Pro is very large (1M+ tokens), which reduces compaction urgency
significantly. The hint injection pattern is a clean, turn-boundary-safe mechanism that any
event-sourced agent could adopt.

### mini-swe-agent

mini-swe-agent (https://github.com/SWE-agent/mini-swe-agent) is a deliberate minimalist
implementation by the SWE-agent team, created after they found that their original SWE-agent
had grown too complex to study and extend. ~100 lines of Python. No tool-calling interface —
the model emits bash commands as raw text; the agent wraps them in `subprocess.run` calls.
Stateless: each action is a fresh subprocess invocation. Despite the simplicity, mini-swe-agent
achieves >74% on SWE-bench Verified, outperforming many far more complex systems. The original
SWE-agent is now in maintenance-only mode. The lesson: a ReAct loop over bash commands, with
good environment bootstrapping, is an extremely strong baseline. Most complexity in coding agents
provides diminishing returns relative to this baseline.

### smolagents (Hugging Face)

smolagents (https://github.com/huggingface/smolagents) is Hugging Face's lightweight agent
library with an explicit `CodeAgent` vs. `ToolCallingAgent` dichotomy. `CodeAgent` generates
Python code that is `exec`'d locally (or in a sandbox backend: E2B, Modal, Docker, Blaxel);
`ToolCallingAgent` uses standard JSON tool calls. Benchmarks show `CodeAgent` outperforms
`ToolCallingAgent` on multi-step tasks with fewer turns. Multi-agent support via `managed_agents`:
a manager calls subagents as tools; parallel execution via `max_tool_threads`; a `planning_interval`
parameter triggers periodic replanning steps. Import allowlist for sandboxing local code
execution. smolagents is the clearest implementation of the code-vs-schema dichotomy and the
most accessible codebase for studying it. MIT-licensed, 17K+ stars.

### Letta / MemGPT

Letta (https://github.com/letta-ai/letta, formerly MemGPT) is the most sophisticated open-source
implementation of memory management for agents. Inspired by OS virtual memory, Letta implements
a three-tier hierarchy: **core memory** (always in context — structured blocks with character
limits), **archival memory** (vector-search external store, infinite capacity), and **recall
memory** (conversation history with search API). Compaction is first-class (see §2 above):
four strategies, cheap-model defaults, `clip_chars` to bound summary size, recursive fallback.
The agent's system prompt is dynamically assembled from core memory blocks, allowing the agent
itself to update its own "facts about myself" and "facts about the user" blocks via tool calls.
This is the richest memory model in open-source agents. Letta is most relevant to iterate for
the compaction strategy design (self-compact, sliding window, incremental eviction) and for the
principle of separating "always-in-context" structured state from "searchable-on-demand"
archival state — analogous to splitting agent state into a typed schema vs. a searchable
workspace.

### Roo Code (archived) / Kilo Code

Roo Code was a popular Apache-2.0 VS Code extension (3 million installs) that shut down May 15,
2026 after the team pivoted to Roomote (cloud agent). Kilo Code
(https://github.com/Kilo-Org/kilocode) forked from Roo in 2025 and rebuilt the VS Code
extension on the OpenCode server (MIT-licensed, shared engine across VS Code, CLI, and Cloud
Agents) in April 2026. Key additions in the rebuilt Kilo: parallel tool calls, parallel
subagents in isolated git worktrees via an Agent Manager, cross-device session continuity
(start in CLI, resume in VS Code), inline autocomplete, and multi-model comparison (run the
same prompt across models side-by-side). The `Orchestrator` (Boomerang) pattern from Roo is
replaced by native subagent delegation from any full-tool agent — flat two-level hierarchy,
subagents cannot spawn subagents. The git-worktree-per-agent isolation pattern is a clean
solution to parallel file conflicts. Sessions share state between CLI and VS Code through the
OpenCode server, which is the most seamless cross-surface continuity of any open system.

### Factory Droid / Missions

Factory Droid (https://factory.ai) is a commercial coding agent focused on multi-day autonomous
software projects. The Missions architecture (https://factory.ai/news/missions-architecture) is
the most fully articulated multi-agent orchestration design in the industry. Core principles:
(1) agent trajectory is append-only, so every past thought biases future reasoning —
irrelevant context is toxic; (2) the same agent cannot objectively validate its own work
(implementer bias); (3) external state (shared artifacts) decouples agent scope from project
scope. Role separation: Orchestrator (plans, steers, never touches code), Workers (fresh context,
narrow spec, write tests first), Validators (fresh context, see only output, verify against
behavioral contract). The validation contract is written BEFORE features are specified, mimicking
classical TDD at a project scale. On Terminal-Bench: Droid #1, using short default tool timeouts
for fail-fast behavior. Background process support via an explicit primitive that tracks spawned
processes and cleans up on session end. "Droid Computers" provide persistent filesystem+memory
across sessions — the anti-ephemeral-sandbox bet.

---

## Ranked Shortlist for Deeper Dive

**1. Letta/MemGPT** — Most directly applicable to iterate's open design-improvements items.
Letta's compaction strategies (self-compact, sliding window, incremental eviction, never-evict-
pending-approval) map 1:1 to iterate's design-improvements items 2/3/4. The memory block
architecture shows how to build typed structured state alongside a searchable workspace. Studying
Letta's `MemoryManager` source is the fastest path to a concrete iterate compaction design.
Repo: https://github.com/letta-ai/letta

**2. Factory Droid Missions** — Best articulated multi-agent orchestration with the most rigorous
separation of concerns. The orchestrator/worker/validator pattern, external-state decoupling,
and validator-uses-fresh-context principle are directly applicable to iterate's multi-agent
roadmap. The architectural write-up at https://factory.ai/news/missions-architecture is the best
public design document in the space.

**3. Gemini CLI** — Most relevant for immediate tactical improvements. The `hintBuffer` steering
injection is a clean, low-risk pattern iterate can adopt today without changing the event schema.
The tool composition layer ("tools that use tools") is a clean extension model. Apache-2.0 source
at https://github.com/google-deepmind/gemini-cli.

**4. smolagents** — Best source for studying code-vs-schema agent design with controlled
benchmarks. The `CodeAgent` vs `ToolCallingAgent` comparison is directly relevant to iterate's
codemode design and could inform whether to offer a schema-tool fallback for weaker models.
Repo: https://github.com/huggingface/smolagents

**5. mini-swe-agent** — Valuable as a complexity calibration tool. Before adding any new
mechanism to iterate's agent loop, check whether the ~100-line bash-loop baseline achieves
comparable results. Repo: https://github.com/SWE-agent/mini-swe-agent

---

## Implications for iterate

Cross-referencing design-improvements.md items 1–11 against survey findings:

**Item 1 — Normalized streaming-delta abstraction:**
Every serious framework with multiple providers implements this boundary (Mastra's PubSub event
stream, LangGraph's output schema, Gemini CLI's tool output normalization). The pattern is
universally "translate at the emitter, consume normalized." Mastra's `observe(runId, { offset })`
API for resumable streams is a concrete reference for how the normalized delta stream can serve
as the replay-friendly wire format.

**Item 2 — Usage is untyped:**
Letta and LangGraph both fold token usage into state for compaction threshold decisions. Letta
specifically requires `inputTokens + outputTokens` to determine when to trigger compaction
relative to the model's context window. This is a hard prerequisite for compaction (item 4) —
no ecosystem implementation skips this step.

**Item 3 — Context-window limits exist nowhere:**
The model-to-context-window mapping is standard in all compaction-capable frameworks. Letta
maps model strings to context windows in its model registry; Anthropic's compact API stampts
the effective context window on the response. The provider is the right owner of this mapping
(it owns the model dialect) — consistent with iterate's architecture principle.

**Item 4 — Compaction:**
The Letta `self_compact` strategy is the highest-fidelity option for an already-code-capable
agent model (Kimi K2). The `history-compacted { floorOffset, summary }` event design is
architecturally sound and unique to iterate — no other event-sourced agent system has a race-
free compaction primitive at the event layer. The Anthropic compact API and OpenAI
`/responses/compact` are provider-side and reset the continuation chain — both relevant to
items 4 + 6.

**Item 5 — Single currentRequest slot:**
Factory Droid Missions shows that orchestrator/worker role separation solves the "need
parallel requests" problem at a higher level — a dedicated compaction agent could be the
simplest path before splitting request lanes in the existing processor. Kilo Code's two-level
flat hierarchy (parent + subagents, subagents cannot spawn subagents) is a pragmatic bound on
complexity.

**Item 6 — openai-ws previous_response_id:**
The Anthropic compact API explicitly addresses this: compaction must break the continuation
chain. The compact event must reset `previous_response_id`. No ecosystem system has found a
way to compact without breaking provider-side continuation — this is a fundamental provider
constraint, not an iterate-specific limitation.

**Item 7 — openai-ws executionChain serialization:**
Per-socket serialization is a workerd constraint, not architectural. Mastra's Inngest-backed
variant sidesteps this by using HTTP Responses (not WebSocket) for compaction requests.
Plain HTTPS Responses calls for the compaction lane (no streaming needed) bypass both
`#executionChain` and `previous_response_id` concerns simultaneously.

**Item 8 — cloudflare-ai orphan sweep missing:**
The pattern is established (post-batch sweep, fail requests with no live execution owner).
It must be applied to cloudflare-ai before adding any new request lanes (compaction or
otherwise). ADK's `AbortSignal.timeout()` on provider calls is the watchdog companion.

**Item 9 — Cancellation never aborts provider:**
`AbortController` propagation into the provider call is universal practice. Mastra's
`DurableAgent.abort()` and Google ADK's `AbortSignal.timeout()` are reference implementations.
For openai-ws, abort must also clear `#executionChain`; for cloudflare-ai, abort the streaming
HTTP request. The GAIA framework's per-tool timeout + cooperative cancel event is the cleanest
layered design.

**Item 10 — Chunk write amplification:**
Mastra's PubSub cache is not a durable write per chunk — events are published to a memory/Redis
cache and only the final step state is durable. This is the "coalesce, write at turn completion"
approach. For iterate, the split-lane approach (raw frames best-effort, normalized output-delta
durable at coalesced rate) preserves crash-recovery fidelity for the UI-facing content while
eliminating per-frame durable writes.

**Item 11 — Every request re-reads the whole stream:**
LangGraph's node-checkpointing and Mastra's step-memoization both address this by storing
reduced state alongside (or instead of) the raw log. For iterate, a "processor state snapshot"
event — analogous to LangGraph's checkpoint — could store the agent's fully-reduced state at a
known offset, allowing `buildAgentLlmRequestBody` to start from the snapshot and fold only
the tail. This would reduce O(history) to O(tail-since-snapshot), bounded by compaction
frequency.

---

*Survey complete. Sibling agents (pi-mono, OpenCode v2, Claude Code, OpenAI Codex, Cloudflare
Agents SDK, Vercel eve) are covered separately and are not discussed here.*
