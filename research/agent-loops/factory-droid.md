# Factory Droid & Missions Architecture

Research for the iterate agent-loop and compaction design discussion, 2026-07-09.
Droid's core is closed-source; all claims are sourced from public documentation, blog posts, and SDK inspection. Confidence levels: **high** (primary source), **medium** (inferred from secondary sources), **speculative** (reasoned extrapolation).

---

## TL;DR

Factory Droid is a self-contained binary agent (CLI/headless) that wraps an LLM + tool loop and exposes a JSON-RPC 2.0 protocol over stdio for programmatic use. Its "Missions" system is the most clearly articulated public design for multi-agent software development: an **orchestrator** that never touches code decomposes work into **features**, a programmatic **runner** spawns one fresh worker per feature, and **fresh validators** (not the workers) judge correctness — because an implementing agent's prior context biases it toward confirming its own work.

Key findings for iterate:
- The **fresh-validator principle** is formally stated and rigorously motivated; it maps cleanly to spawning a new child agent stream for every validation pass.
- Context compaction is **blocking and reactive**, with a structured "anchored iterative summarization" strategy that outperforms OpenAI's and Anthropic's on probe-based evaluation. No parallel compaction lane exists.
- The **Deferred Context Engine** (2026-05) is a close analog to our codemode's `__describe()` discovery pattern: compact indices upfront, full schemas loaded on demand, warm cache for frequent items.
- The SDK's `SessionNotificationType` enum is the public event stream schema; it maps directly onto our stream event taxonomy.
- Terminal-Bench #1 result (58.75%, 2025-09) attributes performance to **agent design** (prompting, tool design, environment exploration, model-specific architectures), not model choice alone. Droid with Sonnet outperforms other agents using Opus.

---

## 1. Missions Architecture In Depth

**Source:** `https://factory.ai/news/missions-architecture` (Theo Luan, 2026-04-10) — confidence **high**.

### 1.1 The Context-Contamination Argument

The entire design flows from one observation, stated as four premises:

1. An agent's trajectory is **append-only** — every past thought, observation, and action stays in context.
2. Models seek **coherence** — they integrate prior context into a unified worldview and reason forward from it.
3. Therefore performance is maximized when every previous step **pushes toward the next optimal step**.
4. When context accumulates **irrelevant or adversarial** information, performance degrades.

Two specific failure modes follow:

- **Irrelevant context accumulation**: broad scope means growing context where only a shrinking fraction is relevant to the current sub-task.
- **Adversarial context accumulation** (the validator argument): an agent that *implemented* something cannot objectively evaluate it. Its implementation reasoning creates bias toward confirming its own work. A fresh validator has no such prior; its trajectory converges toward the correct evaluation zone rather than away from it.

This is the strongest public articulation of why validator isolation matters. The argument is purely about context trajectory, not about trust or credentials.

### 1.2 Three Roles with Strictly Separated Incentives

Each role has exactly one goal, and the system is structured so nothing in its trajectory pulls it off that goal:

**Orchestrator**
- Plans and decomposes the user's goal.
- Writes the **validation contract first** — a finite checklist of testable behavioral assertions — *before* defining any features. The ordering prevents the feature plan from influencing the correctness criteria.
- Decomposes work into **features** (bounded implementation units), grouped into **milestones** (logical checkpoints).
- Creates **shared state files**: `validation-contract.md`, `features.json`, `services.yaml`, `AGENTS.md`, and a growing **knowledge base**.
- Does *not* implement, *does not* investigate deeply (delegates to subagents), *does not* drive validation (the runner injects validators).
- Avoids accumulating granular implementation context.

**Workers**
- Each starts with a **fresh context window** receiving one feature spec.
- Write tests first (TDD), then implement.
- Iterate until they believe the work is correct, then hand off.
- The final judgment on correctness is **not their call**.

**Validators** (two kinds, both fresh agents)
- **Scrutiny validators**: review each worker's implementation and trajectory for quality; encode knowledge updates into shared state.
- **User-testing validators**: exercise the system as a black box (the way a real user would), verify behavior against the validation contract.
- Do *not* implement fixes — they surface issues to the orchestrator, which creates targeted fix features.

### 1.3 The Programmatic Runner

The runner is not an agent; it is deterministic orchestration machinery:

```
validate-contract.md
features.json  →  runner  →  [spawn worker_1, worker_2, …worker_n sequentially]
                         →  [all milestone features done → spawn scrutiny validators]
                                                       →  [spawn user-testing validators]
                                                       →  [orchestrator reviews → creates fix features]
                                                       →  [repeat until milestone passes]
```

