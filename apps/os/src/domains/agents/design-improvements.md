# Agent / LLM-provider processor design improvements

Running list from the compaction design discussion (started 2026-07-09).
Scope: the `agent` processor, the `cloudflare-ai` / `openai-ws` provider
processors, and the browser agent-ui reducer that folds their events.
Add items as we find them; strike items when a PR lands.

## 1. Normalized streaming-delta abstraction (chunks, reasoning, etc.)

Providers journal every raw wire frame verbatim (`openai-ws/llm-response-chunk`,
`cloudflare-ai/llm-response-chunk`, payload `chunk: z.unknown()`), and the ONLY
consumer is the browser agent-ui reducer, which hardcodes both provider event
types and parses both wire dialects itself (OpenAI Responses frame types at
`packages/ui/src/components/events/agent-ui-reducer.ts:307`, chat-completions
`choices[0].delta` shape at `:660`). The normalization boundary lives in the
browser, duplicated per provider; a third provider means teaching the UI a
third dialect.

Direction: the agent namespace is where normalized things live (`output-added`
is the provider-agnostic authoritative response; `output-delta` would be its
streaming sibling). Providers translate their dialect at the emitter into
something like `agent/output-delta { llmRequestId, channel: "text" | "thinking",
delta }`; the UI folds one event type; the raw chunk journal stays for
debugging. Consuming deltas never needs to touch the agent processor's fold.
Consider the same umbrella for other streamed signals (tool-call deltas,
usage-so-far) so the channel enum, not new event types, absorbs growth.

## 2. Usage is untyped and never folded

Both providers extract `usage` from the response and put it on
`agent/llm-request-completed`, but as `z.unknown()` — an agent-namespaced event
carrying a raw provider-shaped blob (the worst of both patterns). Nothing folds
it; nothing can act on it.

Direction: providers normalize usage to a typed shape (`{ inputTokens,
outputTokens, totalTokens, ... }`) before appending; the agent reducer folds it
(e.g. `lastKnownUsage`). Prerequisite for any utilization-triggered compaction.

## 3. Context-window limits exist nowhere

The model is a bare string in agent state (`llmConfig.model`); no processor
knows any model's context window, so "X% utilization" is currently
uncomputable. Direction: the provider owns the `model → contextWindow` mapping
(it owns the model dialect already) and reports it to the agent — e.g. stamped
on `llm-request-started` or `-completed` — so the agent folds
`utilization = usage.totalTokens / contextWindow` against a config threshold.

## 4. Compaction (the goal)

Agent processor owns it. The event-sourced prompt rebuild is naturally friendly:
providers rebuild prompts by replaying events `offset <= llmRequestId`, so a
compaction is just another event the reducer honors — e.g.
`agent/history-compacted { floorOffset, summary }` that replaces history up to
`floorOffset` and keeps the tail. Requests before the compaction event rebuild
the old prompt; requests after get the compacted one — race-free by
construction.

Sequencing lean: ship items 2 + 3 + the `history-compacted` fold first, run
compaction BLOCKING on the existing single-slot machinery (users can already
type during an in-flight request; inputs queue via `pendingTriggerOffset`),
then split request lanes (item 5) as a latency optimization.

## 5. Single `currentRequest` slot blocks parallel LLM requests

Non-blocking compaction needs a conversation request and a compaction request
in flight together. The single-request invariant lives almost entirely in the
agent processor: nullable `currentRequest` slot, settle gate ("trigger pending
AND no request current"), global `requestGeneration` idempotency counter,
interrupt/cancel/failure paths all addressing "the" request
(`agent-processor-implementation.ts:205`). The provider folds are already
multi-request-shaped (openai-ws keeps a map keyed by llmRequestId; its orphan
sweep handles entries independently; cloudflare-ai has no serialization at
all). Direction: lanes (e.g. `{ conversation, compaction }`) with per-lane
generation counters; `interrupt-current-request` must target the conversation
lane only. At hard context exhaustion the conversation lane gates on the
compaction lane — non-blocking degrades to blocking only at the ceiling.

## 6. openai-ws `previous_response_id` continuation vs compaction

The provider keeps `#previousResponseId` and, when continuing, sends only
messages since the last assistant turn — so the effective context lives
server-side at OpenAI as the UNCOMPACTED chain. Compacting local history does
nothing to real utilization until the chain is broken. A compaction landing
must reset `#previousResponseId` (next request resends full compacted
history); a parallel compaction request must never ride or update the
continuation chain.

## 7. openai-ws `#executionChain` serializes all executions per instance

Exists only because two concurrent requests would steal each other's frames
off the one shared WebSocket iterator — a per-socket constraint, not
architectural. A compaction lane should bypass it: second socket, or plain
HTTPS Responses call (compaction needs neither streaming nor continuation).

## 8. cloudflare-ai lacks the orphan-recovery sweep

openai-ws gained "requested" fold-status + a post-batch sweep that fails
requests no live execution owns (the t42 wedge fix). cloudflare-ai never got
the sibling fix: eviction mid-execution wedges `currentRequest` forever. Any
new lane/request kind must inherit the sweep pattern.

## 9. Cancellation never aborts the provider execution

`llm-request-cancelled` updates the agent fold, but the provider execution
keeps running to completion — burning the socket, and (openai-ws) making the
next request queue behind the doomed one on `#executionChain`. With a
compaction lane this also means a cancelled conversation turn delays a
compaction queued behind it. Direction: propagate cancellation into the
execution (abort the response / drop the socket).

## 10. Chunk write amplification

Every wire frame is one awaited `stream.append` inside the socket-read loop —
hundreds of durable events per long response, consumed only by the browser UI,
and each append back-pressures the frame consumer. Direction: coalesce deltas
(flush on size/time), and/or make the raw-frame journal best-effort while the
normalized `output-delta` lane (item 1) carries the UI.

## 11. Every request re-reads and re-folds the whole stream — twice

`buildAgentLlmRequestBody` re-reads ALL stream events (paged 500) and re-folds
them; `#isRequestStillCurrent` does it AGAIN after the response. O(history)
per turn, growing forever. Compaction bounds the prompt but not the replay —
the events remain on the stream. Direction candidates: checkpointed agent
state for prompt building, reading from the processor's own reduced state
instead of a fresh fold, and a cheaper currency check (read just the tail
after the request's offset).
