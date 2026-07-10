# Claude Code internals — research for iterate agent runtime design

> Status: research snapshot 2026-07-09. Sources: official Anthropic docs, engineering
> blog posts, Claude Code GitHub issues, Agent SDK reference, and published
> source-level analyses of the deobfuscated/extracted Claude Code bundle.
> Confidence ratings reflect source quality: **high** = official docs or verified
> source; **medium** = cross-corroborated third-party analysis; **low** = single
> community source or inference.

---

## TL;DR (headline findings)

1. **One async generator, three callers.** Claude Code's entire agent loop lives in
   `query.ts` (~1,730 lines). REPL, headless CI, SDK callers, and subagents all
   share this path.
2. **tool_use / tool_result are the loop.** Every assistant turn is a content-block
   array; `stop_reason: "tool_use"` re-enters the generator; `"end_turn"` exits.
3. **Compaction is a forked sub-agent.** At ~89% of effective context a fresh
   model call (no tools, 20 K output cap, 9-section prompt) produces a summary
   and a scratchpad. Only the summary re-enters the parent context; a
   `compact_boundary` JSONL marker lets session reconstruction skip backward.
   The Anthropic API now exposes the same mechanism server-side as
   `compact_20260112`.
4. **Steering is queue-first, Esc is hard-interrupt.** New text typed during a turn
   is buffered; Esc synthesises `tool_result` blocks for every orphaned
   `tool_use` id and restarts the turn.
5. **Bash output: 30 K inline → disk spill, 2 K preview.** Read: 2 000 lines by
   default. Both are configurable but have sharp edges.
6. **Token counting is hybrid.** Last known `input_tokens` from the API response +
   character/4 for new unsent messages. Prompt caching for the static prefix
   (system prompt, tool defs, CLAUDE.md).
7. **Subagents get a fresh context window and return only their final message**
   as a `tool_result` block in the parent.
8. **Background Bash notifications arrive between turns** (not mid-turn); parallel
   simultaneous completions have known reliability issues.
9. **Cloud sessions have no server-side persistence.** The caller owns the message
   array. The `compact_20260112` API compaction block is what you serialize back
   to represent summarized history.

---

## 1. Core agent loop