Workers within a milestone run **sequentially** in the documented example (the Slack clone case study), with validators also sequential. The documentation notes that whether parallelization improves results is still an **open question** being tested (confidence: high, from the Missions docs page: "Is parallelization necessary? Running multiple agents in parallel sounds good in theory, but does it actually produce better results than sequential execution? We are testing this.").

### 1.4 Shared State as External Memory

No agent holds the complete picture. State is distributed across shared artifacts that each agent reads selectively:

- `validation-contract.md` — the behavioral assertion checklist
- `features.json` — the feature list and per-feature status
- `services.yaml` — service boundaries and contracts
- `AGENTS.md` — shared operational guidelines and worker boundaries
- A **knowledge library** that accumulates over the mission's duration (scrutiny validators write to it)

This is "externalized state" — the architectural name Factory uses for what is essentially a shared filesystem as a coordination bus between fresh agents.

### 1.5 Model Specialization

With clean role separation, model choice becomes local to each role:
- Orchestrator: broad planning and judgment (higher-capability model)
- Workers: reliable execution and cost efficiency (medium model, `--worker-model`)
- Validators: thoroughness and skepticism (designated model, `--validator-model`)

The CLI exposes this directly:
```bash
droid exec --mission -f mission.md \
  --worker-model claude-sonnet-4-5 \
  --validator-model claude-opus-4-1 \
  --validator-reasoning-effort high
```

### 1.6 Real-World Case Study: Slack Clone (Confidence: High)

A single mission built a Slack clone (auth, channels, threads, real-time messaging, reactions, mentions, file uploads, search, presence, notifications) in 16.5 hours across 6 milestones:

| Metric | Value |
|--------|-------|
| Total runtime | 16.5 h |
| Orchestration | 0.38 h (2.3%) |
| Implementation | 9.98 h (60.5%) |
| Validation | 6.14 h (37.2%) |
| Total agent runs | 185 |
| Workers | 63 |
| Validators | 27 (+82 subagents) |
| Total tokens | 778.5M |
| Cache read tokens | 744.9M (95.7% of input) |
| Code lines | 38.8k (52.5% tests) |
| Statement coverage | 89.25% |
| Fix features / total | 21 / 61 (34.4%) |
| Issues surfaced | 81 (65 blocking, 11 non-blocking, 5 suggestions) |
| Median worker trajectory | 51 turns (p90: 123) |
| Median validator trajectory | 30 turns (p90: 37) |
| Validation rounds per milestone | 2–4 |

The orchestrator spent only 2.3% of time; validation consumed 37.2% — a strong signal that validation is the bottleneck and cost, not implementation.

### 1.7 Failure Handling

If implementation or validation is **blocked**, the orchestrator halts the mission and hands control back to the user. There is no documented automatic retry at the mission level; fix features are the retry mechanism at the milestone level.

### 1.8 Mission Persistence and Resume

The `MissionState` enum in the SDK reveals the lifecycle:
`AwaitingInput → Initializing → Running → Paused → OrchestratorTurn → Completed`

A `Paused` state and `MissionResumed` progress log entry confirm missions can be suspended and resumed. The `--session-id` and `--fork` flags on `droid exec` provide the mechanism. Shared state files in the filesystem are the durable checkpoint; since each worker/validator starts fresh, resumption means the runner re-reads `features.json` and continues from the next pending feature.

---

## 2. Droid CLI/SDK Mechanics — Checklist

Sources: `docs.factory.ai`, `droid-sdk-typescript` (cloned at `~/src/github.com/Factory-AI/droid-sdk-typescript`), `factory.ai/news/terminal-bench`, `factory.ai/news/evaluating-compression`, `factory.ai/news/deferred-context-engine`.

### 2.1 Tool Calls

**High confidence.** Droid uses conventional LLM tool calls (function calling). The SDK exposes:
- `ToolConfirmationType` enum: `Edit`, `Execute`, `Create`, `AskUser`, `ExitSpecMode`, `ProposeMission`, `StartMissionRun`, `ApplyPatch`, `McpTool`
- `ToolConfirmationOutcome` enum: `ProceedOnce`, `ProceedAlways`, `ProceedAutoRun`, `ProceedAutoRun{Low,Medium,High}`, `ProceedNewSession`, `ProceedEdit`, `Cancel`
- Permission requests are server-to-client: `droid.request_permission` (the agent asks the *host* whether it can proceed)

