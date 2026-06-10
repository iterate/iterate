---
state: backlog
priority: high
size: large
dependsOn: []
---

# Agents system audit + reconciler design (knowledge dump)

Full record of a deep audit of the agent system (June 2026) plus the design
direction that came out of the follow-up discussion. This is the umbrella doc;
concrete work items are split into:

- `tasks/streams-core-processor-host-homogenization.md` (active direction)
- `tasks/streams-core-clock-durable-timers.md` (separate, deferred)
- `tasks/streams-event-kinds-metadata.md` (idea, deferred)

## 1. Architecture as found

One Stream DO (`packages/streams/src/workers/durable-objects/stream.ts`) owns
the append-only event log per stream. The `AgentDurableObject`
(`apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:138-189`)
co-hosts six processors via `createStreamProcessorHost`
(`packages/streams/src/workers/stream-processor-host.ts`), each subscribed to
the agent's stream over RPC:

- **agent** — owns scheduling + model-visible history. Appends
  `llm-request-scheduled`, arms an in-memory debounce timer, on fire re-reads
  the full stream and appends `llm-request-requested` containing the full LLM
  request body.
- **openai-ws / cloudflare-ai** — LLM providers; one is wired per agent
  (preset-chosen, `agent-presets.ts:12` defaults to openai-ws). Consume
  `llm-request-requested`, append durable `llm-request-started`, run the call
  as background work, append output + terminal `llm-request-completed`.
- **agent-chat** — transcribes web/TUI chat messages into `agent/input-added`.
- **slack-agent** (`apps/os/src/domains/slack/stream-processors/slack-agent/`)
  — Slack ingress, bang-commands, thread routing state.
- **agent-host** — wake/child-agent/codemode plumbing, `consumes: ["*"]`.
- **jsonata-reactor** — generic rule engine, `consumes: ["*", ...]`.
- **core** (`packages/streams/src/processors/core/`) — runs _inline_ in the
  Stream DO (special-cased, not a hosted subscriber): stream metadata,
  subscriptions, pause door.

### Delivery semantics (verified)

- At-least-once. Append is durable (SQL commit) before subscriber `wake()`
  calls (`stream.ts:440-442`). Delivery is fire-and-forget
  (`stream.ts:660-667`); the stream never learns whether a batch landed.
- Processor checkpoints `{offset, state}` in host DO KV, written after each
  batch (`stream-processor.ts:375`). Batches are serialized per processor.
- Idempotency keys are DB-enforced (unique constraint, `stream.ts:100`).
  Processor appends derive keys from source-event offsets
  (`buildProcessorIdempotencyKey`), so retries cannot duplicate.
- `sideEffectsAfterOffset` anchor: events at/below it are reduced but get no
  side effects, set once at first subscribe and never moved
  (`stream-processor-host.ts:174-178`).
- The delivery filter is `contract.consumes` (`stream-processor-host.ts:197`);
  the connection cursor advances past filtered-out events — they are skipped,
  never deferred (`stream.ts:610-651`).
- On subscriber RPC break, the stream closes the connection and re-reconciles
  outbound connections (`stream.ts:695-698`); on Stream DO boot it appends
  `stream/created` (first boot) and `stream/woken` (every boot) and redials
  configured subscribers (`stream.ts:49-82`).
- `kill()` exists for crash injection: `stream.ts:570` → `ctx.abort()`.

### Crash recovery as implemented

Providers track per-request status in reduced state. A `started` entry whose
llmRequestId this instance never executed (instance-scoped
`#executedLlmRequestIds`, empty after restart) is "dangling";
`#reconcileDanglingStartedRequests`
(`cloudflare-ai/implementation.ts:181`, `openai-ws/implementation.ts:229`)
re-executes it from the original requested event in stream history. It runs
only in the `processEventBatch` override, i.e. only when a batch of _consumed_
events is delivered. A still-current check (full stream re-read) skips
agent-visible output for stale recoveries.

## 2. Verified bugs

