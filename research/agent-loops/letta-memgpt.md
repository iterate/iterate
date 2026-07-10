# Letta / MemGPT — Deep Dive

**Research date:** 2026-07-09  
**Repo cloned:** `~/src/github.com/letta-ai/letta` (commit depth=1, `main`)  
**Scope:** Memory hierarchy, context-window management, compaction mechanics, sleep-time agents, persistence model, .af format.  
**Design crosswalk:** `apps/os/src/domains/agents/design-improvements.md` items 2–5.

---

## 1. Origins: MemGPT paper (arxiv 2310.08560)

The 2023 paper coined the OS-paging analogy: treat the LLM context window as "RAM", external storage as "disk", and let the LLM itself page data in and out via function calls.

Key ideas from the paper that survived into current Letta:

- **Three-tier hierarchy** — system instructions (read-only), working context (editable blocks), FIFO message queue.
- **Self-directed memory management** — the LLM calls memory tools (`core_memory_append`, `archival_memory_insert`) rather than the platform triggering compaction silently.
- **Warning token count (70%) → flush token count (100%)** — the paper described a two-stage pressure signal. In current Letta code this collapsed to a single reactive trigger at 90%.
- **Recall storage** (conversation DB) and **archival storage** (vector DB) are the paper's external memory tiers; both survive intact.

The paper's compaction is agent-initiated: when queue pressure builds, the agent calls memory tools to offload. The current Letta platform-driven compaction (`compact_messages()`) is a later addition that compacts without the agent's input.

---

## 2. Memory Hierarchy — Current Implementation

### 2.1 Core Memory (in-context blocks)

`letta/schemas/block.py` — `Block` dataclass:

```python
value: str           # current string content
limit: int           # char cap, default CORE_MEMORY_BLOCK_CHAR_LIMIT = 100_000
label: str           # identifies the block ("human", "persona", custom)
read_only: bool      # if True, only the API can write; tools cannot
```

Validated on every `__setattr__` — setting `value` beyond `limit` raises immediately.

**Rendering** (`letta/schemas/memory.py` → `Memory.compile()`): each block is emitted inside XML tags, e.g.

```xml
<memory_blocks>
  <human>
    <description>...</description>
    <metadata>
      - chars_current=342
      - chars_limit=100000
    </metadata>
    <value>Name is Alice...</value>
  </human>
</memory_blocks>
```

For Anthropic + certain agent types, line numbers are injected into the value (`{n}→ line`) to help exact-match tools (`core_memory_replace` requires `old_content` to match verbatim).

**Git-enabled variant** (`Memory.git_enabled=True`): blocks use slash-namespaced labels (`system/persona`, `system/human`). Rendered differently — `<self>` + `<memory>` nested XML + `<memory_filesystem>` tree. This is the MemFS / "context repository" pattern promoted in Letta Agent.

### 2.2 Recall Memory (conversation DB)

All messages persisted in PostgreSQL. `conversation_search` in `base.py` (line 87) does hybrid search (text + semantic similarity) via `message_manager.list_messages_for_agent()`, returning paginated results (default page = `RETRIEVAL_QUERY_DEFAULT_PAGE_SIZE = 5`).

The in-context message window is a FIFO tail of the persisted messages; messages scrolled off context are not deleted — just not rendered until retrieved via `conversation_search`.

### 2.3 Archival Memory (vector DB)

`letta/schemas/passage.py` — `Passage`: `text`, `embedding: List[float]`, `embedding_config`, `tags`, `metadata`.

`archival_memory_insert` (base.py:164) and `archival_memory_search` (base.py:194) are the tool signatures. Both are `NotImplementedError` stubs at this level — the actual implementation is injected at runtime by the agent server. `archival_memory_search` supports tag filtering (`tag_match_mode: "any"|"all"`), date range, and `top_k` (default 10).

For archival passages stored in pgvector, embeddings are padded to `MAX_EMBEDDING_DIM`. Turbopuffer is used for file passages when configured.

---

## 3. Context-Window Management

### 3.1 Model → Context-Window Registry

`letta/schemas/llm_config.py` — `LLMConfig.context_window: int` is **required** on the config object. There is no separate registry table; the value is baked into `LLMConfig` at agent-creation time.

Hardcoded defaults in the schema (`model_validator`):

| Model | context_window |
|---|---|
| `gpt-5*` | 272,000 |
| `claude-3-5*` | 256,000 |
| `gpt-4o*` | 128,000 |
| default / unknown | 8,192 |

The `LLMConfig` is stored in the agent row. Changing the model after creation does not auto-update `context_window` — the caller must set it.

### 3.2 Token Counting