**Source:** Siddhant Khare's structural analysis of the extracted bundle
(https://siddhantkhare.com/writing/the-plumbing-behind-claude-code),
Anthropic engineering blog posts. **Confidence: high.**

The loop is a single async generator function in `query.ts`. It:

1. Assembles a request body from accumulated messages (system prompt + history).
2. Streams the API response, collecting content blocks.
3. On `stop_reason: "tool_use"` — executes all tool calls (potentially in
   parallel), appends results as a `user` message, and re-enters step 1.
4. On `stop_reason: "end_turn"` — yields the final assistant message and
   exits.
5. On `stop_reason: "pause_turn"` — re-sends the **same** messages unchanged
   (server-managed pause, used by extended thinking).
6. On `stop_reason: "max_tokens"` — retries with a larger budget.

Special `querySource` values route the same generator for compaction
(`querySource='compact'`), subagents (`querySource='subagent'`), and SDK
callers. The REPL, `--print` (headless), `claude -p`, and SDK all converge
here.

---

## 2. Tool calls, permissions, and hooks

**Sources:** Official docs (code.claude.com/docs), GitHub issues, hook reference
docs. **Confidence: high.**

### Protocol

The model emits a `tool_use` content block per call:
```
{ type: "tool_use", id: "toolu_xxx", name: "Bash", input: { command: "ls" } }
```
The harness runs the tool, then appends a `user` message containing one
`tool_result` block per call:
```
{ type: "tool_result", tool_use_id: "toolu_xxx", content: "..." }
```

### Parallel execution

`StreamingToolExecutor` executes **concurrency-safe** tools immediately during
streaming — before the full response has arrived. Tools marked as requiring
serialization wait. The model may emit multiple `tool_use` blocks in a single
response; all execute before the next API call.

### Built-in tools

Read, Write, Edit, MultiEdit, Glob, Grep, Bash, WebFetch, WebSearch, Workflow,
NotebookEdit, Monitor, PowerShell, Skill, Agent (formerly Task), LSP,
ListMcpResourcesTool, ReadMcpResourceTool.

### Permission tiers

`default_mode` (deny sensitive ops), `acceptEdits`, `bypassPermissions`
(headless/CI). MCP tools inherit the same permission layer.

### Hooks (user-configurable, external processes)

| Hook | Fires |
|---|---|
| `PreToolUse` | before each tool call; can block it |
| `PostToolUse` | after each tool result; sees **already-truncated** output |
| `UserPromptSubmit` | when user sends a message |
| `Stop` | before the session exits |
| `SubagentStart` / `SubagentStop` | around each sub-agent invocation |
| `PreCompact` | before compaction fires; can inject custom instructions |

Hooks run as external processes; stdout is returned to the harness; non-zero
exit blocks the tool (PreToolUse) or logs a warning (others).

---

## 3. Tool output truncation

**Sources:** GitHub issue #19901 (BASH_MAX_OUTPUT_LENGTH docs gap), issue #17944
(30K disk-spill threshold empirically measured), `toolLimits.ts` analysis
(siddhantkhare.com). **Confidence: high.**

### Bash

| Threshold | Behaviour |
|---|---|
| ≤ 30,000 chars | inline in context |
| > 30,000 chars | persisted to disk; model sees a 2,000-char preview + file path |

`BASH_MAX_OUTPUT_LENGTH` env var is documented but as of v2.1.2+ the 30 K
disk-spill threshold is **hard-coded** and ignores it for triggering spill
(the env var only controls the inline-return budget). Middle-truncation
(head + tail) applies within inline returns.

`PostToolUse` hooks receive the already-truncated version; hooking before
truncation requires redirecting output inside the command itself.

### Read

Default: first 2,000 lines, no warning on truncation. `offset` and `limit`
parameters allow windowed access. Lines > 2,000 characters are themselves
truncated to 2,000 chars. Read intentionally sets its persistence threshold to
`Infinity` (circular to spill Read output to disk for Read to re-read).

### Per-tool and per-message caps (from `toolLimits.ts`)

```
DEFAULT_MAX_RESULT_SIZE_CHARS   =  50,000   (per tool call)
MAX_TOOL_RESULT_TOKENS          = 100,000   (~400 KB)
MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000 (per turn aggregate)
```

The aggregate cap prevents N parallel grep calls each at 40 K from dumping
400 K into one turn.

---

## 4. Compaction

**Sources:** Anthropic engineering blog "Effective context engineering" (2025-09-29),
"Context engineering: memory, compaction, and tool clearing" cookbook
(2026-03-20), Siddhant Khare bundle analysis, extracted constant values.
**Confidence: high.**

### 5-tier system (Claude Code client-side)

| Tier | Trigger | Action |
|---|---|---|
| Microcompact | individual tool result > threshold | truncate that result inline |
| Snip | rolling window overflow | drop oldest messages |
| Context Collapse | approaching limit | drop non-essential blocks |
| Auto LLM-based | `effectiveWindow − 13,000` tokens | fork compaction sub-agent |
| Reactive | post-turn check if still over limit | forced compact before next turn |

### Auto-compact threshold (extracted constants)

```
AUTOCOMPACT_BUFFER_TOKENS    = 13,000
WARNING_THRESHOLD_BUFFER     = 20,000
MANUAL_COMPACT_BUFFER        = 3,000
MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20,000
```

`effectiveContextWindow = contextWindow − min(maxOutputTokens, 20,000)`

For a 200 K model with 8,192 max output:
`effectiveWindow = 200,000 − 8,192 = 191,808`
`autocompact trigger = 191,808 − 13,000 = 178,808 tokens ≈ 89.4%`

(Older builds used a 45 K buffer, giving ~77.5%; as of early 2026 the buffer
shrank to ~33 K in some measurements, giving ~83.5%.)

### Compaction sub-agent

- `querySource = 'compact'`; `maxTurns = 1`; no tools; `max_tokens = 20,000`
- **9-section structured prompt**: task context, environment info, git state,
  conversation history, unreplied messages, recent tool uses, next steps,
  unresolved questions, important constraints
- Output: a `<scratchpad>` block + a `<summary>` block
- **Scratchpad is stripped** before injection; only the summary enters the new
  context
- A `compact_boundary` JSONL marker is written; session reconstruction reads
  forward from the most recent boundary

### Anthropic first-party API compaction (`compact_20260112`)

Released early 2026. Configured via `context_management.edits`:
```json
{
  "type": "compact_20260112",
  "trigger": { "type": "input_tokens", "value": 180000 },
  "instructions": "...",
  "pause_after_compaction": false
}
```
- Beta header: `compact-2026-01-12`
- Minimum trigger: 50,000 tokens
- Returns a typed `compaction` content block; serialize it back as
  `{"type": "compaction", "content": block.content}` and the API drops
  everything before it on the next request

### Tool result clearing (complementary)

`clear_tool_uses_20250919` (beta header `context-management-2025-06-27`):
surgically replaces old `tool_result` blocks with a placeholder, leaving
`tool_use` records intact. Trigger defaults to 100 K tokens; keeps last 3
tool uses. Lighter-weight than full compaction; does not handle user/assistant
reasoning text.

---

## 5. Steering and interruption

**Sources:** GitHub issues on claude-code repo (feature requests for mid-turn
injection, interrupt semantics discussions). **Confidence: medium-high.**

### Normal input (queued)

Text typed during an active turn is **buffered** and delivered at the next
`yield` point — the next time the generator surfaces between API calls. It
does not interrupt the current API streaming call.

### Esc (hard interrupt)

Esc issues a hard interrupt:
1. The current streaming API call is cancelled.
2. For every `tool_use` block in the partially-received assistant message, a
   synthetic `tool_result` is generated (content: interruption notice) so the
   `tool_use` / `tool_result` pairing invariant is preserved.
3. The partial assistant message + synthetic results are appended to history.
4. A new turn starts with the user's interrupt message.
5. Prior work (files written, edits made before interruption) is **preserved**.

This means Esc is safe mid-tool-sequence; the model sees the partial work
history and can reason about what was completed.

### Mid-turn injection (not implemented as of research date)

Feature requests for Codex-style mid-turn steering (inserting a message while
a tool is executing, not waiting for the next yield) are open in the GitHub
issue tracker but not implemented. The current model: wait for the tool
to complete, then the queued input surfaces.

---

## 6. Subagents

**Sources:** Official Claude Code docs (code.claude.com/docs/en/features/sub-agents),
SDK reference, GitHub changelogs. **Confidence: high.**

### Invocation

The `Agent` tool (formerly `Task`, renamed v2.1.63):
```
{ type: "tool_use", name: "Agent", input: { description: "...", prompt: "..." } }
```

### Isolation

- **Fresh context window** — no shared history with parent
- Inherits tool permissions and MCP servers from the parent
- Only the **final message** of the subagent's conversation is returned as the
  `tool_result` to the parent
- Intermediate tool calls, file edits, etc. are visible only in the subagent's
  own display; they do not flow into the parent's context
- Maximum nesting depth: **5 levels**

### Background execution (v2.1.198+)

Subagents run in the background by default. The parent continues its own turn
while the subagent executes. The parent receives the result as a `tool_result`
block when the subagent completes, at the next turn boundary.

### Concurrency

Multiple `Agent` tool calls in one response run in parallel (same as other
parallel tool execution). Each gets its own context window and process.

---

## 7. Background processes (Bash `run_in_background: true`)

**Sources:** Official docs, GitHub issues, community reports. **Confidence: medium.**

When the model calls Bash with `run_in_background: true`:
- The harness starts the process but does not wait for it
- The `tool_result` returns immediately with a process handle / PID
- When the process completes, the harness queues a **system notification**
- The notification is delivered **between turns** (not mid-streaming)
- Multiple simultaneous completions have known reliability issues — only the
  last notification may be reliably delivered if several background processes
  finish at the same moment

The `Monitor` tool (a sibling built-in) streams stdout lines as notifications
from a running background process; each line fires a separate notification
event. This enables a poll-free "wait until done" pattern.

---

## 8. Streaming event schema (Agent SDK)

**Sources:** Official Anthropic Agent SDK TypeScript reference
(github.com/anthropics/anthropic-sdk-python, TypeScript SDK). **Confidence: high.**

The SDK exposes a typed `SDKMessage` union over the raw SSE stream. Key event
types (SSE → SDK mapping):

| SSE event | SDK type | Description |
|---|---|---|
| `message_start` | `MessageStartEvent` | message id, initial usage |
| `content_block_start` | `ContentBlockStartEvent` | new block (text / tool_use / thinking) |
| `content_block_delta` | `ContentBlockDeltaEvent` | incremental text/JSON delta |
| `content_block_stop` | `ContentBlockStopEvent` | block complete |
| `message_delta` | `MessageDeltaEvent` | stop_reason, stop_sequence, usage update |
| `message_stop` | `MessageStopEvent` | stream closed |
| `ping` | `PingEvent` | keepalive |

Delta types within `content_block_delta`:
- `TextDelta` (`{ type: "text_delta", text: string }`)
- `InputJSONDelta` (`{ type: "input_json_delta", partial_json: string }`)
- `ThinkingDelta` (`{ type: "thinking_delta", thinking: string }`)
- `SignatureDelta` (`{ type: "signature_delta", signature: string }`)

The SDK also emits higher-level stream helper events:
`text`, `inputJson`, `message`, `finalMessage`, `error`, `abort`, `connect`,
`end`, `streamEvent` (passthrough), plus tool-execution events when using
`tool_runner`: `toolStart`, `toolDelta`, `toolEnd`, `toolError`.

`stop_reason` values that matter for loop control:
- `"tool_use"` — continue (tool results pending)
- `"end_turn"` — natural completion
- `"pause_turn"` — re-send unchanged (extended thinking server pause)
- `"max_tokens"` — budget hit; retry with larger `max_tokens`
- `"stop_sequence"` — custom stop sequence matched

---

## 9. Context management and token counting

**Sources:** Siddhant Khare bundle analysis (`context.ts`), official prompt caching
docs, effective context engineering blog post. **Confidence: high.**

### Window sizes (`context.ts`)

Default: 200 K tokens. Sonnet 4.6 and Opus 4.6: 1 M tokens. `max_tokens`
default is 8,192, capped to 6,144 on retry (to avoid over-reserving output
slot capacity on a model whose actual max output is ~4,096).

### Token counting (hybrid)

1. **Known tokens:** last `input_tokens` count from the API response header
2. **New messages:** estimated as `characters / 4` until the next API call
   confirms the real count
3. This means utilization estimates between turns are approximate; the gap
   can be material for long tool results added between calls

### Prompt caching

The static prefix (system prompt, tool definitions, CLAUDE.md contents) is
auto-cached. Cache lifetime: 5 minutes (ephemeral). Extended cache (longer
TTL) available with explicit `ttl` in `cache_control`.

Interaction with compaction: **tool result clearing** invalidates cached
prefixes at the clearing point (cache write cost incurred). **Thinking block
clearing** preserves the cache if `keep: "all"` is set (Sonnet 4.6+ keeps
all thinking blocks by default).

### "Just-in-time" context loading

Claude Code does not dump entire codebases into context at start. CLAUDE.md
files are pre-loaded; everything else is discovered via Glob/Grep/Read as
needed. The model maintains lightweight references (file paths, grep patterns)
and loads content on demand — the effective working set stays small.

---

## 10. Cloud / hosted session persistence

**Sources:** Official context engineering docs, cookbook, API reference.
**Confidence: high.**

**There is no server-side session store.** The caller owns the full message
array. Between requests, the caller serializes and re-sends the entire
conversation.

### What persists client-side

The caller maintains the `messages[]` array. After compaction:
- The `compaction` content block returned by the API is serialized back as
  `{"type": "compaction", "content": block.content}` in the next request
- The API drops everything before the most recent `compaction` block
- The client can discard pre-compaction messages after serialization

### Cross-session memory

Claude Code implements two complementary systems:
1. **CLAUDE.md files** — statically pre-loaded at session start; the model
   edits them to persist project context
2. **Memory tool** (`memory_20250818`) — model-driven file-based notes under
   `/memories`; pulled back into context at session start via tool calls

Neither is server-managed; both are file-system artifacts the client reads
at session init.

### `compact_boundary` (Claude Code CLI sessions)

Within a CLI session, a `compact_boundary` marker is appended to the JSONL
session log after each compaction. `--resume` reconstructs the session by
reading forward from the most recent boundary, skipping pre-compaction history.

---

## Implications for iterate

This section maps Claude Code mechanisms onto our event-sourced agent processor
and the items in `apps/os/src/domains/agents/design-improvements.md`.

### A. Compaction → design-improvements items 2, 3, 4, 6, 11

**What Claude Code does:** Forks a dedicated sub-agent call (no tools, 20 K
output, 9-section structured prompt) when usage hits `effectiveWindow − 13 K`.
The summary replaces all pre-boundary history. A `compact_boundary` marker
enables cheap session reconstruction without replaying full history.

**How this maps to iterate:**

- **Item 4 (compaction event):** The proposed `agent/history-compacted {
  floorOffset, summary }` event is the right primitive. It's exactly the
  `compact_boundary` equivalent: events before `floorOffset` remain on the
  stream for audit, but `buildAgentLlmRequestBody` stops replaying them and
  uses the `summary` instead. This is race-free by construction because event
  offsets are totally ordered.
- **Item 11 (O(history) replay):** Claude Code avoids this by using the boundary
  marker — only events from the boundary forward are replayed. Our equivalent:
  once `history-compacted` is appended, `buildAgentLlmRequestBody` only needs
  to fold events after `floorOffset`. This naturally bounds replay cost.
- **Items 2 + 3 (typed usage, context window mapping):** Claude Code's
  auto-compact trigger requires knowing `effectiveContextWindow` and current
  `input_tokens`. We need the same: providers must normalize usage to
  `{ inputTokens, outputTokens }` (item 2) and report `contextWindow` (item 3)
  before a utilization-triggered compact can fire.
- **Item 6 (openai-ws previousResponseId):** Claude Code's compaction resets
  continuation — the next request sends full compacted history. We must do the
  same: `history-compacted` must clear `#previousResponseId` in the openai-ws
  provider so it resends the full (now-compacted) history on the next turn.

**What to steal:** The 9-section compaction prompt structure, the threshold
formula (`effectiveWindow − 13 K`), and the boundary-marker approach for
cheap replay. The Anthropic first-party `compact_20260112` API endpoint is
directly usable if we call Claude models — configure trigger, instructions, and
serialize the returned `compaction` block back into the next request.

### B. Streaming event schema → design-improvement item 1

**What Claude Code does:** Internally normalizes SSE deltas into typed SDK
events (`TextDelta`, `InputJSONDelta`, `ThinkingDelta`, tool events). The
raw wire frames are not what the consumer sees.

**How this maps to iterate:** This is exactly item 1: providers emit raw
`openai-ws/llm-response-chunk` / `cloudflare-ai/llm-response-chunk` blobs
today; the UI parses both dialects. The Claude Code pattern — translate at
the emitter into a normalized `agent/output-delta { channel: "text" |
"thinking", delta }` — puts the dialect knowledge where it belongs (in the
provider processor) and gives the UI a single event type to fold. The `channel`
enum (not new event types) absorbs growth.

The `ThinkingDelta` type confirms that thinking/reasoning content is a peer
of text, not a separate concern — matching the proposed `channel: "thinking"`
arm of our abstraction.

### C. Tool result handling → design-improvement item 10

**What Claude Code does:** Large tool outputs are spilled to disk (>30 K chars);
the model gets a 2 K preview and can Read the file if needed. Per-message
aggregate cap (200 K chars) prevents parallel-tool explosion.

**How this maps to iterate:** Our codemode already spills oversized script
results to workspace files (PR #1793: `SCRIPT_RESULT_HISTORY_LIMIT = 30,000`).
This is the right instinct. Item 10 (chunk write amplification) is a separate
concern: the raw frame journal for UI deltas should be best-effort / coalesced,
not one awaited `stream.append` per frame.

### D. Steering / interruption → design-improvements items 9

**What Claude Code does:** Esc synthesises `tool_result` blocks for every
orphaned `tool_use` id so the pairing invariant holds, then starts a new turn.
The current streaming call is cancelled at the HTTP level.

**How this maps to iterate:** Item 9 (cancellation never aborts provider
execution) is the gap. Our `llm-request-cancelled` event updates fold state
but the provider keeps streaming. The Claude Code pattern — actually cancelling
the HTTP request and synthesising tool results for orphaned calls — is the
correct approach. For our providers: abort the fetch / drop the WebSocket
response; any tool calls already emitted in the partial response should get
synthetic completions so history remains self-consistent.

### E. Subagents → future agent-of-agents work

**What Claude Code does:** Each subagent gets a fresh context window; only the
final message returns as a `tool_result`. This is a hard isolation boundary
that keeps parent context from exploding with subagent history.

**How this maps to iterate:** Our PR agent and per-thread agents already follow
this pattern implicitly (separate stream per agent path). The key insight for
future work: if we support agent-calls-agent, the child agent's stream should
not be folded into the parent's prompt. Only the final output crosses the
boundary, as a script result or itx tool return value.

### F. Parallel request slots → design-improvement item 5

**What Claude Code does:** The loop executes tools in parallel (StreamingToolExecutor)
but does not run multiple LLM API calls concurrently. Compaction is a sequential
blocking operation.

**How this maps to iterate:** Item 5 (single `currentRequest` slot) is not
blocking compaction adoption in the short term — Claude Code itself ships
compaction with a single request slot. The design-improvements doc's sequencing
recommendation is correct: ship compaction on the existing single-slot model
first, then split lanes (item 5) as a latency optimization.

### G. Token counting accuracy → design-improvements items 2, 3

**What Claude Code does:** Uses actual `input_tokens` from the API response plus
character/4 heuristic for new unsent content. Utilization is approximate between
turns.

**How this maps to iterate:** This heuristic is fine for a soft trigger
(compact at 89% utilization). We don't need exact counts before the API call.
What matters is that `input_tokens` from `llm-request-completed` is folded into
state (item 2) and that we map model string → `contextWindow` (item 3) to
compute the percentage.

### H. Cross-session persistence

**What Claude Code does:** No server-side session store. CLAUDE.md + memory tool
files are the persistence layer; the compaction block is the session resume
primitive.

**How this maps to iterate:** Our stream IS the session store. Every event is
durable at append time. The `history-compacted` event is our analog of the
`compact_boundary` marker — reading the stream from `floorOffset` forward
reconstructs the post-compaction context. No additional persistence layer
needed; this is an architectural advantage over Claude Code's file-based approach.