### 2.1 Debounce wedge (agent processor) — VERIFIED, serious

The `scheduled` phase is durable in reduced state but the timer lives only in
`#scheduledLlmRequest` (`agent/implementation.ts:60`). Crash/eviction between
the `llm-request-scheduled` append and the timer firing:

- Nothing re-arms the timer on wake (the `llm-request-scheduled` case in
  `processEvent` is a no-op, `agent/implementation.ts:77`).
- New input with the default policy (`after-current-request`,
  `agent/contract.ts:107`) hits the scheduled branch and calls
  `#resetScheduledLlmRequestTimer`, which **silently returns** when the warm
  `scheduledEvent` is gone (`agent/implementation.ts:336-341`).
- Result: agent permanently wedged; ordinary messages pile up; only an
  `interrupt-current-request` input recovers it.

### 2.2 Recovery has no wake-time trigger — VERIFIED, serious

Checkpoint deliberately advances past `llm-request-requested` (LLM call is
background work) and past the `started` event. After a host DO crash:

- The re-handshake replays from checkpoint → nothing new → no batch → the
  post-batch reconciliation never runs.
- `stream/woken` does NOT help: (a) it marks the _Stream DO's_ incarnation,
  not the subscriber's — in the common crash (agent DO dies, stream DO warm,
  redials) no woken event is appended at all; (b) providers don't have it in
  `consumes` (`cloudflare-ai/contract.ts:64-68`,
  `openai-ws/contract.ts:108-113`), so even when appended it is filtered out.
  Only the `["*"]` processors (agent-host, jsonata-reactor) ever see it.
- No DO alarms exist anywhere in this system; there is no time-based backstop.
- Net: a crashed mid-flight LLM request is retried only when the _next
  consumed event_ arrives (in practice, the next user message). Composed with
  2.1, both failure modes look identical to the user: "agent stopped replying".

### 2.3 Cancellation race drops output from history

If `llm-request-cancelled` lands between a provider's still-current check and
its `output-added` append (`cloudflare-ai/implementation.ts:~353-376`), the
output reaches the stream but the agent reducer's guard ignores it
(`agent/contract.ts` reducer; see also the completed-event guard at
`agent/implementation.ts:117-124`). The model never sees its own response.

### 2.4 Zombie `pendingTriggerCount`

A request that never reaches a terminal event leaves the count stuck; when
something finally completes much later, `#handleTerminalLlmRequestEvent`
(`agent/implementation.ts:242-247`) fires a spurious LLM request with no new
user intent.

### 2.5 Unbounded `#executedLlmRequestIds`

Ids stay in the set after terminal appends, by design
(`cloudflare-ai/implementation.ts:80-90`); unbounded on long-lived DOs. Low
severity.

### 2.6 O(N²) history embedding + full-stream re-reads

`buildLlmChatRequest` (`agent/contract.ts:337-341`) maps the **entire**
`state.history` into the request body, which is embedded in every
`llm-request-requested` payload → each request event stores a full copy of the
growing conversation → O(N²) stream storage. Additionally the debounce-fire
path re-reads + re-reduces the whole stream (`agent/implementation.ts:360-391`,
deliberate: the timer fires outside any batch so warm state may be stale vs
committed stream), and each provider does _another_ full re-read for the
still-current check. Direction: the request event should carry a reference
("request as-of offset X"), not a materialized body; how the provider
assembles the actual call becomes its internal concern.

### 2.7 Provider duplication

`openai-ws/implementation.ts` (~737 lines) and
`cloudflare-ai/implementation.ts` (~485 lines) are largely copy-pasted state
machines: started/completed bookkeeping, dangling reconciliation, still-current
check all duplicated. Every bug above must be fixed twice.

## 3. Dead code / cruft inventory

- Legacy subscriber types `built-in` / `external-url` parsed then filtered
  (`packages/streams/src/processors/core/contract.ts:28-84`). Context: the
  2026-06-10 prd Slack outage was caused by legacy built-in subscribers being
  ignored after the class-model cutover.