Factory: `letta/services/context_window_calculator/token_counter.py` → `create_token_counter(model_endpoint_type, model, actor, agent_id)`:

| Provider | Counter | Method |
|---|---|---|
| `anthropic` | `AnthropicTokenCounter` | Anthropic count-tokens API (async, Redis-cached by SHA256 of content, TTL 3600s) |
| `google_vertex`, `google_ai` | `GeminiTokenCounter` | Google count-tokens API (same Redis cache pattern) |
| Everything else | `ApproxTokenCounter` | `ceil(json_bytes / 4)` — the codex-cli approximation |

`ContextWindowCalculator.calculate_context_window()` breaks down the in-context tokens into labelled components: `system`, `memory_blocks`, `memory_filesystem`, `tool_usage_rules`, `directories`, `summary_memory` (the injected compaction summary, detected at index 1), `functions_definitions`, and `messages`. Each component is counted separately and exposed via `ContextWindowOverview`.

### 3.3 Compaction Trigger

`letta/services/summarizer/thresholds.py`:

```python
SUMMARIZATION_TRIGGER_MULTIPLIER = 0.9
trigger = int(llm_config.context_window * SUMMARIZATION_TRIGGER_MULTIPLIER)
```

The code note says 0.9 instead of 1.0 because hitting 100% causes "too many tokens" errors — a pure defensive margin.

**Current agent v3 (`letta_agent_v3.py`) state**: proactive compaction code is COMMENTED OUT. The agent only compacts reactively — when the LLM API returns `ContextWindowExceededError`. The v2 agent had the same proactive code and also commented it out. The `thresholds.py` function exists and is wired in the non-agent "Temporal" and legacy paths, but the main `LettaAgentV3` turn loop does not check utilization proactively between turns.

`_check_for_system_prompt_overflow()` runs before each LLM call and raises `SystemPromptTokenExceededError` if the system prompt alone (blocks + tools) exceeds the context window — this is a separate guard, not compaction.

---

## 4. Compaction Mechanics

Two code paths exist side by side — a legacy `Summarizer` class and the newer `compact_messages()` function.

### 4.1 `CompactionSettings` schema

`letta/services/summarizer/summarizer_config.py`:

```python
class CompactionSettings(BaseModel):
    model: str | None           # default: haiku/gpt-5-mini/gemini-2.5-flash per provider
    mode: Literal[
        "all",                  # summarize all non-system messages
        "sliding_window",       # keep a tail, summarize the head
        "self_compact_all",     # agent self-summarizes (own LLM)
        "self_compact_sliding_window",
    ]
    sliding_window_percentage: float   # fraction of window to KEEP (default ~30%)
    prompt: str | None          # filled from mode-specific defaults if None
    clip_chars: int | None      # max summary length (default 50_000)
    prompt_acknowledgement: bool
```

Default summarizer models: `anthropic/claude-haiku-4-5`, `openai/gpt-5-mini`, `google_ai/gemini-2.5-flash` — deliberately cheap.

### 4.2 `compact_messages()` — the non-legacy path

`letta/services/summarizer/compact.py`:

**Cascade order**: `self_compact_all` → `self_compact_sliding_window` → `all`. (Never falls through to `sliding_window` in the cascade — sliding_window modes are their own branch.)

**Steps:**

1. Separate system message from history.
2. Based on mode, call the appropriate summarizer (self_summarize_all / sliding-window variant / external model).
3. Build `CompactResult(summary_message, compacted_messages, summary_text, context_token_estimate)`.
4. After compaction, re-count tokens. If still over threshold:
   - If system prompt is the culprit → raise `SystemPromptTokenExceededError`.
   - Otherwise → log `CRITICAL` but don't brick the agent (it will hit the LLM's own limit at inference time).
5. Final message arrangement: `[compacted_messages[0], summary_message_obj] + compacted_messages[1:]`
   - `compacted_messages[0]` is the system message.
   - The summary is inserted at **index 1** (immediately after system), tagged `role=summary` (or `role=user` in legacy mode), with sentinel text `"The following is a summary of the previous"` so `extract_summary_memory()` can detect and re-extract it later.

### 4.3 Legacy `Summarizer` class

`letta/services/summarizer/summarizer.py` — two strategies:

**`STATIC_MESSAGE_BUFFER`** (count-based):
- `message_buffer_limit=10`: if history exceeds this count, trigger summarization.
- `message_buffer_min=3`: keep at least this many messages after eviction.
- Fires the summarizer agent as a **detached async fire-and-forget** (`safe_create_task`). This is the closest thing to "background" — but it still runs within the same asyncio event loop as the request.
- Used by `VoiceSleeptimeAgent` (limit=20, min=10).

