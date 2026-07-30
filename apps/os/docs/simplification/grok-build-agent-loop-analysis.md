# Grok Build's agent loop: architecture and lessons for `apps/os`

- Research date: 2026-07-15
- Upstream repository: [`xai-org/grok-build`](https://github.com/xai-org/grok-build)
- Upstream revision: [`c1b5909ec707c069f1d21a93917af044e71da0d7`](https://github.com/xai-org/grok-build/tree/c1b5909ec707c069f1d21a93917af044e71da0d7)
- Local source checkout: `~/src/github.com/xai-org/grok-build`

## Executive summary

Grok Build does not have one agent loop in the architectural sense. It has an
in-memory actor graph around a mutable foreground turn coroutine:

- a session actor owns commands, prompt queues, and session liveness;
- a chat-state actor owns canonical model context;
- a sampler actor owns provider requests, retries, streaming, and cancellation;
- a tool pipeline preflights calls and executes approved work concurrently;
- a subagent coordinator creates independent child sessions;
- persistence writes both an append-only UI/session log and a replaceable current
  model-history projection; and
- the UI derives rich activity from lifecycle and streaming events.

The completed conversation is durable. The live computation is not. A process
restart reloads canonical context and repairs dangling calls, but it does not
resume the suspended Rust future, provider stream, tool call, or child agent.
Stale subagents are marked cancelled.

The same behavior is implementable as an Iterate stream processor, with better
crash semantics than Grok, if the loop is represented as durable phases and
obligations rather than as one long `while` loop. The old Pi stream-processor
port already proved the mechanical translation. The remaining work is mostly
to make interruption, compaction, child work, status, and recovery policies
first-class.

The most immediate problem in the current OS implementation is compaction: it
runs the summarizing LLM request under `blockProcessorWhile`, so the processor
cannot ingest a cancellation or steering event while compaction is in progress.
Compaction should be a requested/started/completed obligation driven by
`runInBackground` and recovered by `reconcile`.

The locally fetched `origin/main` already contains two important advances that
should be retained:

- the provider-neutral, publication-aware agent context projection from #2032;
- the busy/idle and `llm | script` live status work from #1966 and #2029.

The highest-value remaining additions are richer input intent, durable child-run
correlation, non-blocking compaction, and a shared activity reducer.

## Scope and baselines

This report compares four concrete implementations:

1. Grok Build at upstream commit `c1b5909e`.
2. The agent processor in this `archive/simplification-2026-07-15`
   worktree at `4c26ed2b`.
3. The locally fetched Iterate `origin/main` at `436610e5`, including the
   unified-context and improved-status changes.
4. Iterate commit `5e3d3d57`, “pi coding-agent loop as a single stream
   processor pair.”

The worktree and `origin/main` distinction matters: several agent-context and
status improvements landed after this archived branch diverged. Conclusions
below call that out instead of treating the archived implementation as the
latest design.

This is source analysis, not a behavioral benchmark. The underlying Grok and
Iterate implementations were not modified; this report is the only new file.

## 1. Grok Build's runtime architecture

The control flow is approximately:

```text
ACP/UI commands
      │
      ▼
Session actor + prompt queue ─────────────── user-facing events
      │
      ├── spawns one foreground turn task
      │          │
      │          ▼
      │    mutable agent loop
      │      ├── build context
      │      ├── sample model
      │      ├── commit canonical assistant response
      │      ├── preflight and execute tools
      │      └── loop or finish
      │
      ├── ChatState actor ───── canonical model conversation
      ├── Sampler actor ─────── retries, cancellation, streaming
      ├── Subagent coordinator
      └── Persistence actor ─── updates.jsonl + chat_history.jsonl
```

### 1.1 Session actor and foreground turn

The session actor is the authoritative in-process coordinator. Its run loop
uses `tokio::select!` to receive commands, chat-state events, model switches,
turn completions, and other session events while a foreground turn is running.
It owns the prompt queue, current prompt metadata, pending interactions, and
interjection buffer.

Source: [session run loop](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/session/acp_session_impl/run_loop.rs#L153-L220).

When work is available, the actor spawns a foreground prompt task. When that
task completes, it flushes buffered replay events, settles the turn, drains
monitors and stranded interjections, starts the next queued prompt, and emits
the new idle/working state.

The foreground task contains the familiar mutable loop. Each iteration:

1. drains interjections and updates skills/monitors;
2. considers speculative and required compaction;
3. builds the tool set and model request;
4. samples and streams the response;
5. commits the complete canonical assistant response;
6. finishes if there are no tool calls and no other continuation requirement;
7. otherwise executes the tool batch, adds results to context, and repeats.

Source: [conversation-turn loop](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs#L1693-L2304).

This split gives Grok mailbox responsiveness without forcing all session logic
into one task. It is still an in-memory split: the spawned task's continuation
is not a durable continuation.

### 1.2 Sampler actor and retry layers

The sampler is a separate actor. It serializes sampler commands, but individual
provider requests run in spawned tasks. Request IDs provide targeted
cancellation; submitting the same ID cancels the older request. A
cancel-on-drop guard also prevents an abandoned caller from leaving an
unobserved request alive.

Source: [sampler actor](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-sampler/src/actor/mod.rs#L58-L143) and [sampler handle](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-sampler/src/handle.rs#L106-L155).

Grok keeps retry scopes separate:

- transport, empty-response, and malformed-stream retries belong to one
  sampler request;
- repeated unusable output has a separate resampling budget;
- a turn can remind the model and retry if a required action was omitted;
- a provider context-limit error invokes compaction and then retries the turn;
- authentication and managed-MCP recovery have their own paths.

That separation is worth preserving. A transport retry is not a new semantic
agent turn, and it should not consume the same budget or produce the same
durable events as a new request generation.

The sampler enforces a long per-chunk idle timeout and emits retry state while
streaming. A drain barrier ensures all response deltas reach the UI before
later tool lifecycle events. Only a successfully collected response is added
to canonical chat state.

### 1.3 Canonical context versus streamed presentation

`xai-chat-state` owns a typed conversation containing system, user, assistant,
tool-result, backend-tool-call, and reasoning items. Integrity repair happens
before request construction: duplicate tool results are removed and dangling
tool calls receive cancellation results.

The request builder then applies context shaping:

- old, large tool results are pruned only after context utilization exceeds
  50%;
- inline images are evicted only when the serialized request approaches the
  50 MB proxy limit;
- image eviction uses high-water/low-water hysteresis, reclaiming a large batch
  of headroom so the prefix is not rewritten again on the next turn;
- memory reminders can be inserted into the system context; and
- most shaping operates on the request copy rather than casually rewriting
  stored history.

Source: [conversation request builder](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-chat-state/src/actor/request_builder.rs#L17-L137).

Streaming text, reasoning, and tool-argument deltas are presentation events,
not model history. Grok commits the assistant response only after the sampler
returns a complete response. Partials from cancelled or failed attempts remain
trace/UI evidence and are not later presented as if the assistant had said
them canonically.

This provides a clean invariant:

> Model context contains only committed semantic turns; the UI may display a
> richer, transient execution trace.

### 1.4 Tool-call lifecycle

After committing an assistant response containing tool calls, Grok uses a
two-stage tool pipeline.

First, calls are preflighted serially:

- emit pending/tool-started presentation state;
- ensure MCP readiness;
- parse arguments;
- run hooks;
- request permission;
- prepare authentication recovery and deferred follow-ups.

Second, approved tools run concurrently through `FuturesUnordered`. File writes
to the same path share a mutex, while independent calls complete in whichever
order they finish. Each completion becomes a paired canonical tool result.

Source: [tool execution pipeline](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs#L284-L734).

Certain waiting tools race their underlying wait against the pending-
interjection signal. This lets a user steer an agent that is waiting for a
task, subagent, or command without waiting for the nominal timeout.

The useful general rule is:

> Commit what the model requested before performing it; preflight authority
> before dispatch; run independent effects concurrently; and produce exactly
> one terminal result for every requested call.

OS's code-mode and capability-host design can keep using scripts as a
higher-level tool batch. The same lifecycle still applies underneath the
script boundary.

## 2. Interruptions and prompt intent

Grok distinguishes several user intents that OS currently collapses.

### 2.1 Queue

A normal prompt joins a server-authoritative FIFO and waits behind the current
turn. Interactive cancellation normally preserves queued prompts.

### 2.2 Interject or steer

An interjection adds new user context at the next safe point without
automatically cancelling the current model sample. A queued prompt can be
atomically removed from the FIFO and converted into an interjection.

Interjections are drained:

- at the top of an agent-loop iteration;
- before the model is allowed to finish the turn;
- after a tool batch; and
- immediately by selected interruptible waiting tools.

They are persisted as standalone synthetic user context, not smuggled into a
tool result.

Source: [interjection handling](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/session/acp_session_impl/interjection.rs#L277-L333).

### 2.3 Send now

`send_now` cancels the foreground turn and puts the new prompt at the front of
the queue. It deliberately preserves background commands, queued prompts, and
subagents. It is treated as a silent continuation rather than as a user asking
to tear down every associated activity.

### 2.4 Cancel

Explicit cancellation can abort the foreground task and optionally cancel
background tasks or child agents. Grok records a mid-turn abort cue when
appropriate, repairs dangling tool calls, and discards incomplete streamed
assistant text.

Source: [cancellation paths](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/session/acp_session_impl/tasks_cancel.rs#L204-L491).

### 2.5 OS implication

OS currently exposes `dont-trigger-request`, `after-current-request`, and
`interrupt-current-request`. A fuller intent model should distinguish:

```ts
type AgentInputIntent =
  | "record-only"
  | "queue-after-current"
  | "steer-at-safe-point"
  | "cancel-and-run-now"
  | "cancel-only";
```

The current processor also reconstructs an interrupted partial response from
an incarnation-local buffer and inserts it as model-visible input. That buffer
is lost on eviction, so the model's next context depends on whether the same
incarnation survived. Grok's stricter canonical boundary is more reproducible.
If continuity is important, OS should journal a deliberately typed
`interrupted-assistant-draft` rather than ordinary input.

Current source: [OS interrupt handling](../../src/domains/agents/agent-processor-implementation.ts#L663-L714).

## 3. Subagents

### 3.1 Separate sessions, not nested prompts

A Grok subagent is a separate child session with its own chat state, sampler,
persistence, session actor, usage, and lifecycle. It shares selected execution
infrastructure and workspace facilities with the parent, and can optionally
use isolated worktree machinery, but it does not share the parent's mutable
conversation object.

The coordinator tracks child handle, parent prompt, CWD/worktree information,
model, cancellation, foreground/background state, and completion metadata.

### 3.2 Context modes

Children support three initial-context policies:

- **new**: start from the child definition and task;
- **forked**: derive context from the live parent;
- **resumed**: reopen a prior child session's persisted context.

A live fork takes a cache-preserving fast path only when the parent context is
below 80% of the child window and ends on a clean assistant boundary. The child
then receives parent items byte-for-byte, including synthetic reminders, and
the exact parent tool schema. Otherwise Grok filters and summarizes the fork.

Source: [verbatim-or-normalized fork](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/agent/subagent/mod.rs#L1113-L1203) and [child construction/tool override](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/agent/subagent/handle_request.rs#L1028-L1188).

An explicit resume fails closed if its source cannot be reconstructed or is too
large. A fork is more permissive: it can fall back from live parent context to
disk context, summarized context, or a new child.

### 3.3 Foreground, background, and progress

A foreground spawn waits for a bounded period. If the parent turn disappears
or the waiting budget expires, the child is detached into the background
instead of being killed.

Spawn and finish are persisted. Progress is transient: changed progress is
emitted on a short interval, with a slower heartbeat. Reconnecting clients use
`list_running` to reconstruct currently live children instead of replaying
every progress tick.

### 3.4 Restart behavior

Child execution is not resumed after process restart. Stale running metadata is
converted to one cancelled `SubagentFinished` result with the reason
“interrupted by process restart.” A completed or cancelled child can later be
explicitly resumed from persisted artifacts.

Source: [orphan subagent reconciliation](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/agent/subagent/mod.rs#L2659-L2805).

### 3.5 OS implication

OS already has a stronger durable substrate: every agent path has an
independent stream and processor. Current agent-to-agent messaging, however,
is not yet a child-work protocol:

- lineage and `spawnId` are not first-class;
- the child does not inherit a selected parent context snapshot;
- foreground/background is not durable parent state;
- `ask()` matches the next response by order rather than correlation; and
- the parent has no typed terminal child result to reconcile.

A Grok-equivalent design should create a child stream under a stable path such
as `/agents/<parent>/children/<spawnId>`, record the requested context policy,
and require the child to append a correlated terminal event back to the parent.

There is also a cache-affinity consequence. Current OpenAI BYOK routing uses a
per-agent `prompt_cache_key`. A forked child with byte-identical parent context
but a new child path loses the parent's explicit routing affinity. A child fork
should be able to inherit a context-lineage/cache-affinity key until its first
compaction, while still retaining its own durable agent identity.

## 4. Compaction

Grok compacts for four reasons:

- proactive context pressure before a request;
- one oversized tool result;
- a provider context-limit error;
- a model switch with a different context window.

Reason-scoped suppression prevents a failed compaction mode from retrying on
every loop iteration without a relevant state change.

### 4.1 Working state, not merely conversation summary

The compaction prompt can capture runtime information that is not reducible to
the visible chat transcript: active instructions, skills, edited paths,
plans/todos, background commands, subagents, and MCP state. This is crucial for
coding agents. A linguistically faithful conversation summary can still be an
operationally useless continuation if it forgets which files were changed,
which child owns a task, or what is still running.

Source: [compaction context capture](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/session/compaction.rs#L1208-L1370).

### 4.2 Speculative two-pass compaction

Shortly before the true threshold, Grok starts a speculative pass over an old
prefix and caches its result as `NOTE1`. When real compaction becomes
necessary, it validates:

- the model;
- prefix length;
- prefix fingerprint.

If valid, pass two summarizes `NOTE1` plus the recent tail. If invalid, Grok
falls back to ordinary single-pass compaction. This exchanges some speculative
model spend for lower foreground compaction latency.

Source: [speculative compaction](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/session/compaction.rs#L234-L429).

### 4.3 Persistence semantics

Before replacing active chat history, Grok persists a compaction checkpoint.
The replaceable `chat_history.jsonl` becomes the compacted current model
projection, while `updates.jsonl` retains append-only replay/rewind evidence.

Source: [checkpoint persistence](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/src/session/compaction.rs#L2071-L2117).

### 4.4 OS implication

The latest OS projection design already has the right semantic cutoff:

1. summarize the exact request whose usage crossed the threshold;
2. append a summary that replaces history only through that request offset;
3. preserve system context and every later event verbatim.

That correctly protects an input arriving while summarization runs. The
execution mechanism is still wrong: the current branch runs the summarizer
inside `blockProcessorWhile` ([current compaction path](../../src/domains/agents/agent-processor-implementation.ts#L337-L453)). The stream-processor contract explicitly warns that long blocking work prevents later events, including cancellations, from being ingested ([side-effect guarantees](../../src/domains/streams/stream-processor.ts#L84-L111)).

Compaction should instead be a durable obligation:

```ts
type CompactionRequested = {
  compactionId: string;
  requestOffset: number;
  cutoff: number;
  model: string;
  renderVersion: string;
  prefixFingerprint: string;
};

type CompactionCompleted = {
  compactionId: string;
  cutoff: number;
  summary: string;
  capturedWorkingState: WorkingStateCapsule;
  usage?: LlmUsage;
};
```

`reconcile` starts a missing requested attempt under `runInBackground`. The
completion applies only to the matching context epoch. New input remains
ingestible throughout and survives after the cutoff.

A speculative pass also deserves journaled evidence because it incurs external
cost. An orphaned speculative start should normally be marked abandoned rather
than automatically charged again; required compaction can fall back to a
single pass.

## 5. User-facing activity and status

Grok emits low-level phases including:

- waiting for model;
- streaming text;
- streaming reasoning;
- tool execution;
- permission prompt.

Source: [phase enum](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-file-utils/src/events/types.rs#L569-L576).

The pager derives a higher-level activity using an explicit priority:

```text
retrying
> compacting
> known blocking wait
> reasoning
> tool execution
> responding
> waiting for model
```

Waiting is classified further as model, subagent, task output, all tasks,
or sleep. The display can therefore say “Retrying,” “Compacting,” “Waiting on
subagent,” or show the command currently executing, rather than collapsing all
work into “Thinking.”

Source: [activity reducer](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-pager/src/acp/tracker.rs#L396-L480).

The architecture has three status planes:

- durable lifecycle: turn, tool, and child boundaries;
- ephemeral progress: deltas, retry countdowns, command text, heartbeats;
- deterministic UI derivation with a reconnect snapshot for live operations.

The latest Iterate main already has durable busy/idle state, an `llm | script`
phase, and agent-authored `blocked`, `title`, `note`, and `shortStatus`. The next
step is not more ad hoc strings. It is one shared activity reducer with the
same priority semantics across the feed, roster, sidebar, and chat header.

## 6. LLM caching

“LLM cache” refers to three distinct mechanisms here.

### 6.1 Provider prompt/KV cache

This is Grok's primary cache. xAI/OpenAI rely largely on implicit repeated-
prefix reuse. The Anthropic adapter adds an ephemeral cache marker to the last
system block. Grok records provider-reported cached prompt tokens, but its
normal OpenAI request construction leaves `prompt_cache_key` unset.

Source: [usage semantics](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-sampling-types/src/conversation.rs#L640-L681) and [Anthropic cache marker](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-sampling-types/src/conversation.rs#L3191-L3205).

Cache hits come from stable bytes, model, and schema—not from merely setting a
cache key. Grok preserves stability by:

- keeping old messages unchanged until compaction;
- avoiding chronic image eviction and tool-result rewrites;
- preserving a parent conversation byte-for-byte for eligible child forks;
- giving a verbatim child the exact parent tool schema;
- accepting that compaction intentionally rebases the prefix.

### 6.2 Speculative compaction result cache

The cached `NOTE1` summary is an in-process optimization validated by a prefix
fingerprint. It is not provider KV state and disappears on restart.

### 6.3 Whole-response cache

Grok does not use application-level whole-answer memoization as its normal
production strategy.

OS's latest main is already stronger and more explicit:

- published keyed context is never rewritten by a later normal request;
- each request is reconstructed only through its journaled request offset;
- volatile time is appended at the request tail;
- OpenAI BYOK receives a stable per-agent `prompt_cache_key`;
- the compaction request reuses the exact normal-request prefix;
- Cloudflare whole-response caching is enabled only for synthetic preview/e2e
  conversations, never production.

The lesson is to make cacheability a context-model invariant. Transport knobs
should reinforce stable projection semantics, not compensate for a projection
that rewrites its own past.

## 7. Persistence and process restart

Grok stores at least two important session histories:

- `updates.jsonl`: append-only session/UI/tool lifecycle evidence used for
  replay, rewind, export, and session reconstruction;
- `chat_history.jsonl`: the current canonical model conversation, which can be
  replaced after compaction.

Source: [session storage layout](https://github.com/xai-org/grok-build/blob/c1b5909ec707c069f1d21a93917af044e71da0d7/crates/codegen/xai-grok-shell/README.md#L2284-L2303).

Readers tolerate torn or corrupt JSONL lines and quarantine damaged history.
On load, chat state repairs duplicate results and dangling tool calls.

What is not persisted is equally important:

- the suspended foreground future;
- an active provider stream;
- permission interactions;
- live tool execution;
- active child execution;
- most high-frequency progress.

Grok persists enough to resume the conversation, not enough to resume the
computation. That is a reasonable desktop-agent tradeoff but should not be
copied into a Durable Object platform whose central promise is durable
coordination.

## 8. Mapping the loop to a stream processor

The implementation should use three explicit planes.

### 8.1 Durable journal and folded desired state

The fold contains:

```ts
type AgentLoopState = {
  context: AgentContextProjection;
  publishedThrough: number;

  queue: QueuedPrompt[];
  pendingInterjections: Interjection[];

  turn:
    | { phase: "idle"; generation: number }
    | { phase: "sampling"; generation: number; requestOffset: number }
    | { phase: "tools"; generation: number; assistantOffset: number }
    | { phase: "compacting"; generation: number; compactionId: string };

  llmObligations: Record<string, LlmObligation>;
  toolObligations: Record<string, ToolObligation>;
  compactionObligations: Record<string, CompactionObligation>;
  childRuns: Record<string, ChildRun>;
  permissionRequests: Record<string, PermissionRequest>;

  status: DurableAgentStatus;
  usage: AgentUsage;
};
```

The useful event lifecycle is:

```text
context/prompt added
        │
        ▼
turn-requested
        │
        ▼
llm-requested ──► started ──► assistant-committed
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                    no tool calls             tool calls
                         │                         │
                  turn-completed       tool-call-requested[*]
                                                │
                                      started/completed[*]
                                                │
                                        next llm-requested
```

Interruptions, compaction, permissions, and child runs update this desired
state rather than trying to mutate a hidden coroutine stack.

### 8.2 Incarnation-local execution plane

The processor incarnation may retain:

- abort controllers;
- sets of live LLM/tool/compaction attempts;
- transient progress and stream accumulators;
- local resource mutexes.

None of these is evidence that an outcome happened. Their only role is to run
or cancel the current incarnation's attempt. Open durable obligations in the
fold remain authoritative.

### 8.3 Ephemeral presentation plane

Ephemeral events carry:

- response and reasoning chunks;
- tool-argument deltas;
- retry countdowns;
- current command descriptions;
- child progress and heartbeats.

Durable completion events remain the source of truth. On reconnect, the UI
combines the durable open obligations with a runtime snapshot of live details.

### 8.4 Reconciliation and recovery policy

At the stream head, `reconcile` compares desired obligations with the current
incarnation's live sets:

| Operation              | Recovery after a durable start with no live attempt                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| LLM                    | Append crash cancellation and schedule a fresh request generation; reject late output.         |
| Idempotent tool        | Redrive using the same external idempotency key.                                               |
| Non-idempotent tool    | Settle as interrupted/unknown; never guess that replay is safe.                                |
| Required compaction    | Retry or degrade to a smaller/single-pass strategy.                                            |
| Speculative compaction | Mark abandoned and let required compaction fall back.                                          |
| Child agent            | Inspect the child stream/result by `spawnId`; forward its terminal result or continue waiting. |

This is exactly the distinction Iterate's stream-processor documentation makes
between short at-least-once `blockProcessorWhile` work and droppable attempts
whose outcome is recovered by journaled evidence and reconciliation.

Source: [stream processor primitives](../../src/domains/streams/stream-processor.ts#L84-L127), [serialized ingest](../../src/domains/streams/stream-processor.ts#L319-L382), and [at-head reconciliation](../../src/domains/streams/stream-processor.ts#L449-L463).

## 9. What the old Pi port proved

Iterate commit [`5e3d3d57`](https://github.com/iterate/iterate/commit/5e3d3d57eb80304e8a9b1e6c74ea0301f6b17797)
ported the Pi coding-agent loop as a single stream-processor pair. It modeled:

- idle, streaming, and executing-tools phases;
- steering and follow-up queues;
- LLM and tool lifecycle events;
- context transformation and dangling-call repair;
- compaction and overflow recovery;
- restart, replay, abort, and dedup behavior.

That experiment answers the feasibility question: a coding-agent loop can be
expressed as a fold plus reactions.

Its limitations identify the missing production abstractions:

- an in-flight model request was simply reissued after restart;
- in-flight tools were not resumed or classified individually, but converted
  into synthetic “lost in restart” errors;
- controllers and live execution lived in maps beside the folded state;
- subagents and rich progress were outside the model;
- requested/started/completed recovery was implemented manually.

The next version should not preserve the old code wholesale. It should preserve
the phase model and promote its sidecars into explicit obligations and child
protocols.

## 10. Abstraction assessment

### 10.1 What already works

The current `StreamProcessor` is sufficient for a single agent loop:

- deterministic reduction over an append-only journal;
- serialized batches;
- atomic multi-event appends;
- same-stream and sibling-stream append support;
- ephemeral events for streaming;
- durable checkpoints;
- at-head desired-versus-actual reconciliation;
- host keepalive and incarnation revival;
- future event and read-your-write barriers.

The agent should advance through journaled phase transitions rather than trying
to persist a JavaScript stack frame. If preserving the exact suspended stack
were a requirement, the abstraction would indeed be the wrong one. It is not
required for this loop.

### 10.2 Missing higher-level abstractions

The gaps are mostly reusable libraries above `StreamProcessor`:

1. **Obligation helper.** Standard requested/started/completed folding,
   expiration, live-set registration, orphan detection, and recovery hooks are
   repeated domain code today.

2. **Correlated cross-stream child work.** `appendTo` exists, but a processor
   consumes only its home stream. A child must explicitly append its terminal
   result back, or a router must forward it. Spawn/result correlation,
   foreground/background, deadlines, and cancellation should be a shared
   protocol.

3. **Live cancellation mailbox.** A durable interruption event is the truth;
   the active incarnation also needs a quick way to map that event to an abort
   controller. This should not require long work to occupy the serialized
   ingest lane.

4. **Ephemeral status resync.** Streaming events are intentionally not replayed.
   Consumers need one runtime snapshot of current live activities after
   reconnect, like Grok's `list_running` behavior.

5. **Effect recovery classification.** Every tool or capability effect should
   declare `redrive`, `settle-unknown`, `compensate`, or another explicit
   policy. Exactly-once execution cannot be manufactured when the external
   system has no idempotency boundary.

6. **Resource-scoped concurrency.** Grok's same-path file mutex is local. A
   durable platform needs resource keys and capability-host receipts if
   conflicting effects must remain serialized across incarnation changes.

7. **Large projection storage.** Latest-main agent documentation already notes
   that serializing a million-token context into one checkpoint value is not a
   safe storage shape. Context eventually needs chunked rows or immutable
   segments plus a projection cursor.

### 10.3 What should remain agent-specific

The generic processor should not absorb:

- provider chat roles and trust mapping;
- prompt rendering and cache-prefix rules;
- compaction summary semantics;
- tool permission UX;
- subagent context-fork policy;
- human-facing activity labels.

Those are domain semantics implemented on top of generic obligations, child
work, timers, and progress primitives.

## 11. Recommended implementation order

### P0: correctness and interruptibility

1. Move compaction from `blockProcessorWhile` to a durable obligation.
2. Add explicit queue, steer, send-now, and cancel input intents.
3. Gate every completion by turn/request generation so stale output cannot
   publish after interruption.
4. Replace incarnation-dependent partial-response reconstruction with either
   discard-on-cancel or a durable typed interrupted draft.
5. Add eviction tests after every LLM and compaction lifecycle boundary.

### P1: child work and coherent status

1. Add `AgentChildRun` with `spawnId`, child path, context policy,
   foreground/background state, deadline, and terminal result.
2. Support `new | fork | resume` context policies, with a clean-boundary and
   context-window guard for verbatim forks.
3. Add cache-affinity lineage for eligible child forks.
4. Introduce one shared activity reducer for retry, compaction, permission,
   subagent wait, reasoning, script/tool execution, response, and model wait.
5. Add runtime resync for ephemeral live progress.

### P2: performance and scale

1. Add speculative two-pass compaction with fingerprint validation and an
   explicit abandoned-attempt policy.
2. Add resource keys and conflict-aware parallel capability execution.
3. Record prompt-cache hit metrics by phase, model, and context lineage.
4. Move large context projections out of a single generic checkpoint value.

## 12. What to borrow and what not to copy

Borrow from Grok:

- the separation between session coordination, sampling, canonical context,
  tools, and presentation;
- distinct queue, steer, send-now, and cancel semantics;
- canonical-response boundaries and tool-pair repair;
- serial permission preflight followed by conflict-aware parallel execution;
- explicit `new | fork | resume` child context policy;
- byte-stable child forks with identical tool schemas;
- compaction that captures live working state;
- reason-scoped compaction suppression and speculative fingerprint validation;
- semantic activity priority and reconnect resync;
- cache-conscious hysteresis for request-body pruning.

Do not copy:

- an in-memory suspended turn as the unit of durability;
- child executions that become cancelled merely because the host process
  restarted;
- mutable status assembled only from live actor state;
- two overlapping persistence logs without a crisp projection/audit contract;
- accidental dependence on incarnation-local interrupted-response buffers;
- production whole-response caching for real conversations.

## Conclusion

Grok Build demonstrates that a polished coding agent needs more than repeated
LLM calls. It needs explicit phase boundaries, canonical-context discipline,
several interruption intents, child-session lineage, conflict-aware effects,
working-state compaction, cache-prefix stability, and a coherent live activity
model.

It does not demonstrate that these require a durable coroutine abstraction.
Its own durable boundary is the completed conversation, while live work remains
actor-local. Iterate can use its existing journal, fold, ephemeral events, and
at-head reconciler to make every semantically important phase recoverable.

The resulting design is not “Grok's loop inside a processor.” It is Grok's
phase model decomposed into durable obligations, with child agents represented
by real child streams and high-frequency progress kept deliberately ephemeral.
That is both implementable with the current core and a better fit for OS than
copying Grok's in-process actor lifecycle.