The **autonomy level** (`off`, `low`, `medium`, `high`) determines which tool classes run without prompting:
- `off`: all tools require confirmation
- `low`: file edits + read-only commands auto-run
- `medium`: reversible commands auto-run
- `high`: all commands auto-run (including git push, deploys, long-running ops)
- `--skip-permissions-unsafe`: remove all guardrails (sandboxes only)

**Tool design philosophy** (from Terminal-Bench post, confidence: high): minimalist tool design emerged as the primary bottleneck for end-to-end task completion. Model-specific adaptations are required — one provider prefers FIND_AND_REPLACE, another V4A diff format; Droid uses a modular architecture with shared core + model-specific adapters.

**MCP support**: full, with server enable/disable, per-server timeouts, org-level allow/blocklist. The **Deferred Context Engine** (see §2.8) means MCP schemas are not all loaded upfront.

### 2.2 Truncation / Context Window

**High confidence.** Factory has a dedicated research stream on this.

**Compaction strategy** (`factory.ai/news/compressing-context`, 2025-07-21):
- **Anchored iterative summarization**: maintain a persistent structured summary with explicit sections (intent, file modifications, decisions, next steps). When truncation is needed, summarize only the **newly dropped span** and merge it into the existing summary. Never regenerate the whole summary from scratch (avoids drift across repeated compressions).
- Two thresholds: fill line (when to trigger compression) and drain line (target size after compression). Tunable per model via `compactionTokenLimit` and `compactionTokenLimitPerModel` settings.
- Sections in the structured summary: intent, file modifications, decisions, next steps, artifact breadcrumbs (file paths, function names, key identifiers for re-fetching).

**Probe-based evaluation** (`factory.ai/news/evaluating-compression`, 2025-12-16, confidence: high): evaluated 36,000+ messages from production sessions. Structured summarization outperforms OpenAI `/responses/compact` (99.3% token removal) and Anthropic SDK compression (98.7%) at similar compression rates (98.6%). Factory's method scored +0.35 higher on overall quality across six dimensions (Accuracy, Context awareness, Artifact trail, Completeness, Continuity, Instruction following). **Weakest dimension across all methods: Artifact trail** (Factory's best was 2.45/5) — tracking which files were read or modified remains hard for all summarization approaches.