**`PARTIAL_EVICT_MESSAGE_BUFFER`** (percentage-based):
- Evicts 30% of messages (configurable via `summarizer_settings.partial_evict_summarizer_percentage`).
- Blocking `await` for the summary — not background.

**`simple_summary()` fallback cascade**: 
1. Normal summarization call.
2. If fails: clamp all tool return content to `TOOL_RETURN_TRUNCATION_CHARS`.
3. If still fails: middle-truncate the transcript (head 30% + tail 30%).

**Provider fallbacks**: Anthropic primary → Bedrock Opus 4.5; ZAI → Baseten.

### 4.4 `self_summarize_all` — self-compact mode

`letta/services/summarizer/self_summarizer.py`: the agent's own LLM is invoked to summarize its own history. The prompt is injected as a `user` message at the end. If the last message is not `assistant`, a dummy `"I understand. Let me summarize."` assistant message is prepended to maintain role alternation. The LLM response is the summary text.

This is the "Claude Code-style" summarization referred to in the file's docstring — same pattern as Codex self-compact.

---

## 5. Sleep-Time Agents

### 5.1 Concept

Introduced as "MemGPT 2.0" / sleep-time compute (blog post April 2025). The observation: original MemGPT bundles memory management, conversation, and everything else into one agent, making it slow (serial memory tool calls during conversation) and messy (incremental memory edits accumulate noise). Sleep-time offloads memory management to a dedicated background agent that:

- Shares memory blocks with the foreground agent (shared `block_id` means writes by the sleep-time agent immediately affect what the foreground agent sees on the next render).
- Fires every N foreground turns (`sleeptime_agent_frequency`, default 5).
- Receives a formatted transcript of recent messages, not the raw stream.

### 5.2 Implementation: `SleeptimeMultiAgentV4`

`letta/groups/sleeptime_multi_agent_v4.py`:

```
step() / stream()
    ↓
super().step()  ← foreground LettaAgentV3 completes FULLY first
    ↓
run_sleeptime_agents()
    ↓ for each agent_id in group.agent_ids:
_issue_background_task(sleeptime_agent_id, response_messages, ...)
    ↓
safe_create_task(_participant_agent_step(...))  ← asyncio.create_task, NOT a thread
    return run_id immediately
```

**Crucial fact: the foreground step completes before sleeptime fires.** In the `stream()` path, sleeptime runs in the `finally:` block — after the last chunk is yielded. The comment in the code acknowledges "GeneratorExit even though client is getting the whole stream."

The sleep-time agent is a full `LettaAgentV3` instance instantiated fresh inside `_participant_agent_step`. It receives a formatted transcript:

```
<system-reminder>
You are a sleeptime agent... reviewing a conversation that already happened...
Your primary role is memory management.
</system-reminder>

Messages:
[formatted prior_messages + response_messages]
```

The prior messages span from `last_processed_message_id` to the start of the latest batch — so on frequency=5 the agent sees 5 turns of conversation.

**Conflict avoidance**: there is NO locking. Shared memory blocks use last-write-wins. If two sleep-time agents run concurrently (multiple agent IDs in `group.agent_ids`), they race. The assumption is that they're assigned to non-overlapping blocks (e.g. one manages `human`, another manages `topics`). If the same block is written by two concurrent sleeptime agents, the last DB write wins with no merge.

**Turn counter** is stored on the `Group` object and bumped atomically with `bump_turns_counter_async`. The mod-N check is done server-side; the counter is not per-session so it persists across restarts.

### 5.3 Sleep-time Tools

From `letta/functions/function_sets/base.py`:

- `rethink_memory(agent_state, new_memory, target_block_label)` — whole-block replacement. If block doesn't exist, creates it.
- `memory_replace(agent_state, label, old_string, new_string)` — surgical patch; must match exactly.
- These differ from the foreground agent tools (`core_memory_append`, `core_memory_replace`) — the sleeptime set is tuned for wholesale reorganization.

For voice sleeptime: `store_memories → rethink_user_memory (continuous) → finish_rethinking_memory (terminal)`.

### 5.4 Sleep-time vs True Parallelism

"Sleep-time compute" is a marketing label; the implementation is **strictly sequential**. The asyncio task fires after the foreground response is complete — the user's reply is gated on the foreground turn. The sleeptime task runs concurrently only with the next user HTTP request wait (i.e., while the user is typing or thinking). There is no preemption, no actor model, no queue. If the sleeptime agent is slow, its work will likely still be running when the next foreground turn starts — the next foreground turn does NOT wait for it.