- Orphaned subscriptions under the old `workers-rpc` idempotency-key suffix
  after the `callable` migration (`agent-stream-subscriptions.ts:72-76`).
- `ctx.stream.subscribe()` exists only to throw
  (`agent-durable-object.ts:837-842`).
- UI: `agents/new.tsx` and `agents/new-preset.tsx` are near-identical forms
  with hardcoded tool-provider sets; presets cannot be viewed/edited; the
  agent-vs-preset distinction is invisible to users. Much of this surface
  should shrink once context comes from the project config worker.
- `agent`/`provider` request body duplication (see 2.6).

## 4. Root context + per-project customization gap

Flow today: DO wake → `ensureAgentSetupEvents`
(`agent-durable-object.ts:538-594`) → read path-prefix presets from the
`/agents` root stream → fall back to a **hardcoded system prompt**
(`agent-presets.ts:40-76`) → append setup events idempotently
(`os-agent-setup:${basePath}:${index}:${type}`).

The project config worker (`project-durable-object.ts:776-821`,
`callConfigWorkerFunction`) is **never consulted** — there is no hook for a
project's worker to shape its agents' context. The natural seam is
`ensureAgentSetupEvents`: a `getAgentContext(agentPath)` call into the config
worker supplying/overriding setup events before defaults apply. This aligns
with the itx design of record (`docs/itx-next.md` Phase 4: agent sessions as
forked child contexts whose capability registry the project populates).

## 5. Testing story

- Processor unit tests run in plain Node (vitest `pool: "forks"`), instantiate
  processor classes directly with an in-memory stream + seeded snapshot state.
  Readable, good house style.
- Crash tests in the user's preferred shape ALREADY EXIST:
  `cloudflare-ai/implementation.test.ts:39,61` and
  `openai-ws/implementation.test.ts:230` seed reduced state with a `started`
  request, create a fresh instance (empty runtime state = post-crash), ingest
  a batch, assert re-execution.
- What cannot be expressed today (because production lacks the behavior):
  "given a dangling request and NO new traffic, waking the processor recovers
  it" — there is no wake-time reconcile to test. The test gap mirrors the
  product gap (2.2).
- The agent (scheduler) processor has no reconciliation at all, hence 2.1 has
  nothing to test against.
- `kill()` (`stream.ts:570`) is available for e2e crash injection; currently
  unused by `apps/os/e2e/vitest/agents.e2e.test.ts`.
- The wanted test, post-refactor, reads roughly:
  user input → request in flight → new incarnation (presence event) →
  assert old attempt marked failed (reason: host restarted) + request
  re-issued.

## 6. Design direction agreed in discussion

### 6.1 processEvent IS a reconciler (framing, not a new API)

No special `reconcile()` method. The framing: **`processEvent`'s job is to
reconcile non-serializable runtime state (in-flight LLM calls, timers, open
sockets/connections) against reduced state (what should currently be true)**.
Its two operations, broadly:

1. **Append events** — changing reduced state (and the durable record), e.g.
   "mark the old attempt failed, reason: durable object crashed", then a fresh
   request.
2. **Mutate runtime state** — make an outbound connection, arm a timer, start
   an LLM call.

If reduced state says an LLM request should be in progress and runtime state
says it isn't → append a failure fact and start a new one. Same shape for the
scheduler (phase `scheduled`, due time passed, no timer armed → request now)
and for connections.

Note (design detail to resolve in implementation): the existing dangling check
runs once per batch _after_ full reduction because per-event checks can act on
intermediate state (a batch containing `started@N` + `completed@N+1` looks
dangling after the first event). Presence events usually arrive in their own
batch which mostly moots this, but the per-event-vs-post-batch question needs
an explicit answer in the homogenization work.

### 6.2 Presence facts unify the lifecycle events

`stream/created`, `stream/woken`, `processor-registered`, and the proposed
subscriber-connected event are all the same kind of thing: **"an incarnation
of some participant came up"** — `{participant, incarnationId, contract?}`.
`created` = woken-with-ordinal-zero + birth certificate.
`processor-registered` (currently keyed once-ever per slug+version,
`stream-processor-host.ts:220-244`) becomes a payload of the connect event.