**Compaction is blocking**: the `DroidWorkingState` enum has `CompactingConversation` as a distinct state; the working state notification fires during compaction. No evidence of a parallel compaction lane (confidence: high that it doesn't exist). The settings include `compactionModelMode` to run compaction with a different model than the main session.

**Auto-compression toggle**: configurable on/off per session (release notes: "Auto-compression toggle — Turn automatic session compression on or off to manage long sessions"). Queued messages during `/compress` are preserved (not dropped).

**Context stats**: `droid.get_context_stats` RPC method; `/context` slash command shows token usage breakdown. BYOK custom model context limits can be configured per-model (`compactionTokenLimitPerModel`).

### 2.3 Steering / Interruption

**High confidence** (SDK enums + docs).

**Interrupt**: `droid.interrupt_session` RPC method (client → server). The REST API also has `POST /api/v0/sessions/{sessionId}/interrupt` returning `{status: idle|pending|running}` (enterprise-only feature). Tool execution is aborted on interrupt — the release notes confirm "Tool execution after interrupts — Tools no longer continue executing after being interrupted" (previously they did, this was a known bug).

**Three-tier prompt hierarchy** (Terminal-Bench post, confidence: high): addressing recency bias in long trajectories:
1. **Tool Descriptions**: high-level capability/usage specs
2. **System Prompts**: behavioral guidelines, objectives, constraints
3. **System Notifications**: contextually injected user-level messages for critical, time-sensitive guidance at specific conversation points

System notifications proved crucial for fine-grained control without overwhelming the system prompt — they inject low-level operational details at the moment they're relevant.

**Steering mid-turn**: unknown from public docs. No evidence of an inject-before-next-LLM-call mechanism equivalent to pi's steer queue. The `droid.add_user_message` method queues messages; whether they can interrupt a running turn is **speculative** (likely they go to the next turn given the `DROID_WORKING_STATE_CHANGED` notification pattern).

**AskUser**: `droid.ask_user` is a server-to-client request — the agent can ask the host a question and pause; cancelling an AskUser prompt interrupts the agent (release notes). This is effectively synchronous human-in-the-loop within a turn.

### 2.4 Subagents / Parallel Droids

**High confidence** (SDK + docs).

**Custom Droids**: `.md` files in `.factory/droids/` or `~/.factory/droids/`. Each has its own system prompt, model, tool allowlist, and optional MCP server set. Used via the **Task tool** — the primary agent can spawn a custom droid mid-session for isolated subtasks. Key property: **each subagent runs with a fresh context window** (explicitly stated in docs: "Context isolation – each subagent runs with a fresh context window, avoiding prompt bloat.").

**Task tool**: the mechanism for invoking custom droids. Streams live progress (tool calls, results, TodoWrite updates) back to the parent. `KILL_WORKER_SESSION` RPC method allows the parent to kill a subagent. `subagentSessionId` field on `ToolProgressUpdate` notifications identifies which subagent produced a progress update.

**Parallelism**: `droid exec -w <worktree>` allows parallel headless runs in isolated git worktrees:
```bash
for path in packages/ui packages/models apps/factory-app; do
  (cd "$path" && droid exec --auto low "Run analysis") &
done
wait
```
Within a single session, subagents run sequentially by default (the Task tool is synchronous from the parent's perspective).

**Mission workers as subagents**: `DecompSessionType` enum: `Orchestrator | Worker`. `MissionWorkerStarted` / `MissionWorkerCompleted` notifications. `KILL_WORKER_SESSION` RPC lets the parent mission kill a stuck worker.

**Claude Code import**: custom droids can be imported from Claude Code agent definitions, with model family mapping. This confirms the Custom Droid / Task tool pattern is the same abstraction as Claude Code subagents.

### 2.5 Compaction (See §2.2)

Summary: anchored iterative summarization, blocking (not parallel), configurable thresholds per model, structured sections, probe-based evaluation outperforms OpenAI + Anthropic methods. Artifact tracking remains the weakest dimension.

### 2.6 Background Processes

**High confidence** (Terminal-Bench post + release notes).

Droid has a **controlled background-execution primitive**: the agent can start a process, keep working, and leave it running for tests to hit later. Backgrounding is **opt-in via settings** and filtered to block dangerous or resource-intensive commands. Every spawned process is tracked for later cleanup.

In `droid exec`, background processes now outlive the exec process itself (release note: "Background processes in droid exec — Agent-spawned background processes now keep running after `droid exec` exits"). This was important for Terminal-Bench: many tasks require starting services (servers) that outlive the agent process.

### 2.7 Streaming

**High confidence** (SDK types + protocol).

The session protocol is **JSON-RPC 2.0 over stdio** (subprocess) or HTTP. Streaming notifications from the `SessionNotificationType` enum:
- `ASSISTANT_TEXT_DELTA` / `ASSISTANT_TEXT_COMPLETE` — streaming text deltas + completion
- `THINKING_TEXT_DELTA` / `THINKING_TEXT_COMPLETE` — reasoning/thinking stream (separate from text)
- `TOOL_CALL` — tool invocation
- `TOOL_RESULT` — tool result
- `TOOL_PROGRESS_UPDATE` — live tool progress (type: `tool_call|tool_result|error|status|message`)
- `SESSION_TOKEN_USAGE_CHANGED` — token usage updates
- `DROID_WORKING_STATE_CHANGED` — state machine transitions
- Mission notifications: `MISSION_STATE_CHANGED`, `MISSION_FEATURES_CHANGED`, `MISSION_PROGRESS_ENTRY`, `MISSION_HEARTBEAT`, `MISSION_WORKER_STARTED`, `MISSION_WORKER_COMPLETED`

Output formats: `text` (default), `json`, `stream-json`, `stream-jsonrpc`. The `stream-jsonrpc` format + `--input-format stream-jsonrpc` enables full multi-turn programmatic control (the SDK uses this).

### 2.8 Deferred Context Engine (Tool Schema Loading)

**High confidence** (factory.ai/news/deferred-context-engine, 2026-05-20).

Analogous to our `__describe()` lazy-discovery pattern but for tool schemas:
- **Discover**: startup context carries compact metadata (tool names, short descriptions, parameter hints)
- **Promote**: when a task needs a capability, load the full schema via a built-in context expansion tool
- **Reuse**: loaded capabilities stay warm for the rest of the work; frequently used tools stay in a **tool cache** across sessions

Production telemetry: 16.6% of sessions start MCP servers but only 5.4% execute an MCP tool. At 20-50 hidden tools: 21% average input token reduction. At 100+ hidden tools: 50.8% average reduction. All-session average: 15.1% reduction.

Failure modes addressed: attention dilution, tool-selection noise, earlier compression (excess schemas eat context window).

### 2.9 Spec Mode

**High confidence** (docs + SDK).

A two-phase interaction mode:
1. **Analysis phase** (strictly read-only): examine codebase, related files, external sources, AGENTS.md
2. **Planning phase**: produce a structured spec with acceptance criteria, implementation plan, all files to change, test strategy
3. **Approval**: user chooses autonomy level before execution begins

`--use-spec` flag enables it in `droid exec`. `DroidInteractionMode.Spec` in the SDK. A separate `--spec-model` allows a different model for planning than for execution. `ExitSpecMode` is a `ToolConfirmationType` — the agent asks permission to leave spec mode and start implementing.

The `--mission` flag in `droid exec` implicitly uses a spec-like orchestration phase before execution.

### 2.10 Session Persistence / Resume / Fork

**High confidence** (CLI + SDK).

- `--session-id`: continue an existing session (requires a new prompt)
- `--fork <id>`: branch from an existing session into a new copy
- `droid.get_rewind_info` + `droid.execute_rewind`: rewind to a previous conversation state (visible in SDK methods)
- Sessions are named, resumable via `droid --resume [sessionId]`
- `5-hour session limit` exists for Droid sessions (release notes mention this as a known issue with deprecated model warnings)

### 2.11 Timeouts

**Medium confidence** (settings doc + release notes).

- `llmRequestTimeout`: configurable per-session LLM request timeout in milliseconds
- `mcp.callTimeoutMs`: global MCP tool call timeout, overridable per-server
- Context limit errors are classified distinctly from timeout errors (release note: "Context limit classification — Requests exceeding a model's context window are now classified as context-limit errors")
- Corporate network/firewall/TLS errors are treated as non-retryable (release note)
- Agent loop stalls fixed: "The agent loop no longer runs unbounded when turns produce no output" (release note bug fix)

### 2.12 Model Support

**High confidence** (SDK `ModelProvider` enum + settings docs).

Supported providers: `anthropic`, `openai`, `google`, `xai`, `generic-chat-completion-api` (BYOK via any OpenAI-compatible endpoint), `voyage` (embeddings), `factory` (internal).

Reasoning effort: `none | dynamic | off | minimal | low | medium | high | xhigh | max` — fine-grained control across providers. Model-specific architectures are implemented internally (different tool formats per provider).

**BYOK**: custom models via `base_url` + provider-specific settings. Can point to LLM gateways (Anthropic/OpenAI base URL env vars). Known issue: context window size cannot be auto-detected for custom models (GitHub issue #1267).

### 2.13 Unknowns / Gaps

| Topic | Status |
|-------|--------|
| Internal event sourcing / state management | Unknown; core is closed-source |
| Mid-turn steer injection (insert before next LLM call without waiting for turn end) | Speculative/unlikely; no public evidence |
| Compaction timing within a worker turn | Unknown; likely blocking at end-of-turn |
| Worker-to-worker communication | None apparent; workers communicate only through shared state files |
| Orchestrator persistence model across restarts | Durable via filesystem + session resume; details unknown |
| Whether validators can request more context from workers | Unknown; docs only say they surface issues to orchestrator |

---

## 3. Terminal-Bench Performance (2025-09-25)

Source: `factory.ai/news/terminal-bench`, confidence **high**.

Droid scored **58.75%** on Terminal-Bench Core v0.1.1 (80 tasks) — #1 at the time, ahead of all other agents on every model. Factory agents occupied three of the top five positions (Opus 4.1, GPT-5, Sonnet 4).

**What Factory attributes the performance to** (not model choice alone):
1. **Hierarchical prompting** (three-tier system: tool descriptions → system prompts → system notifications injected at conversation points to fight recency bias)
2. **Model-specific architectures** (separate tool-format adapters per provider; embracing heterogeneity rather than forcing uniformity)
3. **Minimalist tool design** (tool reliability is the bottleneck; fewer, more reliable tools beat more tools)
4. **Systematic environment exploration** (proactive, structured codebase discovery)
5. **Speed optimizations** (unstated in detail; likely parallelism + caching)

The cross-model point is important: Droid with Sonnet outperforms *other agents using Opus*. This is consistent with our own finding that agent design dominates model selection in real tasks.

Note: the Terminal-Bench 2.0 paper (arxiv 2026-01) does not rank Droid on TB2.0; the #1 result cited by Factory was TB 1.0 (v0.1.1). TB2.0 results show Codex CLI+GPT-5.2 at 62.9% as highest.

---

## 4. Secondary Sources

### 4.1 Engineering Blog Posts

| Post | Key Finding |
|------|-------------|
| `factory.ai/news/missions-architecture` (2026-04) | The Missions architecture (§1 above) |
| `factory.ai/news/terminal-bench` (2025-09) | Terminal-Bench #1 + agent design attribution (§3 above) |
| `factory.ai/news/evaluating-compression` (2025-12) | Probe-based compaction evaluation framework, anchored iterative summarization wins |
| `factory.ai/news/compressing-context` (2025-07) | The fill/drain threshold model, anchored summary approach, proactive memory curation direction |
| `factory.ai/news/deferred-context-engine` (2026-05) | Deferred tool schema loading (§2.8) |
| `factory.ai/news/factory-signals` (2026-01) | Recursive self-improvement via LLM-as-judge session analysis; closed loop: friction detection → Droid files/implements its own fixes |
| `factory.ai/news/software-factory` (2026-06) | "Factory 2.0" — the full autonomous software development lifecycle vision |

### 4.2 Founder Interviews

**Latent.Space podcast (2025-05)** — Eno Reyes & Matan Grinberg:
- Droid started as a server-side while-loop, evolved to full-stack, now a "fully self-contained binary that runs on any OS/device/environment with any interface"
- Long-term goal-directed behavior is "arguably the most important piece of research" at Factory
- Model agnosticism is a core differentiator: building a good agent requires being model-agnostic

**Stack Overflow blog (2026-02)** — Eno Reyes at re:Invent:
- Performance is "the sum of hundreds of little optimizations" — no individual secret
- Autonomy level (low/medium/high) maps to what the agent can do without input; medium = reversible commands only
- Context management is the hard problem: "how you choose to instruct or inject environment information, how you handle tool calls — the sum of all these things requires attention to detail"
- Quality signal (linters, tests, type checkers) is the key enabler of autonomous coding: "Stanford research found the ONLY predictor of AI success was codebase quality"

**YouTube/The Neuron (2026-01)** — Eno Reyes:
- Recommends using `droid exec` (headless CLI) for anyone building agentic products: "gives you compaction, all the bells and whistles, but lets you fully customize"
- "You can honestly paste our blog post [on compression] and implement something basically as good as our compaction" — minimal gatekeeping on the approach

### 4.3 GitHub Issues (Factory-AI/factory)

Notable for design insight:
- **#1267**: BYOK custom models can't auto-detect context/input window size — confirms Factory tracks `contextWindow` per model internally; BYOK can't populate it
- **#1176**: Droid CLI keeps auto-injecting "Continue" during long tasks with Cloudflare models only — a provider-specific behavior that disrupts the agent loop (regression pattern we have too)
- **#1190**: Context DoS via long git status output — context bloat from tool output is a known production issue
- **#1200**: 5-hour session limit with deprecated model warnings — sessions have an explicit time cap
- **#1270**: deep-security-review skill Task dispatch consistently fails with "Tool execution was cancelled" — subagent stability is a known pain point

---

## 5. SDK Event Schema

The TypeScript SDK (`@factory/droid-sdk`, cloned at `~/src/github.com/Factory-AI/droid-sdk-typescript`) exposes the public protocol. The session notification types map directly to our stream event taxonomy:

```typescript
// From src/schemas/enums.ts

// Working states (our currentRequest phases equivalent)
DroidWorkingState {
  Idle,
  StreamingAssistantMessage,  // our llm-request-requested → output-added range
  WaitingForToolConfirmation,
  ExecutingTool,              // our script-execution-requested phase
  CompactingConversation,     // no equivalent in our system yet
}

// Notification event types (our stream event types equivalent)
SessionNotificationType {
  ASSISTANT_TEXT_DELTA,       // our agent/output-delta (item 1 of design-improvements.md)
  ASSISTANT_TEXT_COMPLETE,    // our agent/output-added
  THINKING_TEXT_DELTA,        // no equivalent (we don't journal thinking separately)
  THINKING_TEXT_COMPLETE,
  TOOL_CALL,                  // our capability-host/script-execution-requested
  TOOL_RESULT,                // our capability-host/script-execution-completed
  TOOL_PROGRESS_UPDATE,       // live subtool progress; no equivalent
  SESSION_TOKEN_USAGE_CHANGED, // our llm-request-completed usage (item 2)
  // Missions:
  MISSION_STATE_CHANGED,      // parent stream / mission stream event
  MISSION_WORKER_STARTED,     // child agent stream birth
  MISSION_WORKER_COMPLETED,   // child agent stream settlement
  MISSION_HEARTBEAT,          // keepalive for long-running missions
  MISSION_FEATURES_CHANGED,   // shared state update notification
}

// Mission feature lifecycle (from src/schemas/mission.ts)
MissionFeature {
  id, description, status (pending|in_progress|completed|cancelled),
  skillName,
  preconditions, expectedBehavior, verificationSteps,
  fulfills,          // which validation contract assertions this feature claims
  milestone,
  workerSessionIds,  // all worker sessions that attempted this feature
  currentWorkerSessionId,
  completedWorkerSessionId,
}
```

The `fulfills` array on `MissionFeature` is architecturally significant: each feature explicitly claims which validation contract assertions it covers. This is how the runner knows which assertions to re-verify after a fix feature completes.

---

## 6. Implications for iterate

Cross-referencing `apps/os/src/domains/agents/design-improvements.md`.

### 6.1 The Fresh-Validator Principle → Child Agent Streams

**Design-improvements.md relevance**: new item candidate (not yet listed; closer to item 5's parallel request slot discussion).

Factory's architecture maps cleanly onto our streams model:

```
Mission = parent stream (orchestrator agent)
Feature  = child stream (worker agent)
Milestone validation = N child streams (validator agents)
```

The orchestrator lives at e.g. `/agents/missions/primary`. Each worker is a fresh agent at `/agents/missions/workers/<feature-id>`. Each validator is a fresh agent at `/agents/missions/validators/<milestone-id>/<round>`.

**The fresh-validator principle in our terms**: a validator agent stream has *no shared history* with any worker stream — not even through a shared parent stream — because Missions explicitly isolates validator contexts. In our system this means validators should be separate streams (not sub-paths of worker streams), receiving only the shared state files + validation contract as their input-added history, not the worker's trajectory.

**Key difference from our current subagent plans**: PR agents (#1779, merged) spawn agents at `/agents/repos/<slug>/pull-requests/<n>`, which get the PR diff as context. This is closer to the worker pattern. A full Missions-style design would additionally spawn *fresh validator* agents that explicitly do *not* inherit the PR author's context.

### 6.2 Orchestrator's "Don't Accumulate Granular Context" Rule

**Design-improvements.md relevance**: motivates item 4 (compaction) and item 11 (O(history) re-fold).

The orchestrator's rule is: delegate investigation and implementation to subagents; retain only the high-level plan and milestone status. In our event-sourced model this maps to:
- Orchestrator stream: only receives `feature-completed` / `validation-passed` / `issues-surfaced` events, not the full worker or validator histories
- Worker streams: full tool/script/LLM history — but their streams are *separate*, not folded into the orchestrator's context
- The shared state files are the communication channel, not nested event streams

This is architecturally compatible with our stream-per-agent model and avoids our item 11 problem (O(history) re-fold) at the orchestrator level — it never sees worker details.

### 6.3 Validation Contract Before Feature Decomposition → Event Schema Design

Factory writes the validation contract *before* features. Applied to our platform: before implementing a multi-agent capability, define the behavioral assertions (what events prove it's correct) before designing the feature event sequences. This is the multi-agent analog of TDD.

### 6.4 Compaction: Anchored Iterative Summarization → Item 4

Factory's approach directly implements what item 4 sketches: a `history-compacted` event (their "anchor message") that replaces history up to a floor offset with a structured summary. Key additions from their research:

- **Section structure matters**: explicit sections for intent, file modifications, decisions, next steps, artifact breadcrumbs. A generic prose summary scores lower on artifact trail (2.45/5 is their best). We should include `filesModified`, `decisionsReached`, `nextSteps` sections in our `agent/history-compacted` payload.
- **Never regenerate the full summary**: only summarize the newly dropped span and merge. Regenerating causes drift. This means our compaction event should carry a `previousSummary` reference (analogous to pi's `previousSummary` field).
- **Optimize tokens per task, not tokens per request**: aggressive compression that causes re-fetching is net worse. Our drain-line threshold should leave enough context to avoid re-running expensive operations.
- **Artifact trail is the weakest link**: consider dedicated state tracking (e.g., a `filesModified` log that compaction always preserves verbatim, not summarized).

### 6.5 Deferred Context Engine → `__describe()` Already Covers This

Our `__describe()` discovery pattern is architecturally equivalent to Factory's Deferred Context Engine: compact indices by default, full schemas on demand. Factory's production data (50.8% token reduction at 100+ deferred tools) validates the approach quantitatively. Our system does this at the itx RPC surface level; Factory does it for MCP tool schemas and skill instructions.

The main gap: we don't have a "warm cache across sessions" for frequently used `__describe()` results. Factory explicitly caches frequently used tool schemas across sessions.

### 6.6 Three-Tier Prompt Hierarchy → Items 1, 2

Factory's system notifications tier (contextually injected at conversation points) is the mechanism they use to fight recency bias in long trajectories. In our terms: instead of encoding all guidance in the initial system prompt, inject *targeted, time-sensitive* guidance as `agent/input-added` events (with `dont-trigger-request`) at the right moment in the trajectory.

Our `AGENT_SNIPPET_GUIDE` and `DEFAULT_AGENT_SYSTEM_PROMPT` are tier 2 (system prompt). We have no tier 3 equivalent. Adding time-sensitive notifications as non-triggering inputs (e.g., "You have used 80% of your context window; prefer returning less data") would be the analogue.

### 6.7 Blocking Compaction is Universal

Item 4 notes we could do non-blocking compaction (our novel ambition). Factory does not — compaction blocks (`CompactingConversation` working state). All systems surveyed in this research series (pi, OpenCode, Claude Code, Codex, Cloudflare Think) also block. The non-blocking lane remains genuinely novel and unproven at scale.

### 6.8 Sequential Workers with Validation Gates

The Missions design runs workers **sequentially within a milestone**, not in parallel, and injects validation between milestones. The parallel-vs-sequential question is explicitly open for Factory too. Our design-improvements.md item 5 (parallel request slots) is about compaction-vs-conversation parallelism, not worker parallelism — a different axis. The Missions precedent suggests sequential execution with frequent validation gates may produce better correctness than parallel execution with a single end validation.

### 6.9 34.4% Fix Feature Rate

21 fix features / 61 total features. In planning multi-agent missions on iterate, budget ~35% additional work for post-validation fixes. The iteration loop (implement → validate → fix → re-validate) is not overhead; it is the mechanism of correctness. Orchestrators that try to get it right in one pass will produce worse outputs than ones that plan for 3-4 validation rounds per milestone.

---

## References

| Source | URL | Date | Confidence |
|--------|-----|------|------------|
| Missions Architecture | https://factory.ai/news/missions-architecture | 2026-04-10 | High |
| Terminal-Bench #1 | https://factory.ai/news/terminal-bench | 2025-09-25 | High |
| Evaluating Context Compression | https://factory.ai/news/evaluating-compression | 2025-12-16 | High |
| Compressing Context | https://factory.ai/news/compressing-context | 2025-07-21 | High |
| Deferred Context Engine | https://factory.ai/news/deferred-context-engine | 2026-05-20 | High |
| Factory Signals | https://factory.ai/news/factory-signals | 2026-01-23 | High |
| Factory 2.0 | https://factory.ai/news/software-factory | 2026-06-15 | High |
| Droid Exec docs | https://docs.factory.ai/cli/droid-exec/overview | current | High |
| Custom Droids docs | https://docs.factory.ai/cli/configuration/custom-droids | current | High |
| Memory & Context Management | https://docs.factory.ai/guides/power-user/memory-management | current | High |
| Missions docs | https://docs.factory.ai/features/missions/overview | current | High |
| Settings | https://factory.mintlify.app/cli/configuration/settings | current | High |
| LLM Safety & Agent Controls | https://factory.mintlify.app/enterprise/llm-safety-and-agent-controls | current | High |
| Specification Mode | https://docs.factory.ai/cli/user-guides/specification-mode | current | High |
| Interrupt API | https://docs.factory.ai/api-reference/sessions/interrupt-a-session | current | High |
| CLI Reference | https://docs.factory.ai/reference/cli-reference | current | High |
| SDK TypeScript | https://github.com/Factory-AI/droid-sdk-typescript | current | High |
| Latent.Space podcast | https://www.latent.space/p/the-ai-coding-factory | 2025-05-29 | Medium |
| Stack Overflow blog | https://stackoverflow.blog/2026/02/04/code-smells-for-ai-agents-q-and-a-with-eno-reyes-of-factory/ | 2026-02-04 | High |
| YouTube / The Neuron | https://www.youtube.com/watch?v=yAz64MMy88A | 2026-01-27 | Medium |
| Terminal-Bench 2.0 paper | https://arxiv.org/html/2601.11868v1 | 2026-01-17 | High |
| Factory GitHub issues | https://github.com/Factory-AI/factory/issues | current | High |