For the specific latest version (`SleeptimeMultiAgentV4`), the "background" is just asyncio `create_task` within the same Python process. In a multi-process / multi-worker HTTP server deployment this means the task runs on the same worker that handled the HTTP request — it could be killed by a graceful restart.

---

## 6. Persistence Model and .af Format

### 6.1 Persistence

State lives in PostgreSQL. Key tables: `agents` (agent state, llm_config, compaction_settings), `blocks` (memory blocks, referenced by agents via join), `passages` (archival memory), `messages` (recall memory). Blocks can be shared across agents via the `block_id` foreign key.

`_checkpoint_messages()` in `LettaAgentV3` persists new messages after each step. This is a blocking DB write at the end of the turn (not event-sourced — it's mutable DB rows, not an append-only log).

### 6.2 .af (Agent File) Format

`letta/schemas/agent_file.py` — `AgentSchema(CreateAgent)`:

Fields beyond `CreateAgent`:
- `messages: list[MessageCreate]`
- `in_context_message_ids: list[str]` — which messages are currently in-context
- `files_agents: list[...]`
- `group_ids: list[str]`

Inherited from `CreateAgent`: `tool_ids`, `source_ids`, `block_ids`, `identity_ids`, `llm_config`, `embedding_config`, system prompt, `enable_sleeptime=False` (TODO noted in the code).

This is a snapshot, not a replay log — it captures the agent's entire current state as a single JSON/YAML document for import/export. There is no event history in the .af.

---

## 7. Key GitHub Issues / Design Archaeology

From searching the repo history and the public Letta GitHub:

- **Proactive compaction commented out**: The code comments in `letta_agent_v3.py` and `letta_agent_v2.py` both say proactive compaction is disabled. This is a known regression — likely due to reliability issues when proactive compaction fired during streaming and caused token budget surprises.
- **SleeptimeMultiAgentV4** is the current version; V1–V3 exist in `groups/`. The main evolution was moving from `v2`'s fire-and-forget-inside-step to v4's explicit `run_sleeptime_agents()` called after `super().step()`, giving cleaner lifecycle control and proper `run_id` tracking.
- **CompactionSettings** was added to externalize the previously hardcoded mode/model choices into a per-agent config, reflecting customer demand for control over compaction behavior.

---

## 8. Implications for iterate

### Item 2: Usage is untyped and never folded

Letta normalizes usage at the step level via `_update_global_usage_stats()` into a typed `UsageStatistics` object (`prompt_tokens`, `completion_tokens`, etc.). The `ContextWindowCalculator` provides a more granular breakdown by component (system, blocks, tools, messages, summary). This is exactly what item 2 asks for: typed, component-aware usage that can drive compaction decisions.

**Takeaway**: The provider reports raw usage; an agent-owned fold accumulates it and compares against `context_window`. We should do the same. Their `context_window` value lives on `llm_config` (the per-agent config row). The context_window and usage should both be stamped on `llm-request-completed` so the agent processor can compute `utilization = totalTokens / contextWindow`.

### Item 3: Context-window limits exist nowhere

Letta solves this by **requiring** `context_window` on `LLMConfig` at creation time, with hardcoded defaults for known model families. There is no separate registry — it's a required field with fallback defaults.

**Takeaway for iterate**: The provider processor already knows the model; it should also own the `model → contextWindow` mapping. Ship this as a static table in the provider processor (matching Letta's hardcoded defaults: GPT-5 = 272k, Claude 3.5 = 256k, etc.) and stamp `contextWindow` on `llm-request-completed`. The agent processor folds `utilization` and compares against a config threshold. No external registry needed.

### Item 4: Compaction

Letta's compaction design has several things worth copying:

1. **Summary injection at position 1**: the compacted summary is inserted immediately after the system message, tagged with a sentinel string so future context-window analysis can detect and re-extract it. This gives a clean separation between the "permanent" system prompt region and the "summary" region vs the live message tail.

2. **Cascade fallback**: mode → attempt → if over threshold: system-prompt-check → critical-log. Doesn't brick the agent if compaction overshoots; logs loudly and continues.

3. **Dedicated cheap model for compaction**: haiku / gpt-5-mini / gemini-flash. Not the agent's own model. This matters for cost.

4. **Self-compact modes**: the agent's own LLM summarizes its own history. For iterate's codemode agents, this is the most natural fit — the agent already knows the domain; a cheap external summarizer may miss context.

**Takeaway for iterate**: The `history-compacted { floorOffset, summary }` event design in item 4 already captures the right shape. The summary injection and detection pattern from Letta (sentinel string + position-1 placement) is a concrete implementation recipe. The cascade (try self-compact → fall back to external model → if still over: gate but don't crash) maps directly.

### Item 5: Single `currentRequest` slot blocks parallel LLM requests

Letta's sleep-time agents expose the limitation explicitly: `SleeptimeMultiAgentV4.stream()` fires the sleep-time task in `finally:` — after the foreground response is done. This is NOT parallel compaction; it's sequential with a latency seam.

The blog post markets this as "background" but the code is honest: the asyncio task is detached, which means it races with the next foreground turn rather than with the current one. The lack of explicit synchronization between sleeptime agents writing blocks and the foreground agent reading those same blocks on the next turn is a known design gap (last-write-wins, no locking).

**Takeaway for iterate**: Letta's "sleep-time" is closer to iterate's item 4 (blocking compaction between turns) than item 5 (true parallel lanes). The genuine parallelism Letta doesn't solve is what item 5 is after: a compaction lane that runs concurrently with a live user conversation turn. Letta punts on this — compaction fires after foreground, not alongside it. For iterate, the sequencing guidance in item 4 ("ship blocking compaction first, then split lanes") is validated by Letta's own experience: they tried parallel-looking patterns and the production implementation collapsed back to "after the foreground step."

The shared-block write conflict risk Letta has (concurrent sleeptime agents race on the same block) is the exact problem iterate's event-sourced `history-compacted` event with a `floorOffset` avoids by construction — any request that folds the event replays from the compacted base; there's no mutable shared state to race on.

### Self-editing memory via codemode scripts

Letta's sleep-time agent is essentially "a separate agent that reads the transcript and rewrites memory blocks." In iterate's architecture this maps to: a codemode script turn that reads recent agent history (via `itx.agents.history` or similar), synthesizes updated summary text, and emits a `history-compacted` event. The platform doesn't need a separate "sleep-time agent" primitive — a script turn can do the same work.

The advantage iterate has: codemode scripts already have access to the full workspace (files, git history) and the agent's own tools, so a "compact and reflect" script can do more than Letta's memory-block-only sleep-time agents. The disadvantage: iterate currently has no scheduling trigger to fire this script at turn N or at utilization > 90% — that's what items 2+3 unlock.

### What Letta does NOT do that iterate should

1. **Event-sourced replay safety**: Letta's compaction is destructive (rows are deleted or overwritten). The `history-compacted` event approach preserves the full event log — compaction is just a new event in the stream, not a mutation of prior events. This is architecturally superior.

2. **Utilization-triggered proactive compaction**: Letta's `LettaAgentV3` has this commented out. Iterate should ship it — it's the point of items 2+3.

3. **Lane isolation**: Letta has no concept of conversation lanes vs compaction lanes. Everything goes through `step()` serially. Iterate's item 5 design with per-lane generation counters is more sophisticated than anything in Letta.

---

## Appendix: File Map

| File | What |
|---|---|
| `letta/schemas/block.py` | `Block` — core memory block with limit enforcement |
| `letta/schemas/memory.py` | `Memory` — block container + compile() renderer |
| `letta/schemas/passage.py` | `Passage` — archival memory unit with embedding |
| `letta/schemas/llm_config.py` | `LLMConfig` — model + context_window (required) |
| `letta/schemas/agent_file.py` | `AgentSchema` — .af export format |
| `letta/services/context_window_calculator/context_window_calculator.py` | Token-component breakdown, summary detection |
| `letta/services/context_window_calculator/token_counter.py` | Provider-specific counters (Anthropic API / Gemini API / approx bytes/4) |
| `letta/services/summarizer/thresholds.py` | `get_compaction_trigger_threshold()` — 90% of context_window |
| `letta/services/summarizer/summarizer_config.py` | `CompactionSettings` — mode, model, prompt, window% |
| `letta/services/summarizer/compact.py` | `compact_messages()` — cascade, CompactResult, index-1 injection |
| `letta/services/summarizer/self_summarizer.py` | `self_summarize_all()` — agent self-compacts using own LLM |
| `letta/services/summarizer/summarizer.py` | Legacy `Summarizer` — count-based and %-based strategies |
| `letta/agents/letta_agent_v3.py` | Main agent class — reactive-only compaction (proactive commented out) |
| `letta/agents/agent_loop.py` | Factory — routes to `SleeptimeMultiAgentV4` or `LettaAgentV3` |
| `letta/groups/sleeptime_multi_agent_v4.py` | Sleep-time orchestration — foreground-first, asyncio task after |
| `letta/functions/function_sets/base.py` | Tool implementations: core_memory_*, archival_memory_*, conversation_search, rethink_memory |