Dual: `subscription-configured` is _desired_ presence; woken/connected are
_actual_ presence; reconciliation closes the gap. Three event kinds fall out:
configuration facts (desired state), presence facts (incarnation
observations), domain facts (the conversation). — Kinds metadata itself is
DEFERRED, see `tasks/streams-event-kinds-metadata.md`.

### 6.3 Subscriber-connected event = the wake-time recovery trigger

Appended during the subscription handshake with a **per-incarnation**
idempotency key (incarnationId generated at host DO construction, like
`stream/woken` does). The framework unions presence types into every
processor's delivery filter (host builds the filter at
`stream-processor-host.ts:197`) so contracts stay purely domain. Then:
connect → append → pump wakes → batch delivered → reconciliation runs with
fresh reduced state. No new code path; rides existing delivery. Granularity:
one event per _host_ incarnation (the AgentDurableObject hosts six
processors), not per processor.

Bonus: the stream becomes an honest record of incarnations (debugging: "agent
went quiet here" correlates with "host re-incarnated here"), and tests express
"crash" in the system's own vocabulary — append a presence fact with a new
incarnationId, assert convergence.

### 6.4 Homogenize the Stream DO into a processor host

The user's key ask — see
`tasks/streams-core-processor-host-homogenization.md`. The core processor's
`#reconcile()` (outbound connection dialing) is just its _local_ reconciler;
its runtime state (the `#connections` map) should become instance state on the
core processor, and its reconciliation should live in its processEvent hook,
making the Stream DO look like any other processor host. Core processor should
also register/announce itself (it currently never appends its own
`processor-registered`, so agents reading the stream have no docs for
`subscription-configured`, `woken`, etc.).

### 6.5 Browser clients as participants (discussed, no task yet)

A browser tab is structurally a processor: consumes events, runs a reducer
(the React UI is a fold over the stream), emits a narrow set of domain facts.
Today browser/watcher sessions attach as ephemeral `inbound` connections
(`stream.ts:525`) invisible to the log. Declaring them participants with
presence facts (`{participant: "browser:<session>", incarnationId, contract}`)
gives: agent-visible human presence, session audit, and a principled place to
scope what browsers may append (contract-on-connect as ACL). Caveat: tab churn
is real; likely wants disconnect facts/debouncing; start with agent streams
only.

### 6.6 Provider-side continuation (discussed, direction only)

OpenAI Responses API supports `previous_response_id`; openai-ws already uses
the Responses API. Direction: **stream stays the source of truth;
previous_response_id is a transport optimization** — use it when the chain is
intact and context hasn't been edited; fall back to rebuild-from-stream when
broken (OpenAI retains ~30 days; cloudflare-ai has no equivalent; context
rewrites/system-prompt updates assume reshaping which provider-side state
can't do). Pairs with fixing 2.6: once the request event is a reference rather
than a materialized body, request assembly is the provider's concern.

## 7. Suggested implementation order

1. Homogenization + presence facts + reconciler framing
   (`tasks/streams-core-processor-host-homogenization.md`) — fixes 2.1/2.2 by
   construction, deletes the provider `processEventBatch` overrides, makes the
   crash test a three-liner. Write the red test first: "recovers on wake with
   zero new events".
2. Collapse provider duplication (2.7) into one shared request-execution
   skeleton with thin provider adapters — fixes the cancellation race (2.3)
   once.
3. Request-by-reference instead of materialized body (2.6), optionally with
   previous_response_id continuation (6.6).
4. Project-worker context hook in `ensureAgentSetupEvents` (section 4), shaped
   like itx Phase 4.
5. Dead-code sweep (section 3) as each area is touched.
6. Deferred: core clock / durable timers
   (`tasks/streams-core-clock-durable-timers.md`), event kinds
   (`tasks/streams-event-kinds-metadata.md`).
