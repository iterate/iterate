# OpenCode v2 and Iterate: architecture, extension, and forking assessment

> Research snapshot: 2026-07-15. OpenCode `v2` at [`83cfafc8842c959f7ab794e9634b65a646b6a3f4`](https://github.com/anomalyco/opencode/commit/83cfafc8842c959f7ab794e9634b65a646b6a3f4), with 532 branch-only commits after its 2026-06-26 merge base with `dev`. Iterate is the current `simplification` worktree. The chronological, deliberately unedited evidence trail is in [the append-only research log](./opencode-v2-research-log.md).

## First: did OpenCode discuss Iterate?

**I found no public GitHub reference to Iterate, `@iterate`, Jonas, `iterate.com`, `os.iterate.com`, `github.com/iterate`, or Herdr in the OpenCode material searched.** This is worth stating first because several designs look close enough that it would be tempting to imply influence.

The audit covered:

- all fetched OpenCode Git refs, commit messages, and diffs;
- the current `v2` and `dev` source trees;
- GitHub commit and code search;
- issue and pull-request titles and bodies;
- issue/PR comments and inline review comments;
- exact-literal filtering of hundreds of GitHub results that merely stemmed from “iteration” or “iterative.”

The repository has GitHub Discussions disabled. Several architectural issues were transcribed from a private Discord review, which is outside the public corpus I could inspect. The precise result is therefore: **no public GitHub cross-reference found as of this snapshot**, not a claim that no contributor has ever heard of or privately discussed Iterate. The similarities below should be treated as convergent architecture.

## Executive assessment

OpenCode v2 and Iterate both use append-only facts to model agents, but they mean different things by “event sourced.” OpenCode commits an event and its relational read-model updates in one SQLite transaction. Its Session tables are the ordinary product state, and a few operations—most notably fork—cannot be reconstructed from the child’s event rows alone. Iterate treats each Stream journal plus a pure processor fold as the authority; stored processor state is explicitly a disposable checkpoint, and blocking consequences must complete before advancing it.

That difference drives nearly every strength and weakness:

- **OpenCode has the clearer public protocol.** Event durability is explicit, Session input has named admission and promotion phases, lifecycle identities distinguish Step/attempt/execution/settlement, its durable log has a deterministic replay-to-live boundary, and agent/plugin contributions have scoped replacement semantics.
- **Iterate has the stronger general recovery substrate.** Processor checkpoints, alarms, incarnation fencing, obligation/reconciler patterns, and crash-shaped tests make eviction and retry behavior first-class. OpenCode currently has an excellent local event transaction and a process-local coordinator, plus a pragmatic graceful-restart handoff, but no general durable adoption loop for work stranded by abrupt process death.
- **OpenCode’s SQLite projections are much better for direct product queries.** It can list/filter/join Sessions, messages, pending inputs, and instruction state without replaying per-aggregate folds. Iterate’s model is better isolated and naturally distributed, but cross-stream projections require explicit processors and indexes.
- **Iterate’s extension isolation is strategically better.** A config-repository Worker is deployed out of process and can expose capabilities, HTTP, streams, WebSockets, and Durable Objects. OpenCode’s public plug-ins are in-process scoped catalog transforms and hooks. The latter are delightfully composable, but they are not a durability boundary and they receive host-process trust.
- **Neither system should model a conversation fork by copying raw durable events.** OpenCode copies selected projected semantic messages and instruction state, then records one sparse child fork fact. Iterate should copy a versioned canonical context snapshot into a fresh Agent Stream and record immutable lineage. Copying Iterate events would reactivate subscriptions, LLM/script obligations, and offset-derived identities.

My overall recommendation is to preserve Iterate’s Stream/processor/recovery architecture and steal a handful of OpenCode’s protocol refinements. Do not rebuild Iterate around a monolithic SQLite event/projector kernel or in-process user plug-ins. The most valuable imports are explicit event definition/version ownership, a race-free `synced` log primitive, a more precise Agent execution vocabulary, transactional/scoped extension generations, and projection-oriented conversation forks.

## Recommended actions

### P0 — fix independently of forking

1. **Fence processor-host wake coordinates.** A wake request must match the host’s configured `(projectId, streamPath)`, not merely resolve to a known processor slug. The current gap makes a copied or malformed control expression capable of delivering one Stream’s events into another Stream’s processor host.
2. **Declare that raw event copying is not a supported fork primitive.** This should be a design invariant before a convenient helper accidentally makes it appear valid.

### P1 — small primitives with disproportionate value

3. **Add a repository-wide durable event catalog with versions and historical decoders/upcasters.** Keep processor-owned reducers, but make every durable type have one owner, one durability classification, and an explicit compatibility story.
4. **Offer a first-class durable replay/follow API with a `synced` watermark.** This removes a recurring client race and makes UIs, config workers, and external indexers share one well-tested handoff protocol.
5. **Name Agent execution identities and transitions.** Separate admitted input, promoted request, logical Step, physical attempt, tool settlement, and runner ownership. Preserve the current reducer internally where possible; this is primarily domain vocabulary and event-contract work.
6. **Give config-repository extensions a manifest and atomic activation generation.** Explicit consumes/emits/capability declarations and stable contribution IDs would make config workers inspectable and filterable without moving their code into the Agent process.

### P1/P2 — implement conversation forks as an Agent-domain feature

7. **Create a fresh physical Agent Stream with a `conversation-forked` seed fact containing canonical context plus lineage.** Reset all operational state. Make transcript, capability, workspace, and accounting policies independent parameters.
8. **Project the branch tree from lineage facts.** A small family metadata Stream may index the tree, but active branches should retain independent Agent Streams and processor checkpoints.

### P2 — use where the product needs it

9. **Adopt scoped contribution algebra for agents, tools, commands, and integrations.** Contributions should have stable provenance, deterministic precedence, disposable scopes, and all-or-nothing generation swaps.
10. **Add typed, durable tool-call lifecycle events where observability/recovery warrants them.** Iterate’s script execution already has a durable consequence protocol; ordinary model tool calls deserve similarly inspectable identities if they become resumable or externally executed.
11. **Add a real multi-Stream registry test double and Miniflare coordinate tests.** The current memory Stream’s `.at()` behavior does not expose all path-independence and subscription-routing bugs.

### P3 — optimize only after semantics are stable

12. **Replace embedded fork snapshots with content-addressed context segments or immutable prefix-range references if storage becomes material.** Keep the same public semantics. An O(compacted-context) copy is a very good first implementation.

## Comparison at a glance

| Concern | OpenCode v2 | Iterate | Assessment |
|---|---|---|---|
| Deployment shape | Local/daemon application with one SQLite database per data root | Multi-tenant Cloudflare platform; one Durable Object journal per `(projectId, path)` | Architectural choices are not directly interchangeable |
| Durable unit | Aggregate event sequence plus synchronous SQL projections | Stream journal plus processor checkpoints | OpenCode optimizes local transactions/queries; Iterate optimizes isolation/recovery |
| Event admission | Static manifest; every definition says durable or ephemeral | Raw Stream accepts type strings; processor contracts parse consumed types | OpenCode’s global catalog is safer; Iterate’s openness needs version governance |
| Event authority | Event plus projection committed together; projections can be required for replay | Journal is authoritative; folded checkpoint is disposable | Iterate is more conventionally replay-deterministic |
| Reads | Relational Session/message/pending/instruction tables | Processor state and explicit cross-stream projections | OpenCode is more queryable; Iterate is more partitioned |
| Durable streaming | Per-Session paged log with deterministic `log.synced`, then follow | Durable subscriptions with per-source cursors and several delivery modes | Combine OpenCode’s handoff marker with Iterate’s delivery machinery |
| Ephemeral streaming | Process-local/global volatile feed | Offsetted ephemeral Stream rows, excluded from normal durable reads/subscriptions and evictable | Iterate gives ephemeral items stronger ordering, at storage cost |
| Input queue | Durable admission and promotion; queue/steer semantics | Requested/scheduled Agent work in folded state | OpenCode’s vocabulary and separate inbox are clearer |
| Execution owner | Process-local run coordinator; managed graceful suspension marker | Processor host alarm/keepalive, incarnation fence, checkpoint recovery | Iterate is stronger on eviction; neither makes arbitrary external effects exactly-once |
| Agent definition | Declarative profile assembled from built-ins/config/plugins | Agent Stream state plus platform/config capabilities | OpenCode cleanly separates profile from Session; Iterate is more runtime-centric |
| Tools | Scoped typed registry; leaf permission check; rich lifecycle | Code-mode scripts and platform capabilities; integrations as processors | OpenCode’s catalog is polished; Iterate’s durable consequence model is stronger |
| Subagents | Fresh child Session; foreground/background Job | Delegated/nested Agent path and capabilities | Both must enforce monotonic child authority |
| Public extension | In-process scoped catalog transforms and hooks | Out-of-process config Worker/DO/capability app | Iterate’s isolation wins; OpenCode’s activation algebra is worth copying |
| Extension event types | Public plugins cannot define/publish durable event types | Workers can append arbitrary event names, but cannot register core reducers/contracts dynamically | Both intentionally stop userspace short of changing core state semantics |
| Fork | Copy selected projected rows; child log contains lineage fact and sparse sequence | Not yet a first-class semantic primitive | Implement snapshot-plus-lineage, not raw copies and not current OpenCode replay dependency |
| Testing | Real SQLite layers, deterministic race gates, replay tests, provider cassettes | Real processors/host over durable in-memory stores with crash/incarnation simulation | Each should borrow the other’s strongest test form |

## The architecture underneath the vocabulary

### OpenCode: event transaction plus relational application state

V2 splits protocol/schema, core, server, client/SDK, CLI, and TUI packages. The central event service assigns aggregate-local sequence numbers and, in one immediate SQLite transaction:

1. validates and version-qualifies the event;
2. runs registered synchronous projectors;
3. runs an optional operation-specific commit callback;
4. inserts the event and advances its aggregate sequence;
5. notifies process-local listeners only after commit.

SQLite runs with WAL, normal synchronization, a busy timeout, foreign keys, and migrations. Session, message, pending-input, and instruction-state tables are not merely caches hidden behind a fold; they are normal read models that application services query directly. This makes invariants crossing an event, a message row, and pending input locally atomic and makes UI queries straightforward.

The phrase “event sourced” is therefore best read as **events are a durable protocol and replay input for registered projections**, not “every aggregate is always a pure fold of only its own rows.” The fork projector is the counterexample: it reads the parent’s projected rows and materializes them into the child. One test intentionally rebuilds a child from its event rows later and observes newer parent instruction state than was selected at fork time.

Deletion is also projection-oriented. Session removal emits a deletion event for observers, then recursively removes Session descendants and deletes the aggregate journal. This is practical local application lifecycle management, not an immutable audit-retention promise.

### Iterate: journal authority plus recoverable processor execution

An Iterate Stream Durable Object owns the append-only journal for one exact `(projectId, path)`. Event 1 creates the domain object. Processors consume durable events in offset order through declared contracts and fold state with pure reducers. Stored state and checkpoint exist to avoid replay cost but are explicitly disposable.

The consequential part is checkpoint timing:

- `blockProcessorWhile` performs at-least-once work before the processor commits its new state/offset;
- `runInBackground` is explicitly droppable and cannot carry a durability claim;
- durable obligations plus an at-head reconciler are the standard way to recover required attempts after eviction;
- host alarms, crash-loop backoff, keepalive, and incarnation fencing adopt unfinished work.

This makes recovery a property of a processor protocol rather than a magical consequence of having a journal. It is a better foundation for a distributed multi-tenant platform. It also makes product queries and schema evolution more work: each projection needs a processor/stream/index, and a current Zod parser rejecting an old event can cause that processor to skip the fact and advance unless a corrected refold is requested.

### The deepest difference: where derived state is allowed to be authoritative

OpenCode couples event storage and relational projection in the same transaction. Iterate couples event consumption and consequence completion at the processor checkpoint. Those are orthogonal axes:

```text
OpenCode publish:
  command -> [project rows + append event] one SQLite transaction -> notify

Iterate process:
  append event -> fold -> [blocking consequence] -> persist state/checkpoint
                           ^ crash retries from old checkpoint
```

OpenCode’s design minimizes the gap between a local command and queryable state. Iterate’s minimizes the gap between an observed fact and a required recoverable reaction. A future Iterate relational index should remain a stream processor/read model, while a future OpenCode durable runner adopter would need a lease/checkpoint/reconciliation layer beyond its existing event transaction.

## Writing agents

### OpenCode’s agent is a profile, not a running object

An OpenCode v2 Agent definition is deliberately declarative. It contains:

- a stable name/ID and description;
- an optional preferred model;
- request overlays and an optional replacement system prompt;
- mode (`primary`, `subagent`, or `all`), visibility, color, and Step limit;
- an ordered permission ruleset.

Built-ins, JSON/JSONC configuration, Markdown files, and plugins all compile to transforms over the same Location-scoped catalog. A Markdown file’s body is its system prompt and its relative path supplies the ID. Reload rematerializes the catalog from an empty map by applying scoped transforms in registration order. Later scalar values replace earlier values, request maps merge, permission rules append, and the last matching permission rule wins.

That gives v2 a very useful separation:

```text
Agent definition        Session                    Step
----------------        -------                    ----
prompt/model/policy  -> selected profile       -> effective profile snapshot
catalog contribution    conversation lineage      one execution decision
mutable by reload        durable messages          historical facts do not rewrite
```

The running orchestration engine is the Session, not the Agent profile. Tools are likewise registrations of typed opaque values, not methods on a base Agent class. The registry decides what definitions the model sees, captures the implementation used for later settlement, filters the visible catalog with the selected Agent’s permission rules, and checks authorization at the tool leaf.

This is an ergonomic win. A contributor can author a reviewer or research agent without subclassing the runner. Profile changes affect later Steps but do not pretend to rewrite the profile used by historical Steps.

There are meaningful beta caveats:

- the documented per-agent request headers/body are retained in the profile but are not yet applied by the runner;
- the public plugin documentation advertises a Session request hook that the current source does not expose;
- the subagent implementation has an explicit TODO around deriving child permissions from parent authority.

The last point is important. The `subagent` tool starts a **fresh** child Session, optionally in a process-local background Job, and later returns or injects its completion. It does not fork the parent transcript. If the named child’s configured permissions are broader than the parent’s, invocation can become an authority escalation. A child policy must be no more powerful than the intersection of caller authority, delegation grant, and child profile.

### Iterate’s agent is a durable domain projection

Iterate’s Agent processor is closer to a running aggregate. Its fold owns system prompt, model choice, model-visible history, current/scheduled work, request generations, retry counters, open LLM obligations, usage, and failure state. `llm-requested` offsets act as durable execution handles; started, chunks, completion, cancellation, and usage facts refer to those handles. Ephemeral output chunks can disappear, while a durable terminal output restores semantic context.

Code mode goes further into userspace than OpenCode’s ordinary profile model. A durable assistant output with an executable fence is deterministically projected into `script-execution-requested`; the eventual result is rendered back as new Agent input. Slack, Telegram, email, and pull-request behaviors can be separate processors hosted around the same Agent Stream rather than branches inside the Agent reducer.

This has two strong properties:

1. the Agent’s model context and owed work can be explained from durable facts;
2. integrations compose as independently checkpointed projections instead of prompt callbacks.

But the authoring story is less sharply separated from runtime state. “Define an agent,” “create an Agent Stream,” “mount capabilities,” “configure integrations,” and “choose a model/system prompt” cross several platform concepts. OpenCode’s small `Agent.Info`-style catalog is worth introducing above that substrate—not as a replacement for the Agent processor, but as a source of immutable/effective configuration used when a request starts.

A possible Iterate profile layer:

```ts
export const reviewer = defineAgentProfile({
  id: "reviewer",
  description: "Reviews changes against repository rules",
  mode: ["primary", "delegated"],
  model: { preference: "reasoning" },
  system: reviewerPrompt,
  capabilities: {
    allow: ["project.files.read", "project.search", "github.pullRequest.read"],
    deny: ["project.files.write", "github.pullRequest.merge"],
  },
  limits: { autonomousTurns: 12 },
})
```

The durable request-start event should record the resolved profile ID, generation/digest, model, and authority envelope. That makes live configuration pleasant without making old executions depend on today’s config repository.

### What to copy and what to keep

Copy from OpenCode:

- a small declarative profile schema;
- deterministic composition and provenance for contributions;
- a strict distinction between profile, conversation, and execution Step;
- tool definitions independent of Agent classes;
- monotonic permission narrowing for delegated children.

Keep from Iterate:

- durable model-context projection;
- explicit requested/started/completed execution handles;
- integration behavior as processors;
- obligation/reconciler recovery;
- code execution as a durable consequence rather than an unrecorded hook.

## Event design and domain language

### OpenCode’s event catalog

V2 makes durability a property of every event definition. A static manifest imports the definitions, assigns versioned wire types, and allows the kernel to reject unregistered publications. Durable events receive aggregate-local sequence metadata and enter the SQLite log; ephemeral events notify listeners but are not inserted. Unknown durable event versions can be skipped during log consumption while the cursor still advances, which favors forward progress for older clients.

The branch history shows that this explicitness was learned rather than present from the first exploration. The event review renamed projection-shaped payloads into domain facts, removed redundant IDs that could be derived from aggregate identity, and separated lifecycle concepts that had been overloaded. The important lesson is not Effect schemas or a particular naming suffix. It is that the repository has one inspectable answer to:

- who owns this type;
- whether it is durable;
- what version is on the wire;
- which projector consumes it;
- whether replay may call external code;
- what identity it advances.

### Iterate’s contract-local catalog

Iterate’s hosted processor contracts already declare typed consumed and emitted events. That is a strong local unit: the runtime can validate input, type reducer code, identify direct dependencies, and document the processor’s vocabulary. At the raw Stream boundary, however, an event remains a string type plus JSON payload. Config workers and other clients can append new names without registering a repository-wide definition.

That openness is valuable for a platform, but three distinct capabilities are currently conflated:

1. **append an opaque application fact** that core need never understand;
2. **publish a versioned extension fact** with a registered owner/schema;
3. **participate in a core processor’s state machine**.

The first can remain open. The second needs a manifest. The third should remain privileged, reviewed platform code.

The historical-decoder gap is more urgent than compile-time typing. A processor refold parses old durable rows with current schemas. If a shape changes incompatibly and the old decoder disappears, the runtime records a parse failure, advances, and silently reconstructs a state without that fact until an operator fixes code and refolds. That is an availability-friendly poison-event policy, but it makes durable-schema retention a real correctness obligation.

### Proposed event registry

This can layer over existing processor contracts:

```ts
export const AgentInputReceived = defineDurableEvent({
  type: "agent/input-received",
  version: 2,
  owner: "agent-processor",
  schema: AgentInputReceivedV2,
  decodeHistorical: {
    1: (old: AgentInputReceivedV1) => ({
      inputId: old.id,
      source: { kind: "legacy", path: old.from },
      items: [{ type: "text", text: old.text }],
    }),
  },
})

export const AgentOutputDelta = defineEphemeralEvent({
  type: "agent/output-delta",
  version: 1,
  owner: "agent-processor",
  schema: AgentOutputDeltaV1,
})
```

The registry should generate or validate:

- the durable/ephemeral inventory;
- parser dispatch for historical versions;
- ownership conflicts;
- processor `consumes`/`emits` compatibility;
- client types and documentation;
- retention of old decoders in replay/refold tests.

An extension-defined event should be namespaced by extension identity and remain opaque to core unless a separately installed processor declares it. Registration is governance and tooling; it must not imply arbitrary code execution inside the Agent processor.

### Event identity: avoid making offsets do every job

Iterate’s envelope offset is an excellent ordered journal coordinate. It is less ideal as a logical request, tool call, conversation item, fork boundary, and idempotency identity simultaneously. Rewriting or copying an event necessarily changes its destination offset, which is one reason raw forking fails.

OpenCode commonly separates event ID, aggregate sequence, message resource ID, input ID, assistant-message ID, and physical attempt. That can feel verbose, but the distinctions answer different questions. Iterate should add stable semantic IDs where an entity survives projection, cross-stream reference, retry, export, or fork. Offsets should remain audit coordinates and causation references.

## Streaming logs and subscriptions

### OpenCode’s two channels

OpenCode has a global volatile event feed and an experimental durable per-Session log. They serve different jobs:

- the volatile feed gives low-latency process-local/server notifications and may lose history;
- the durable log pages aggregate events from SQLite and can optionally follow live commits.

The durable log solves the classic replay/live race with a fixed target:

1. install the live wakeup before reading;
2. capture the aggregate’s target sequence;
3. page durable rows through that target;
4. emit `{ type: "log.synced", aggregateID, seq }`;
5. emit later committed rows from durable database reads, using the wakeup only as a hint.

The marker is part of the data protocol, not a timing guess. Empty aggregates still produce `log.synced`; page boundaries and a commit during replay have deterministic tests. Slow listeners need not trust an in-memory payload queue because the database remains the source.

This is one of the cleanest things Iterate should copy.

### Iterate’s richer delivery substrate

Iterate subscriptions are durable stream facts. Push, wake, and webhook destinations each have subscriber-owned progress. Delivery is at least once and ordered per source Stream. A named expression is re-evaluated under current authority; failures hold the cursor. Ephemeral subscriptions are tied to a session. Every project Stream is born with a feed to the project’s config worker.

Cross-posting deliberately appends a real target event with provenance. Stream-control facts received via that controlled path are inert, and multi-hop provenance limits loops. This is a sophisticated distribution mechanism, not merely an event emitter.

What is missing is a uniform **consumer-visible replay completion boundary**. Consumers often need “give me all durable facts after offset N, tell me exactly when I have caught the snapshot, then keep following.” A first-class API could sit beneath push/wake/webhook and be exposed through itx:

```ts
type LogItem<E> =
  | { type: "event"; event: CommittedEvent<E> }
  | { type: "synced"; stream: StreamRef; throughOffset: number }

const log = stream.replayThenFollow({
  afterOffset: cursor,
  durableOnly: true,
  follow: true,
})

for await (const item of log) {
  if (item.type === "synced") ui.markCaughtUp(item.throughOffset)
  else await projection.apply(item.event)
}
```

The implementation must set the wake mechanism before fixing/reading the target and must re-read rows by offset after wakes. A wake payload should never be the only copy of a durable fact. Existing subscription checkpoints can then reuse the same tested primitive.

### Ephemeral semantics

OpenCode ephemeral events do not enter the durable event table. Iterate ephemeral events receive offsets and are committed in the Stream DO but are omitted from default durable reads/subscriptions and may be evicted. Iterate’s design preserves a stronger local ordering relationship between chunks and terminal events, which is useful for a live Agent UI. It also creates offset gaps in durable views and can tempt consumers to infer persistence from having seen a committed envelope.

The contract should be stated bluntly:

- an ephemeral event is a best-effort observation with an ordering coordinate;
- reducers and recovery must not need it;
- a durable terminal event must be semantically sufficient;
- fork, replay, export, and external durable subscriptions exclude it;
- UIs should reconcile on the durable terminal fact after reconnect.

OpenCode’s explicit definition syntax is useful here even if Iterate retains its stronger ordered-ephemeral transport.

## Persistence, runners, and recovery

### OpenCode’s durable inbox is clearer than its durable runner adoption

Session inputs are admitted durably before they become model context. Promotion moves an input from the pending table into projected messages and records the transition. Queue and steer are distinct delivery choices. Exact prompt retry is keyed by a stable message/input ID and conflicting reuse is rejected.

This creates a valuable invariant: a client acknowledgement does not mean “the runner saw a callback”; it means “the input is in durable admission state.” Compaction is also modeled as an inbox barrier rather than an ad-hoc side task. The branch’s lifecycle review then distinguishes:

- logical Step;
- physical provider attempt and retry;
- execution/busy period;
- assistant turn/message;
- tool settlement and closeout;
- drain completion.

The run coordinator, however, is process-local. One local fiber owns a Session run, coalesces resumes, and knows when to drain again. Retry scheduling and background subagent Jobs rely on live process state. An event can say that work is pending, but no generic durable scanner/lease adopts every stranded state after an arbitrary kill.

The tip has a useful narrower solution for orderly replacement: managed server shutdown writes `time_suspended` into active Session rows; the successor atomically consumes those markers and force-resumes Sessions with bounded concurrency. Normal completion clears a stale marker. That solves graceful deploy/restart continuity. It does not solve a kill before the marker write, and `time_suspended` is mutable projection state rather than a Session journal fact.

The correct conclusion is not “OpenCode is non-durable.” Its inputs, lifecycle, messages, and event projections are durable, and replay is explicitly forbidden from calling providers/tools. The conclusion is that **durable state and durable work adoption are separate features**, and v2 currently implements the first more completely than the second.

### Iterate’s processor host supplies the missing adoption layer

Iterate already has the machinery OpenCode would need:

- a durable checkpoint defines which input fact has been fully handled;
- an alarm and wake protocol reacquires work after eviction;
- an incarnation token prevents a crashed/old instance from committing after a successor;
- blocking consequences keep the checkpoint behind on failure;
- at-head reconciliation finds durable obligations that exist even when the initial attempt was dropped;
- crash-loop backoff prevents hot poison work.

This machinery is not sufficient by itself for exactly-once providers or shell effects. A blocking consequence can run twice if the process dies after the external effect succeeds but before checkpoint commit. Required effects still need idempotency keys or a durable obligation/status protocol. Iterate’s architecture is commendably explicit about that.

The Agent LLM path chooses safe semantic recovery rather than impossible byte-stream continuation: ephemeral chunks can vanish; after a crash, an attempt recorded as started can be cancelled/requeued and a fresh provider request made. The durable output/result is the truth. This is the right level of claim.

### Translate OpenCode’s runner vocabulary, not necessarily its implementation

Iterate can make its current state machine easier to reason about by naming stable concepts without immediately decomposing every event:

```ts
type AgentExecutionIdentity = {
  inputId: string          // durable user/system work item
  stepId: string           // one logical agent decision
  attemptId: string        // one physical provider attempt
  toolCallId?: string      // one tool protocol instance
  streamOffset: number     // journal coordinate, not entity identity
}
```

A candidate lifecycle language:

```text
agent/input-admitted
agent/input-promoted
agent/step-started
agent/attempt-started
agent/output-delta          (ephemeral)
agent/tool-call-requested
agent/tool-call-settled
agent/attempt-ended
agent/step-ended
agent/input-completed
```

This does not mean each label must become an event immediately. A type should exist only if it represents a durable decision, query boundary, retry identity, or externally useful observation. The OpenCode history itself warns against exporting the runner’s entire internal error/transition union before consumers have decisions to make with it.

### Projection atomicity and consequence atomicity can coexist

There are cases where Iterate should want OpenCode-like transactional projections inside one Durable Object. For example, an Agent Stream could atomically append an event and update a disposable local query index. That does not require declaring the index authoritative:

```ts
await storage.transaction(async (tx) => {
  const committed = await journal.append(tx, input)
  await localProjection.apply(tx, committed)
})
```

The rules should remain:

- the projection can be rebuilt from durable facts plus registered historical decoders;
- replay/refold never invokes an external effect;
- cross-DO effects stay outside the storage transaction and use the processor consequence protocol;
- an operation that reads another aggregate during replay must record the selected semantic input or accept that replay is non-deterministic.

That last rule is exactly where OpenCode fork trades purity for convenient materialization.

## Tools, permissions, and subagents

### Tool catalogs versus durable effects

OpenCode has a polished answer to “what tools does this model request see?” A scoped registry materializes provider-compatible definitions for the selected Location and Agent; plugins can add tools; Agent rules filter them; execution retains the exact implementation generation; hook points can observe/modify AI SDK and tool activity.

Iterate’s capabilities are broader distributed objects. A tool-like operation may be an itx capability, config Worker method, Durable Object, script execution, or integration processor. This is more powerful but less uniform as an LLM tool catalog.

The useful synthesis is:

1. materialize a typed tool catalog from capabilities for each Agent Step;
2. record the catalog/profile generation or digest on the Step;
3. enforce authority at invocation, never only when advertising the tool;
4. use durable requested/settled facts for effects that must survive eviction;
5. keep provider deltas ephemeral and canonical terminal results durable.

### Permission monotonicity

Both designs have child-authority hazards. OpenCode’s source acknowledges that a subagent can currently use its independently configured permissions rather than a restriction derived from the caller. Iterate’s lexical capability inheritance means a nested path can acquire live mounts from ancestors, and reusing path nesting to encode conversation branches would accidentally change authority.

Every delegation/fork should compute authority explicitly:

```ts
const effectiveChildAuthority = intersect(
  caller.effectiveAuthority,
  delegationGrant,
  childProfile.requestedAuthority,
  projectPolicy,
)
```

Conversation forking and subagent spawning should then have different defaults:

- **fork:** fresh conversation instance, user-selected capability/workspace policy, no live execution state;
- **subagent:** orchestration child, monotonically restricted delegation, usually fresh context unless context is explicitly supplied;
- **nested path:** capability namespace/topology, not proof of conversational ancestry.

OpenCode’s later separation of `fork` metadata from `parentID` is a direct precedent for keeping these relationships distinct.

### Background agents

OpenCode background subagents are process-local Jobs. Their durable child Sessions retain messages, but the eventual injection back into the parent depends on the running Job unless another path adopts it. Iterate should model background delegation as two durable obligations:

```text
parent: subagent-requested(childId, requestId)
child:  delegated-input-admitted(parentRef, requestId)
child:  delegated-output-completed(requestId, resultRef)
parent: subagent-result-received(requestId, resultRef)
```

The parent processor can reconcile a completed child result that was not delivered before eviction. Stable request/result IDs prevent duplicate injection. This is a place to preserve Iterate’s stronger substrate rather than copying OpenCode’s current Job mechanism.

## Testing architecture

### What OpenCode tests especially well

The v2 core tests run against real SQLite layers, not hand-written repositories. They cover:

- concurrent sequence allocation and exact retries;
- event/projector rollback boundaries;
- paged durable-log replay;
- a commit deliberately interleaved during replay/live handoff;
- replay into a fresh database without invoking providers/tools;
- input admission/promotion invariants;
- fork boundaries, rewritten message IDs, sparse child sequences, nested ancestry, and instruction checkpoints;
- provider behavior through deterministic response fixtures/cassettes;
- graceful suspension marker adoption.

Deterministic gates around races are particularly good. A test can stop the first log page, commit another event, release the page, and assert exact ordering around `log.synced`. This is much more convincing than timing-based streaming tests.

V2 also lets tests expose design compromises. The fork replay test that produces a later parent instruction value after replay is surprising, but because it is asserted, the non-self-contained behavior cannot be mistaken for pure aggregate replay.

### What Iterate tests especially well

Iterate’s stream-processor harness constructs the real host and real processors over durable in-memory journal/checkpoint/KV/alarm stores. Calling `crash()` preserves durable state, invalidates the old incarnation, and allows a successor to boot. Tests can place the cut around:

```text
event append -> reducer -> blocking effect -> checkpoint/state commit -> alarm/reconcile
```

This directly tests the failure model that a Cloudflare Durable Object faces. It is stronger than recreating a service over the same database when the property under test is stale-incarnation writes, alarm recovery, or duplicate effects.

The harness’s current limitation matters for fork/control work: its memory Stream abstraction does not fully model a registry of independently addressed paths and `.at(path)` relationships. A wrong-path wake can look fine when every path resolves to effectively the same in-memory source.

### Combine the test philosophies

Add these test layers:

1. **Repository-wide replay corpus:** every durable historical event version refolds under current code.
2. **Deterministic stream handoff gates:** append between target capture/pages/subscription establishment and assert a single gap-free sequence plus `synced`.
3. **Multi-Stream registry harness:** independent journals by exact `(projectId, path)`, real subscription expressions, provenance, and destination routing.
4. **Real Miniflare Durable Object tests:** coordinate fencing, alarms, and storage transaction behavior.
5. **Crash-cut matrix:** inject a crash before/after every append, external effect, idempotency record, checkpoint, fork child creation, and lineage index update.
6. **Projection rebuild tests:** delete every disposable projection/checkpoint and compare canonical semantic state.
7. **Fork independence tests:** parent continuation/deletion/projector upgrade must not change a child’s canonical initial context.

A concise fault-injection pattern:

```ts
for (const cut of forkCreationCuts) {
  const world = await AgentHarness.start(seed)
  world.failAt(cut)
  await expect(world.fork(request)).rejects.toThrow()

  const recovered = await world.crashAndRestart()
  const child = await recovered.fork(request) // same forkId

  expect(await child.canonicalContext()).toEqual(expectedContext)
  expect(await recovered.childrenOf(parent)).toContainOnce(child.ref)
  expect(await recovered.effectLog()).not.toContainExecutionFrom(parent)
}
```

## Plug-ins, config workers, and stream processors

### The short answer

OpenCode plug-ins, Iterate config workers, and Iterate stream processors overlap in what product feature they might implement, but their abstraction and failure contract are fundamentally different:

- an **OpenCode public plug-in** is trusted in-process code that contributes scoped catalog transforms and synchronous runtime hooks;
- an **Iterate config worker** is isolated, deployed application code that reacts to a checkpointed project event feed and exposes network/capability surfaces;
- an **Iterate stream processor** is a hosted recoverable fold with an owned event contract, checkpoint, blocking consequences, and optional reconciliation.

Calling all three “plugins” hides the most important facts: process isolation, durable state ownership, replay behavior, and who is allowed to change core semantics.

### Capability comparison

| Property | OpenCode public plug-in | OpenCode internal plug-in | Iterate config Worker/DO | Iterate hosted StreamProcessor |
|---|---|---|---|---|
| Runs where | Same process and Location scope | Same process with full core Effect services | Separate Worker or Durable Object isolate/build | Platform-owned Durable Object host |
| Trust | Effectively host-process code | Core code | Project userspace, isolated by workerd/RPC/fetch | Privileged reviewed platform code |
| Activation | Scoped; disposable registrations; generation replacement/rollback | Ordered internal pre/post lists | Repo commit/build/deploy; worker reference/generation | Static host dependency/contract wiring |
| Main contribution | Agents, provider/model catalog, commands, skills, references, integrations, tools, hooks | Built-ins plus full service-backed behavior | `fetch`, project event reactions, methods/getters as capabilities, named Workers/DOs/apps | Durable projection and consequence state machine |
| Durable event read | Public server event subscription; no native arbitrary aggregate log API | Can access core event service | At-least-once, per-source ordered project event batches | Ordered source Stream consumption from checkpoint |
| Durable event publish | No public event publisher | Yes, through core service | Yes, append through itx Stream capability | Yes, declared emitted types/consequences |
| Define durable types | No; manifest is statically compiled | Core can add definitions | Can append a new string type, but cannot register it into core schema/projectors | Contract declares owned/consumed/emitted types in platform code |
| Projection/reducer | No SQL projector or Session reducer registration | Can use core services, but built-ins are still curated | Own Worker/DO state only; cannot inject an Agent reducer | Yes, pure fold and stored disposable state |
| Recovery promise | Scope cleanup; hook invocation itself is not a journal/checkpoint | Whatever core service provides | Delivery retry while batch handler rejects; durable workflows require own DO/idempotency protocol | Host alarm, retained checkpoint, incarnation fence, reconciliation |
| Network/protocol | In-process host APIs | In-process host APIs | Real HTTP, streaming, WebSocket fetch lane, storage, RPC capabilities | Usually internal RPC/wake/consequence surfaces |

### What OpenCode public plug-ins can actually do

At this snapshot, the public `PluginHost` exposes:

- list/reload/transform Agents;
- inspect and transform provider/model catalogs and defaults;
- list/reload/transform commands;
- subscribe to the public/server subset of events;
- define connection methods and transform integrations;
- transform reference sources and skills;
- add tools and register before/after tool hooks;
- hook AI SDK route/language construction;
- create/get/prompt/command/interrupt Sessions.

Activation is Location-scoped. Built-in “pre” plug-ins run first, package/user plug-ins run next, and internal configuration “post” plug-ins apply last. If a generation fails to activate, the supervisor restores the preceding working set. Disabling a scope runs finalizers and rematerializes catalog state without its contributions.

This is a very good plugin algebra. It answers provenance and reload questions that ad-hoc module imports usually ignore:

```text
generation N active
  -> build N+1 in a scope
  -> register all transforms/hooks/tools
  -> success: atomically replace N, dispose N
  -> failure: dispose partial N+1, retain/restore N
```

But it is not an event-processing platform. Public plug-ins cannot:

- add a durable event definition to the static manifest;
- publish arbitrary core durable events directly;
- install a synchronous SQL projector or migration;
- add Session table columns;
- add an API endpoint to the native server protocol;
- read the native durable log as a general projection consumer;
- change runner/coordinator transitions;
- install a durable job adopter/reconciler;
- replace the permission kernel.

The distinction between **internal** and **public** plug-ins matters. Internal plug-ins are wired with a large Effect context containing Event, filesystem, shell, permission, instruction, mutation, npm, model, tool, and other core services. The public host is deliberately capability-narrowed. Saying “OpenCode core is implemented as plugins” without that qualification would imply an openness that the public API does not provide.

There is also source/documentation drift typical of a beta. The docs describe `ctx.session.hook("request")`; the actual public Session domain exposes only create/get/prompt/command/interrupt, and the generic hook registry has only `aisdk` and `tool` domains. The OpenAI Codex provider integration contains a temporary core seam because plug-ins cannot currently construct the needed route. Any adoption decision should use source-backed surfaces, not the docs-only request hook.

### Can OpenCode plug-ins contribute their own event types?

**Not to the native durable protocol.** A plug-in can publish its own state elsewhere, return data from a tool, alter catalogs, and observe the public event stream. It cannot register `my-plugin/something-happened` into `EventManifest`, append it to a Session aggregate through a public event service, or install a projector that makes it native Session state.

That is a sensible boundary. Durable event types are not just TypeScript declarations; they are compatibility commitments consumed by storage, log clients, replay, projectors, SDKs, and migrations. Dynamic definitions would need namespacing, version retention, ownership, activation ordering, missing-plugin behavior, export/import rules, and deterministic projector isolation.

### Can Iterate config code contribute event types?

**It can append arbitrary event names today, but that is weaker than registering a durable type.** The raw Stream accepts the fact, and `processEvent` can react to it. Core processors do not begin understanding it, no schema/version owner is installed, and it does not gain a reducer inside the Agent host. A userspace Durable Object can maintain its own durable state machine around those facts, but it owns the idempotency/recovery implementation.

This is a useful platform feature and should remain. The missing layer is an optional extension manifest that turns an opaque convention into an inspectable contract:

```ts
export default defineIterateExtension({
  id: "acme.github-reviewer",
  version: "3.2.0",

  consumes: [
    { type: "events.iterate.com/github/pull-request-opened", versions: [1] },
    { type: "events.iterate.com/agent/output-added", versions: [2] },
  ],

  emits: {
    "events.acme.com/review/requested": ReviewRequestedV1,
    "events.acme.com/review/completed": ReviewCompletedV1,
  },

  contributions: {
    agents: [reviewerProfile],
    tools: [githubReviewTool],
    capabilities: ["github.pullRequests.read", "streams.append"],
  },

  delivery: {
    mode: "checkpointed-worker",
    idempotency: "source-path-and-offset",
  },
})
```

The platform can use this to install filtered subscriptions, generate typed clients, display provenance, validate namespace ownership, and atomically activate one build generation. It should not run the extension’s reducer in a core Agent transaction. A project wanting stronger workflow recovery can ship a stateful dynamic Worker/DO or, eventually, a sandboxed userspace processor host with an explicit contract.

### Are plug-ins like stream processors?

Only at the level of “some code reacts to something.” Operationally:

```text
OpenCode hook:
  operation in progress -> callback mutates/observes value -> operation continues

Stream processor:
  durable event -> pure state transition -> owed/blocking effects -> checkpoint
                    ^ replayable             ^ at-least-once/reconciled
```

A hook is appropriate for request decoration, tool instrumentation, catalog changes, and implementation selection. A stream processor is appropriate for a recoverable Slack thread projection, agent conversation fold, billing obligation, scheduler, or cross-system workflow. Turning every hook into an event processor would make simple extension work laborious; turning processors into hooks would erase their failure semantics.

### How much OpenCode core can live in public userspace?

The answer depends on what “core logic” means.

**A large fraction of product policy can be userspace:**

- custom agent profiles and system prompts;
- model/provider catalog changes and default selection;
- skills, commands, references, and integrations;
- most custom tools and their before/after transformations;
- workflows that orchestrate Sessions via create/prompt/command/interrupt;
- request/model SDK adaptation within the exposed hooks.

**The execution substrate cannot:**

- event definition, sequence allocation, transaction/projector ordering, replay ownership;
- SQLite schema/migrations and built-in projections;
- Session input admission/promotion invariants;
- runner/coordinator, retry, compaction, interruption, and terminal transitions;
- permission enforcement mechanics;
- native server/client protocol and durable log implementation;
- durable restart/adoption policy.

In rough architectural terms, userspace can replace much of **what an OpenCode agent knows and can call**, but not **what it means for an OpenCode Session action to be durable and correctly ordered**.

Iterate’s config worker can go farther horizontally. It can implement whole networked applications, stateful services, vendor integrations, projections in its own storage, and project-specific policy. It still cannot replace the platform’s Stream storage, capability authorization, core hosted processor semantics, or Agent reducer without those layers deliberately becoming public contracts.

### What Iterate should steal from the plugin system

Steal:

- stable contribution IDs and displayed provenance;
- ordered pre/user/post composition where precedence is intentional;
- one disposable scope per activation;
- atomic generation replacement and rollback;
- catalog editor APIs rather than arbitrary mutable global objects;
- exact effective-generation capture for long-running Agent Steps;
- a narrow host capability passed to extensions.

Do not steal:

- in-process execution of arbitrary project packages;
- synchronous user callbacks inside core Stream append/processor transactions;
- dynamic mutation of core event/projector definitions without an upgrade protocol;
- the assumption that scope disposal is equivalent to workflow recovery;
- a single undifferentiated plugin concept for catalog policy, UI hooks, and durable processors.

The ideal Iterate layering is a small kernel plus several explicit userspace tiers:

```text
Stream/event/capability kernel
        |
hosted processor contract (privileged today; potentially sandboxable later)
        |
config Worker/DO application runtime + extension manifest
        |
agent/tool/command/integration contribution catalogs
        |
project-specific SaaS and UI
```

This is much closer to the “everything possible in userspace” goal than importing OpenCode’s in-process plugin mechanism. The manifest/catalog ideas improve discoverability; the Worker boundary preserves the part that makes the goal safe.

## Conversation forking in an append-only Stream architecture

### Direct answers to the difficult questions

**Yes, Iterate events and subscriptions contain references to their own path, but not all path-looking fields mean the same thing.** Some are historical provenance and must remain unchanged; some are live control coordinates and must be regenerated; some are capability or storage addresses whose inheritance is a policy choice. The same is true of offsets.

**Copying every non-ephemeral event is not merely inefficient. It asserts that operational work happened again in a new Stream.** It can reactivate model calls, scripts, subscriptions, and delivery obligations. Excluding chunks does not make the remaining durable facts safe.

**A branch tree can be a projection while every branch remains append-only.** The recommended first design is one fresh Agent Stream per active conversation branch and one immutable `conversation-forked` seed fact per child. A family/tree index is a rebuildable projection over those facts. The history prefix is materialized as semantic model context, not replayed as child events.

**One physical Stream containing every branch is possible, but it is a rearchitecture, not a shortcut.** Every reducer field, effect, subscriber, permission, checkpoint, and idempotency key would need a `branchId`. All branches would serialize through one Durable Object. It is a plausible future aggregate boundary if “Agent path” should own a conversation family, but it offers little for an initial fork feature.

### Why raw durable copying fails

The problem is semantic, not just referential.

#### 1. Stream control facts are executable configuration

A new Stream already receives its own creation and subscription facts. Copying the parent’s `stream/subscription-configured` would install another active subscription. Only the controlled cross-post path marks second-hand stream-control events inert through provenance; a direct first-hand append into the child does not.

The most concerning current case is a wake expression. The processor host resolves the processor slug but does not independently assert that the supplied Stream coordinate equals the host’s configured home coordinate. A copied parent wake destination could deliver child rows to a parent host and let child offsets affect the parent checkpoint. The correct defenses are both:

- never copy control facts;
- reject every wake whose `(projectId, path)` is not exactly the host coordinate.

#### 2. Destination append assigns a new identity

Spreading a committed parent event into `child.append()` cannot preserve it. The input offset is an optimistic concurrency assertion; the child assigns a new path, offset, creation time, and envelope identity. Removing the old offset breaks references. Preserving it is unsupported and would falsely claim the same physical sequence position in two journals.

#### 3. Offsets are Agent-domain IDs

The offset of an LLM request becomes its execution handle. Started, chunk, completed, usage, and cancellation facts refer to it. Processor consequence IDs include the cause’s `path@offset`. Re-offsetting a copied request creates a new cause and therefore new idempotency/consequence identities; it does not describe inherited history.

#### 4. Durable output can initiate new effects

An assistant `output-added` containing a JavaScript fence is not inert transcript text. The Agent processor extracts it into a new `script-execution-requested`. A copied requested/started LLM lifecycle can be reconciled into a cancellation or retry. A copied completion can render another input. These dangerous boundaries are deliberately durable, so “copy non-ephemeral” selects them.

#### 5. Paths have incompatible roles

Examples:

| Path/reference | Meaning | Fork treatment |
|---|---|---|
| committed envelope `path` | Physical destination Stream | Assign child path |
| `source.processor.stream.path` | Historical cause/provenance | Preserve if retained in audit metadata |
| `whileProcessing.offset` | Historical consequence coordinate | Do not inherit as executable state |
| `crossPostedFrom` | Historical delivery chain | Do not replay; optionally preserve summarized provenance |
| `message-received.from.path` | Historical sender/thread | Preserve only as semantic attribution, not subscription |
| attachment/file path | Address of stored content | Preserve only if child authority can read it; otherwise copy/materialize |
| subscription expression/wake path | Live delivery configuration | Regenerate or omit |
| default workspace capability path | Live authority/storage scope | Choose explicit workspace policy |
| lexical Agent path parent | Capability inheritance topology | Never infer from conversation lineage |

A recursive “replace parent path with child path” pass cannot distinguish these roles. Schema-aware copy code would still have to decide whether each *event* represents context or execution.

#### 6. Path nesting changes authority

Capabilities resolve through lexical ancestors. Naming a fork `/agents/a/fork-1` would give it live inherited mounts and future changes from `/agents/a`; that shape already resembles delegated-agent topology. It may also affect Slack/Telegram/email/PR routing. Conversation lineage is historical data. Capability path hierarchy is live authority. They should not be encoded in the same string.

#### 7. Workspaces are not conversation context

An Agent workspace is a path-derived copy-on-write overlay over the latest config-repo main. A fresh child does not automatically see the parent’s uncommitted overlay. Conversely, pointing both Agents at one live overlay creates concurrent mutation rather than a historical branch.

Conversation, filesystem, and Git branch semantics need separate choices. This is consistent with Claude Code and Codex, both of which fork conversation state while allowing fresh execution/authority/environment choices.

### Candidate storage models

| Model | Creation cost | Normal read | Independence | Main problem | Verdict |
|---|---:|---:|---|---|---|
| Copy all durable events | O(all history) | O(local history) | Superficially independent | Re-executes control/lifecycle semantics; references/offsets break | Reject |
| Copy curated semantic events | O(curated history) | O(local history) | Good if schema is perfect | Every context event must be made seed-safe; history schemas remain coupled | Possible, but snapshot is cleaner |
| Child stores parent prefix reference plus local tail | O(1) | O(ancestry + tail), cacheable | Depends on retained parent/prefix store | Kernel read/retention/GC and consequence-delivery separation | Good eventual optimization |
| One physical Stream, `branchId` on every event | O(1) | Projection traverses branch DAG | One aggregate owns all | Branch-awareness infects all state/effects; one serialization bottleneck | Future redefinition, not incremental |
| Semantic snapshot plus lineage | O(current context) | O(local state) | Self-contained | Snapshot payload/storage and versioning | **Recommended first design** |
| Content-addressed persistent context segments | O(1)–O(changed paths) | O(segment traversal/cache) | Self-contained with retained blobs | More machinery and GC | Recommended optimization later |

The current Agent already compacts model-visible context. That makes O(current-context) materialization bounded by what the next model request would actually consume, rather than by the entire Stream length. Correct simple semantics are likely cheaper than premature structural sharing.

### What OpenCode’s fork teaches

OpenCode does **not** copy its parent event rows. Its fork command:

1. selects all projected messages or those before a requested message boundary;
2. creates a child Session row with fork lineage;
3. copies selected message rows with fresh top-level message IDs;
4. rebuilds instruction state at the selected boundary;
5. resets cost/token totals and excludes a running compaction;
6. reserves sequence space through the parent’s selected sequence;
7. records one child `session.forked` event at child sequence 0.

The child’s next events may therefore have sequences `[0, 5, 6]` even though its own log has no rows 1–4. Fork-copied messages have no child admission facts and are explicitly not exact-retry candidates. This is a strong and mostly correct semantic opinion: inherit model-visible history, not the execution that produced it.

Its weakness is reproducibility. The fork event stores lineage/boundary, not the copied rows or their digest. Rebuilding the child reads the parent’s projection. A current test intentionally starts a child with `Changed context`, deletes its projection, replays only the child rows after the parent has advanced, and expects `Latest context`. The child aggregate log is not self-contained.

OpenCode’s history also contains a classic branch-state bug. Kit’s [`aa2c1472`](https://github.com/anomalyco/opencode/commit/aa2c1472faa1988745b35c7db5c2d5ee979f3200) had to copy the instruction checkpoint horizon, not just messages, because parent message sequences combined with a fresh low child baseline admitted stale context changes and caused an unnecessary rebaseline. Dax’s later [`96717c1a`](https://github.com/anomalyco/opencode/commit/96717c1a8c25ae69a9e276a4b897defbe51e8bba) separated fork metadata from `parentID`, which denotes subagent/orchestration ancestry.

Iterate should copy OpenCode’s **semantic projection choice** and improve on its **self-contained seed**.

### Recommended public semantics

A conversation fork means:

> Create a new conversation whose initial model-visible context equals a canonical, causally closed view of the source conversation at a named boundary; record immutable lineage; start with no running work; and apply explicit authority, workspace, channel, and accounting policies.

That definition has six independent axes:

1. **Transcript/context:** inherited canonical history, system/instruction state, summaries, and readable attachment references.
2. **Running work:** always reset by default; never inherit open LLM/tool/script obligations.
3. **Capabilities:** explicit policy; no accidental lexical/live inheritance.
4. **Workspace:** `fresh`, `shared-live`, or an immutable snapshot/COW branch when supported.
5. **External channel binding:** normally none; never duplicate the parent Slack/email/webhook subscription by accident.
6. **Accounting:** child counters start locally at zero; lineage analytics may expose ancestral cost separately.

### A versioned fork seed

One possible event schema:

```ts
export const AgentConversationForkedV1 = z.object({
  forkId: z.string().uuid(),
  familyId: z.string().uuid(),

  parent: z.object({
    projectId: z.string(),
    path: z.string(),
    throughOffset: z.number().int().positive(),
    throughItemId: z.string(),
    contextDigest: z.string(),
  }),

  snapshot: z.object({
    version: z.literal(1),
    systemPrompt: z.string(),
    model: AgentModelRef,
    instructionState: z.array(CanonicalInstruction),
    history: z.array(CanonicalAgentHistoryItem),
  }),

  policies: z.object({
    capabilities: z.enum(["enclosing-scope", "project-scope", "explicit"]),
    explicitCapabilityGrant: CapabilityGrant.optional(),
    workspace: z.enum(["fresh", "shared-live", "snapshot"]),
    channel: z.literal("detached"),
    accounting: z.literal("child-local"),
  }),
})
```

This is the first **Agent-domain** fact, not physical Stream event 1. The Stream kernel has already written creation and delivery controls. Its reducer must be seed-only:

```ts
case "agents/conversation-forked": {
  invariant(!state.initialized, "fork seed only initializes a fresh Agent")

  return {
    ...emptyAgentState(),
    initialized: true,
    lineage: {
      familyId: event.payload.familyId,
      forkId: event.payload.forkId,
      parent: event.payload.parent,
    },
    systemPrompt: event.payload.snapshot.systemPrompt,
    model: event.payload.snapshot.model,
    instructions: event.payload.snapshot.instructionState,
    history: event.payload.snapshot.history,

    // Deliberately NOT inherited:
    currentRequest: null,
    pendingTriggers: [],
    openLlmRequests: {},
    autonomousTurns: 0,
    requestGeneration: 0,
    retry: null,
    failure: null,
    tokenUsage: zeroTokenUsage,
  }
}
```

Critically, loading `history` through this event must not run the ordinary assistant-output consequence extractor. A JavaScript fence is inherited as inert model-visible text. The child did not produce that output and must not schedule its script.

### Canonical context, not copied implementation objects

The snapshot format should be purpose-built and versioned. It should not blindly serialize current reducer state or copy raw event payloads.

Canonical items should distinguish origin and semantics:

```ts
type CanonicalAgentHistoryItem =
  | { id: string; role: "user"; content: CanonicalContent[]; origin: "user" | "channel" | "system" }
  | { id: string; role: "assistant"; content: CanonicalContent[]; status: "completed" | "interrupted" }
  | { id: string; role: "tool"; callId: string; name: string; result: CanonicalContent[] }
  | { id: string; role: "summary"; content: CanonicalContent[]; summarizesThroughItemId: string }
```

This avoids copying envelopes that carry processor path/offset identities. It also fixes a subtle boot-context issue: a current history item may include a parent-specific path, channel, or workspace prompt. The fork projection should omit the exact parent boot event and generate child-appropriate boot/system context. Longer term, prompt layering should distinguish platform policy, project policy, channel context, user message, and execution environment instead of flattening them into indistinguishable text.

Attachments need a policy. A stable project file/content hash can be referenced if the child has read authority and retention is guaranteed. A transient signed URL, parent workspace path, or capability stub must be copied into durable project storage or represented as unavailable; it cannot be treated as canonical context.

### Choosing a causally closed boundary

An offset is a precise audit coordinate but not always a valid conversation boundary. One assistant response can span request, start, ephemeral chunks, durable output, completion, usage, tool calls, script execution, and a rendered follow-up input. Forking “at offset 143” could cut the response in a state that no user ever saw as complete.

The public API should accept a stable conversation item/turn ID and resolve it to a `throughOffset` only after verifying causal closure. If the source is actively producing output, offer one of three explicit behaviors:

- fork the most recent completed/interrupted boundary;
- wait for the current Step to settle;
- interrupt the Step durably, then fork through the interruption marker.

Do not turn best-effort chunks into durable inherited truth. Codex’s fork implementation provides a useful precedent by inserting an interruption representation when a stored prefix cuts through a turn.

Compaction creates another semantic boundary. If the current context consists of a summary plus recent items after `history-reset`, the snapshot should carry precisely that canonical context and a reference/digest to the summarized horizon. It should not expand the entire pre-compaction transcript unless the API explicitly offers an archival-history fork.

### Creation saga and idempotency

A robust create flow:

```text
1. Authorize fork + policies against source and requested destination.
2. Resolve item boundary -> exact parent throughOffset.
3. Page only durable parent facts through that fixed offset.
4. Fold/project canonical context with no effects.
5. Canonical-encode and hash the snapshot.
6. Reserve/create a fresh child Stream using stable forkId.
7. Commit child Agent initialization + fork seed as one idempotent batch.
8. Project/index child lineage in the conversation-family view.
9. Return only after the child can refold the same initial context.
```

Step 3 must pin the target before reading, using the same race discipline as a replay/live log. Parent events appended later are irrelevant. Step 4 should be a separately testable pure projection, not a state dump from whichever live Agent instance happens to be warm.

The current Stream idempotency behavior needs care: reusing an idempotency key can return the existing event without proving that a caller supplied the same body. On a retried fork, read the existing child seed and compare `forkId`, parent coordinate, snapshot version, and canonical digest. A same-key/different-body request is a conflict, not success.

```ts
const existing = await child.getEvent({ idempotencyKey: `fork:${forkId}` })
if (existing) {
  const recorded = AgentConversationForkedV1.parse(existing.payload)
  if (recorded.parent.throughOffset !== parent.throughOffset ||
      recorded.parent.contextDigest !== contextDigest) {
    throw new ForkConflictError({ forkId, existing: recorded.parent, requested: parent })
  }
  return childRef
}
```

There is an integration race with today’s Agent-default mechanism. New Stream birth is announced to the config worker, which appends default Agent policy. A fork must not race an ordinary default append that later overwrites its pinned system/model context. One of these invariants is required:

- Stream creation accepts initial Agent facts and commits them before publishing the child-birth notification;
- an `agent/initialized` protocol tells the config worker not to apply ordinary defaults to an already initialized fork;
- defaults and fork seed compose by an explicit deterministic rule, with the resolved fork profile captured on the seed.

Relying on “the fork append will probably beat `processEvent`” would make initial context nondeterministic.

Crash recovery should tolerate all partial states:

- reserved child but no seed: retry installs the exact seed;
- seed committed but family index missing: reconciler rebuilds/indexes it;
- family index says child but child is temporarily unavailable: show creating/unavailable and reconcile;
- duplicate create request: return the one matching digest;
- conflicting fork ID: surface a deterministic conflict.

The child seed is authoritative; the family index is a projection. That ordering prevents an index entry from becoming the only copy of initialization state.

### Tree projection without one giant Stream

Every child seed contains `familyId` and exact parent coordinate. A tree view can be built by scanning/indexing lineage facts:

```ts
type ConversationBranch = {
  stream: StreamRef
  familyId: string
  forkId?: string
  parent?: {
    stream: StreamRef
    throughOffset: number
    throughItemId: string
  }
  label?: string
  createdAt: string
  deletedAt?: string
}
```

A small family metadata Stream can carry branch labels, ordering, archival state, and index repair facts. It should not carry every conversation event. Each active branch retains:

- its own physical journal and offset space;
- its own Agent processor checkpoint;
- its own pending work and failure state;
- its own subscriptions/channel policy;
- its own capability and workspace resolution;
- independent hotness/eviction.

This gives the UI a logical tree without forcing every processor to understand branches. It also lets a noisy experimental branch fail or grow without serializing the original conversation.

### Why not one Stream with branch projections?

The model is coherent in the abstract:

```ts
type BranchCreated = {
  branchId: string
  parentBranchId: string
  parentThroughOffset: number
}

type AgentEvent = ExistingAgentEvent & { branchId: string }
```

Projecting branch `B` would traverse ancestor cutoffs and B’s local tail. The physical log remains append-only, and forks are O(1).

In the current implementation, however, branch identity would have to enter:

- Agent history, current request, retry and generation state;
- every LLM/tool/script obligation and consequence key;
- poison/pause and autonomous-turn limits;
- all subscriptions and channel routing;
- capability checks and workspace selection;
- processor checkpoints or per-branch cursors;
- compaction horizons and summaries;
- usage/accounting;
- every integration processor sharing the Agent Stream.

All branches would also share one Durable Object’s single-threaded execution and storage limits. A branch-specific crash loop could block unrelated branches unless the host itself gained multi-tenant scheduling. This architecture may become attractive if the product eventually defines one Agent identity with many lightweight threads, but it should be evaluated as an aggregate redesign with migration—not introduced under a fork API.

### Workspace policy

Conversation forking should not silently imply a Git branch. Give callers an explicit choice:

| Policy | Initial view | Later parent changes | Child writes | Use |
|---|---|---|---|---|
| `fresh` | Latest config-repo main | Follows unshadowed main under current COW rules | Private child overlay | Default cheap conversation exploration |
| `shared-live` | Parent’s exact workspace | Both see same mutations | Concurrent shared writes | Pair work; must be visibly dangerous |
| `snapshot` | Immutable parent workspace snapshot/commit at fork | None unless merged | COW child layer | Reproducible code experiment |

Today only `fresh` and an explicitly shared workspace reference are readily available. “Snapshot” should eventually be built on a content-addressed workspace root or Git commit. Do not pretend that fresh-over-latest-main includes the parent’s uncommitted files.

The fork seed should record the selected workspace policy and stable snapshot/commit ID when present. The workspace operation has its own idempotency and failure saga; the conversation can show “workspace preparing” without compromising the already durable context fork.

### Capability and channel policy

A conversational copy does not grant authority. The child’s effective capabilities should be freshly resolved and recorded as policy/digest for the first Step. Reasonable defaults:

- user-initiated fork in the same project: current enclosing scope, with any sensitive session-only grants removed;
- delegated fork: intersection of parent authority and delegation grant;
- cross-project fork/export: no live capabilities until explicitly bound.

External thread identity should not carry. A fork of a Slack conversation is initially a detached Iterate conversation; posting back to the original Slack thread requires an explicit action/door and authorization. Otherwise both branches could answer one human message or race over the same thread state.

### Accounting, deletion, and retention

Start child token/cost counters at zero, like OpenCode. Store lineage so analytics can present:

- branch-local cost;
- inherited-context estimated tokens;
- total family cost;
- ancestral production cost without charging it again to the child.

A self-contained child should survive parent continuation and, subject to retention policy, parent deletion. Do not recursively delete descendants merely because lineage points at the parent. Instead:

- parent deletion writes a tombstone/redaction state;
- the child retains its canonical seed and displays an unavailable/redacted ancestor;
- shared content blobs use reference counting/retention policy;
- legal/privacy deletion can explicitly cascade or redact copied content when required.

There is no universal answer to GDPR-style erasure versus independent fork retention; the important thing is that the data model permits an explicit policy. A child whose replay secretly needs parent tables makes policy impossible to enforce cleanly.

### Merge semantics

Do not merge append-only execution histories by union. Tool effects, approvals, model answers, and shell commands are not commutative CRDT updates.

Initial merge should mean an explicit import into the target:

```ts
export const ConversationContextImportedV1 = z.object({
  source: z.object({
    projectId: z.string(),
    path: z.string(),
    throughOffset: z.number().int().positive(),
  }),
  selectedItemIds: z.array(z.string()),
  summary: z.string(),
  artifacts: z.array(ContentRef),
  workspaceCommit: z.string().optional(),
  digest: z.string(),
})
```

That fact renders curated source context into the target’s next model input without claiming source-side executions happened in the target. Code/file merging belongs to Git or the workspace layer. A conversation fast-forward is possible only when the target has not diverged and the source is its descendant; even then, materializing/importing context is clearer than moving a mutable branch head invisibly.

### Prior art and what each precedent actually transfers

| System | Fork representation | Transferable lesson | Non-transferable part |
|---|---|---|---|
| Git | Immutable commit DAG; mutable branch pointer | Stable lineage and structural sharing | Reading commits does not execute side effects |
| Temporal | History branch with ancestor ranges plus local tail | Shared immutable prefix, branch-local future, retention accounting | Workflow replay can intentionally re-execute deterministic decisions |
| Kurrent/EventStore | Link events/projections reference source identities | Link rather than clone identity | One link per row and broad control-event exposure are poor Agent defaults |
| Kafka | Independent consumer offsets | Cursors are consumer operational state | A new cursor is not a divergent history branch; both see future records |
| Persistent data structures | Full persistence via path copying/structural sharing | Old version can seed a new future cheaply | Still requires semantic state definition |
| Neon/lakeFS/Dolt | LSN/page ancestry or zero-copy data branch | Parent cutoff plus child-local writes; workspace is a separate domain | Database merge/conflict semantics do not solve conversation effects |
| Automerge/Yjs | Idempotent/commutative change integration | Useful for labels/notes/shared artifacts | Assistant/tool histories are not CRDT operations |
| LangGraph | Checkpoint lineage and replay/time travel | Explicit checkpoint boundary | Replay of later nodes may repeat workflow work; wrong default for context fork |
| Claude Code | Fresh Session with copied conversation; session permissions do not carry | Separate context from authority | Product internals are not a general Stream model |
| Codex | Curated rollout prefix, `forked_from_id`, fresh environment choices | Canonicalize context; mark interrupted turn | Its rollout storage format need not be Iterate’s event schema |
| OpenCode v2 | Copy semantic projections; lineage fact; sparse child sequence | Do not copy operational events | Child-only replay can depend on later parent projection |

The convergence is strong: **share or materialize semantic prefix, record lineage, and start branch-local operational state fresh.** No credible prior art suggests duplicating subscription cursors and already-executed side effects into a child log.

### Minimum fork test matrix

1. Fork through each completed user/assistant/tool/script/summary boundary.
2. Fork while output is streaming under each policy: previous boundary, wait, interrupt.
3. Assert no copied subscription, wake, webhook, checkpoint, or provenance control becomes active.
4. Assert inherited code fences/tool results are inert and cause zero child effects during refold.
5. Parent continues after fork; child initial digest/state is unchanged.
6. Parent is deleted/unavailable; child refolds and executes independently.
7. Nested forks preserve exact selected horizons and family lineage.
8. A same `forkId`/same digest retry returns one child; same ID/different digest conflicts.
9. Crash before/after child reservation, seed append, default initialization, workspace snapshot, and family index update.
10. Capability tests prove the child never exceeds caller/delegation policy and lexical path does not silently alter it.
11. Workspace tests distinguish fresh/latest-main, shared-live, and immutable snapshot behavior.
12. Attachment tests cover durable content refs, inaccessible parent paths, deleted blobs, and signed URLs.
13. Compacted and very large histories respect payload/storage limits and reproduce canonical context.
14. Accounting resets branch-local counters and retains lineage analytics without double charge.
15. Coordinate-fencing tests send a valid processor slug with the wrong project/path and require rejection before reading/advancing any checkpoint.
16. Refold tests upgrade the fork snapshot decoder/projector and compare the canonical digest across versions.

The real-DO case is essential for #15. A memory double that aliases `.at()` paths cannot prove routing isolation.

## What the v2 history says they learned

### Provenance and contributor shape

The `v2` branch is not a small feature branch. At the examined tip it has 532 commits unique from `dev` after their 2026-06-26 merge base; `dev` has 491 commits not in `v2`. The branch tip itself was authored by Dax Raad on 2026-07-15. The remote repository moved from `sst/opencode` to `anomalyco/opencode`, and `dev` remains the default branch.

The v2-only author shortlog at the snapshot is:

| Contributor | Commits |
|---|---:|
| Dax Raad | 229 |
| Kit Langton | 115 |
| Aiden Cline | 87 |
| OpenCode bot | 37 |
| James Long | 30 |
| Simon Klee | 13 |
| Shoubhit Dash | 11 |
| Dax (alternate Git author identity) | 8 |

On the event/Session/runner/schema paths used for this comparison, Kit has 57 commits, Dax 36, and Aiden 26. It would be inaccurate to tell the history as only Kit and Dax, although their changes expose a particularly legible design dialogue.

### The public evolution

#### 1. Exploration did not begin with a polished event thesis

Dax’s April [“2.0 exploration” PR #22335](https://github.com/anomalyco/opencode/pull/22335) is a useful chronological marker but has no substantive public body or review. The detailed architectural record arrives later in code, long PR descriptions, and issues. This matters because retrospective descriptions can make a design look inevitable; the branch was visibly exploratory and repeatedly simplified.

#### 2. Session input durability forced identity and ordering to become explicit

Kit’s [event-sourced Session inputs PR #30785](https://github.com/anomalyco/opencode/pull/30785) articulates the central distinctions:

- accepting an input is not the same as promoting it into conversation context;
- event identity is not message resource identity;
- queue and steer have different behavior;
- an exact retry must return/reuse one durable admission, while conflicting ID reuse is an error;
- synchronous projectors preserve local invariants;
- post-commit listeners are isolated from transaction correctness;
- replay must never call the provider or tool implementation.

Those distinctions now organize the Session code. The transferable lesson is that durable input is an inbox protocol, not just a `messages.push()` followed by a run callback.

#### 3. A domain-wide event review replaced implementation vocabulary

A July cluster is effectively a protocol audit:

- [PR #35172](https://github.com/anomalyco/opencode/pull/35172) makes every event definition explicitly durable or ephemeral.
- [PR #35218](https://github.com/anomalyco/opencode/pull/35218) separates Step, physical attempt, execution, assistant turn, and settlement.
- [PR #35272](https://github.com/anomalyco/opencode/pull/35272) pins down retry, fragments, provider state, and tool closeout.
- [PR #35371](https://github.com/anomalyco/opencode/pull/35371) treats compaction as a durable inbox barrier.
- [Issue #35014](https://github.com/anomalyco/opencode/issues/35014) argues for domain event names, explicit durability, and removing projector-only IDs from payloads.

Several issues say they came out of a private Discord “gang-grill” review. The private discussion is unavailable, but the public artifact shows a valuable method: review the complete event vocabulary as one language. Naming a single event locally is easy; checking whether every identity and terminal state means one consistent thing across retry, tool execution, compaction, and clients is where the design improved.

#### 4. They learned to expose less, not simply to emit more

[Issue #35325](https://github.com/anomalyco/opencode/issues/35325) resists exporting the runner’s rich internal error union and keeps the public terminal error small until clients have concrete decisions to make. Other changes remove projection-specific data from event payloads. V2’s direction is not “events everywhere.” It is “durable domain facts where compatibility needs them, private mechanism elsewhere.”

That is a useful warning for Iterate’s proposed event registry and lifecycle vocabulary: do not turn every reducer field or exception class into a permanent public type.

#### 5. Replay/live synchronization expanded, then was deliberately narrowed

Kit’s [PR #34962](https://github.com/anomalyco/opencode/pull/34962) proposed three related protocols:

- a durable gap-free log;
- a payload-free change hint;
- watermarked snapshots resembling Kubernetes resource versions.

The motivating failures were concrete: TUI replay/live races, slow-client overflow, and downstream/fleet consumers. [PR #35040](https://github.com/anomalyco/opencode/pull/35040) then gave the log a deterministic fixed-target `log.synced` boundary.

Dax’s later commit `ff499c43` removed the generalized change/watermark surface and retained a smaller experimental durable Session log plus the simple volatile global feed. There is no public commit rationale, so one should not invent motives. The observable design pattern is still useful: expand the protocol until the race and consumer needs are understood, preserve the smallest proven primitive, and delete the larger API before beta exposure.

#### 6. Operational traces refined lifecycle authority

[Issue #35448](https://github.com/anomalyco/opencode/issues/35448) describes a reconnecting shared daemon accumulating hundreds of server starts/interrupted streams and over a thousand watcher stops. That evidence sharpened the rule that a fresh server startup may replace a process, while reconnect recovery must not. The managed suspension/resume marker work is a pragmatic response.

The transferable lesson is broader: a durable log does not answer who is allowed to start, replace, interrupt, or resume a runner. Ownership and handoff need their own protocol and must be tested from production traces.

#### 7. Forks exposed hidden state horizons

The visible-message copy initially missed an instruction/context checkpoint horizon. Copied parent message sequences combined with a fresh child baseline let stale updates appear current. Fixing the fork required identifying *all semantic state that constrains interpretation of the prefix*, not just what the chat UI renders.

That is exactly the trap Iterate faces. A canonical fork snapshot needs summary horizons, instruction state, attachment accessibility, and origin-aware boot context—but not execution obligations. “What will the next model see and believe?” is the projection question; “what durable rows existed?” is not.

### Reading Kit and Dax’s visible design pattern

Within the public record, Kit’s changes often expand fuzzy concerns into explicit protocols and test matrices: belief-model instruction synchronization ([PR #34917](https://github.com/anomalyco/opencode/pull/34917)), mechanism-neutral prompt context ([PR #34945](https://github.com/anomalyco/opencode/pull/34945)), replay/live handoff, fork horizons, and runner lifecycle vocabulary.

Dax’s visible changes often collapse or integrate those mechanisms: the original fork and later simplification, server/TUI wiring, removal of larger synchronization surfaces, API cleanup, and separation of conversational fork metadata from orchestration parenthood.

That is an inference from authored public commits, not a claim about private intent or who originated an idea. The useful team pattern is:

```text
find ambiguity -> expand it into named contracts/tests -> run it through product code
               -> remove mechanisms that do not earn a public surface
```

Aiden and others supply a substantial part of the implementation and review surface; contributor counts prevent the “two architect” story from obscuring that.

### What remains unsettled

Remote branch names at the snapshot include storage-v2 service work, Session run-coordinator refactors, runner-transition simplification, simulation specifications, message round-trip elimination, background agents, retries, and terminal failures. The packages use a beta Effect version. Public plugin docs and source already differ in one Session hook.

Therefore this report recommends copying **invariants demonstrated in code/tests**, not package layouts or exact v2 APIs. The branch is upcoming precisely because its surface is still moving.

## OpenCode v2 strengths

### 1. The protocol vocabulary is unusually deliberate

Durability, aggregate sequence, input admission, promotion, Step, physical attempt, tool settlement, compaction barrier, retry, and terminal state are named separately. That lowers the chance that a client, test, and runner use one word for three identities.

### 2. Command, event, and relational state change atomically

Immediate SQLite transactions make event sequence allocation, projector changes, and operation-specific rows one local commit. A UI never sees an admitted input without its event or an event whose synchronous message projection failed. This is an excellent fit for a local/daemon product.

### 3. The replay/live handoff is a real protocol

`log.synced` identifies an exact fixed target. Live notifications are only wakes; durable rows are reread. Empty logs, pagination, and interleaving commits are tested. This is a compact, transferable primitive.

### 4. Agent authoring is cleanly separated from Session execution

Agent definitions are small profiles assembled from multiple sources. Tools are registry values rather than inheritance hooks. A selected profile is resolved at Step time. This makes customization understandable and keeps runner mechanics out of agent files.

### 5. Plugin contribution lifecycle is first-class

Scoped transforms, stable ordering, cleanup, atomic generation changes, and rollback are more mature than “load this JavaScript file and mutate globals.” The same algebra works for built-ins, configuration, and packages while the public host remains narrower than internal services.

### 6. Projection-oriented fork semantics avoid effect replay

Copying messages/instruction state rather than event rows is the right high-level choice. Fresh message IDs, local cost reset, excluded running compaction, explicit boundary selection, and separation from subagent `parentID` show careful thought.

### 7. Tests expose races and compromises

Real SQLite tests and deterministic interleaving gates exercise actual storage behavior. The fork replay test codifies its parent dependency instead of accidentally passing a happy path. Provider fixtures make runner semantics testable without vague mocks.

### 8. The branch deletes ideas before making them public commitments

The synchronization API and public error surface were reduced after exploration. That willingness matters in a v2 rewrite; coherent minimal contracts beat comprehensive unstable ones.

## OpenCode v2 weaknesses and risks

### 1. “Replay” is not uniformly aggregate-local or time-stable

The Session journal is not the sole authority. Fork projection rebuild reads external parent projection state and can yield a different instruction value later. Some mutable projection fields, such as managed suspension, are not journal facts. Export/restore and independent aggregate retention need more semantics than copying event rows.

### 2. Abrupt work adoption is incomplete

The coordinator and background Jobs are process-local. Graceful managed-server handoff is covered; a kill before the suspension marker can strand promoted work or scheduled retry without a generic adopter. Durable input does not by itself guarantee durable continuation.

### 3. In-process plug-ins carry a large trust blast radius

Public capabilities are narrowed at the API level, but plug-in code still runs in the host process/package environment. A malicious or buggy package can consume CPU/memory or exploit ambient runtime access outside the typed host unless the loader adds isolation not visible here. This is acceptable for a local developer tool but is not a model Iterate should import into a multi-tenant service.

### 4. Public plugin extensibility stops above the durable core

Plugins cannot add native durable types/projectors, runner recovery policies, protocol endpoints, or migrations. That boundary is defensible, but marketing the architecture as fully plugin-built would be misleading because internal plugins have much greater service access.

### 5. Beta contracts are visibly ahead of implementation

The documented Session request hook is absent from source; agent request overlays are not applied; a provider route requires a core seam. Exact public APIs should not be considered settled.

### 6. Subagent authority and background durability need closure

Child permissions are not yet monotonically derived. Background completion reinjection relies on a live process-local Job. These become security/reliability issues as background agents grow beyond a convenience feature.

### 7. Recursive deletion simplifies lineage by discarding it

Deleting a parent recursively removes descendants and journals. This avoids orphan resolution, but it prevents independent child retention and weakens audit/export semantics. It is a product policy encoded into storage behavior.

### 8. Static global schema and synchronous projectors can concentrate coupling

Every native durable event/projector/migration joins one core release train and one database. This buys consistency but limits independent extensions. A slow/fragile projector can block publication unless rigorously kept pure/local. The model fits OpenCode’s deployment shape better than Iterate’s tenant-isolated platform.

## Iterate strengths

### 1. Stream isolation is a strong distributed aggregate boundary

`(projectId, path)` naturally partitions journal, storage, hotness, and failure. One noisy Agent or integration does not require a process-wide SQLite transaction or runner lock. Cloudflare’s single-object serialization supplies a clear local consistency boundary.

### 2. Processor semantics distinguish state, attempts, and obligations

Pure reduce, disposable checkpoint state, blocking consequences, droppable background attempts, and reconcilable obligations are an unusually honest model of durability. The architecture does not claim that an append-only log makes arbitrary side effects exactly-once.

### 3. Recovery behavior is platform-shaped

Alarms, keepalive, crash-loop backoff, incarnation fencing, and recovery tests match Durable Object eviction/failure. A successor can reject stale writes from an old instance and continue from retained journal/checkpoint state.

### 4. Config workers are a real userspace application boundary

Project code can receive durable event batches, append facts, call capabilities, expose flattened method surfaces, serve HTTP, stream, upgrade WebSockets through the fetch lane, and own Durable Object storage. This supports “SaaS as an npm package” more convincingly than an in-process hook API.

### 5. Subscriptions and provenance are durable domain data

Push/wake/webhook configuration is visible in the journal; cursors retain progress; named expressions are reauthorized; cross-posting preserves provenance, prevents loops, and makes second-hand control facts inert. Distribution is inspectable rather than hidden in process callbacks.

### 6. Agent effects have explicit recovery boundaries

LLM request handles, ephemeral chunks, durable completions, cancellation/requeue on crash, script-request derivation, and durable result rendering give the Agent processor a coherent effect story. History reset compacts model context without deleting the audit log.

### 7. Integrations can compose as processors

Slack, email, Telegram, and PR projections can share one Agent Stream without expanding one central reducer. The architecture supports vertical slices with independent state/checkpoints even if current implementations are still platform-owned.

### 8. The crash-shaped harness is a strategic asset

It tests old-incarnation fencing and retained alarms/checkpoints, not just service reconstruction. That harness should become the standard proof for every promised durable consequence and fork saga.

## Iterate weaknesses and risks

### 1. Durable event compatibility is under-governed

Processor contracts type current consumption, but the raw Stream accepts arbitrary names and there is no single version/owner/historical decoder registry. Refold under a changed Zod schema can skip an old fact and advance. This is the largest gap between “append-only forever” and actual long-term replayability.

### 2. Offsets carry too much domain identity

Offsets identify LLM work, causation, idempotency, and conversation positions. That is compact but makes copying, importing, cross-stream reference, and semantic boundaries fragile. Stable item/step/attempt/tool IDs should supplement—not replace—offset coordinates.

### 3. The Agent profile/runtime boundary is blurry

System prompt, model, boot context, capability mounts, integration/channel path, workspace, and running state enter through several mechanisms. There is no single inspectable effective Agent profile/generation comparable to OpenCode’s catalog.

### 4. Client replay/live synchronization is not one canonical primitive

The subscription system is richer than OpenCode’s, but consumers can still reinvent “read pages, install live listener, avoid the gap, know when caught up.” A fixed-target `synced` protocol would make the richness safer.

### 5. The config worker feed is powerful but underspecified

It receives every durable project event as an untyped catch-all. There is no consumes/emits/capability manifest, contribution provenance, atomic catalog generation, or processor-style alarm/reconciler contract. Project code can implement these itself, which is not the same as having a platform convention.

### 6. Core logic remains more platform-owned than the userspace vision suggests

Channel transcribers, integration-specific behavior, agent defaults, and other vertical slices are processors/runtime code in `apps/os`, even where the config worker could express policy. The underlying extension substrate exists; packaging, manifests, safe defaults, and migration paths lag behind it.

### 7. Product projections are more laborious

Per-Stream folds are excellent aggregate state but awkward for relational queries across Sessions, pending work, message search, family trees, and fleet dashboards. Explicit indexing processors are necessary and need the same rebuild/version discipline as local folds.

### 8. Path topology conflates several meanings

Paths are identity, routing, capability inheritance, workspace derivation, and sometimes channel topology. That power makes names ergonomic but creates surprising behavior if conversation lineage or copying is encoded by nesting.

### 9. A host coordinate check is missing

Resolving a wake by processor slug without asserting the exact configured Stream coordinate violates isolation assumptions. Even if no fork copies controls, malformed or stale configuration deserves fail-closed fencing.

### 10. Fork semantics do not fall out of append-only storage

There is no safe generic copy. The Agent needs a canonical semantic projection, explicit lineage, and policies for context, authority, workspace, channel, and accounting. Treating forking as a Stream utility would put domain semantics in the wrong layer.

## Concrete things to steal and how they translate

| OpenCode lesson | Iterate translation | Scope | Main risk |
|---|---|---:|---|
| Every event declares durable/ephemeral and version | Global registry layered over processor contracts | Medium | Over-centralizing opaque app events |
| `log.synced` fixed-target handoff | `replayThenFollow` shared by subscriptions/itx/UI | Small–medium | Treating wakes as payload instead of rereading journal |
| Input admission versus promotion | Separate durable Agent inbox identity from model-context insertion | Medium | Event proliferation/migration |
| Step/attempt/tool settlement vocabulary | Stable semantic IDs alongside offsets | Medium | Exposing internal transitions too early |
| Agent profile catalog | Resolved profile generation recorded at Step start | Medium | Duplicating config/default sources |
| Scoped plugin transforms | Atomic config-worker contribution generation and provenance | Medium | Reintroducing in-process project code |
| Projection-copy fork | Canonical semantic snapshot in child seed | Medium–large | Initialization/default race, payload size |
| Deterministic race hooks | Fixed interleaving gates in Stream/log tests | Small | Tests tied too closely to implementation |
| Managed suspension distinction | Explicit graceful-handoff vs eviction/crash recovery docs/events | Small | Assuming one mechanism covers both |
| Public API reduction | Keep internal processor errors/transitions private until consumers act on them | Ongoing | Under-instrumenting operations |

### 1. Coordinate fence: a small safety fix

The host already knows its exact `options.projectId` and `options.path`. Validate before resolving a processor or reading its checkpoint:

```ts
async wakeStreamSubscriber(args) {
  if (
    args.stream.projectId !== options.projectId ||
    args.stream.path !== options.path
  ) {
    throw new Error(
      `wake coordinate mismatch: expected ${options.projectId}:${options.path}, ` +
      `received ${args.stream.projectId}:${args.stream.path}`,
    )
  }

  const name = resolveProcessorName(args)
  // existing handshake...
}
```

Test that the failure happens before `snapshot()`, returns no sink, and cannot advance state even when `processorSlug` is valid. Also test project mismatch with the same path and global `projectId: null` hosts.

### 2. Versioned event catalog without closing the platform

Use two namespaces:

- **registered durable protocol events**, with owner/version/decoder and generated clients;
- **opaque application events**, which remain legal strings and are never assumed by core.

Processor contracts reference catalog definitions rather than repeating schemas. Extension manifests may register namespaced schemas for documentation/filtering but cannot install code into a core fold. A CI check should replay a retained fixture for every historical version.

### 3. One replay/follow primitive

Implement target capture and wake installation inside the Stream DO so clients cannot order them incorrectly. The durable sequence should be:

```text
subscribe wake -> capture durable head H -> page (after, H] -> synced(H)
              -> on each wake, read durable rows > lastSeen
```

If the physical allocator includes ephemeral offsets, `H` should identify the last durable row or the protocol should explicitly allow durable offset gaps. `synced(H)` means no durable row at or below H is missing, not that the processor/UI has finished every downstream effect.

### 4. Agent inbox and execution IDs

Introduce stable IDs in new events while maintaining old offset references during migration:

```ts
type AgentInputAdmitted = {
  inputId: string
  delivery: "queue" | "steer"
  content: AgentInputItem[]
}

type AgentAttemptStarted = {
  stepId: string
  attemptId: string
  inputId: string
  requestEventOffset: number // audit/causation bridge during migration
  model: string
  profileDigest: string
}
```

The reducer can still derive its current-request structure. The payoff is that fork boundaries, retries, logs, provider traces, and cross-stream results reference semantic identities that do not change when materialized elsewhere.

### 5. Effective Agent profile generation

Config-repo defaults, platform fallback, channel policy, capability mounts, and per-request override should compile into a canonical profile. Capture its digest on `step-started`; store the full resolved policy only when necessary for audit/replay.

```ts
const effective = resolveAgentProfile({
  platformFallback,
  projectGeneration,
  agentPath,
  channelContext,
  requestOverride,
})

await stream.append({
  type: "agents/step-started",
  payload: {
    stepId,
    inputId,
    profileId: effective.id,
    profileGeneration: effective.generation,
    profileDigest: digest(effective),
    model: effective.model,
    authorityDigest: digest(effective.capabilities),
  },
})
```

This creates the clean profile/Session distinction without moving Agent runtime state out of the processor.

### 6. Atomic extension generations

The build/deploy controller should treat one config-repo revision as a contribution generation:

```text
build -> validate manifest/schema ownership/capabilities
      -> start candidate Worker
      -> probe contributions and event filters
      -> install subscriptions/catalog generation atomically
      -> route new calls/events to candidate
      -> retire old generation after in-flight work drains
```

Long-running Agent Steps retain the generation/digest they started with. Checkpointed event delivery needs a defined cutover offset so the old and new worker do not both act or leave a gap. The simplest safe rule is one active consumer generation per source cursor with an atomic destination swap; in-flight batch failure is retried by the chosen generation under the same source event idempotency key.

### 7. Conversation fork as a domain operation

Implement the schema/saga in the forking section, not a `Stream.copy()` helper. First ship `fresh` workspace and detached channel policies. Store the full canonical snapshot until metrics prove a content-addressed optimization is necessary.

The key acceptance assertion is:

```ts
expect(await refoldChildAfter({
  parentContinued: true,
  parentDeleted: true,
  coldStart: true,
})).toEqual(contextAtOriginalFork)
```

### 8. Projection/index ergonomics

OpenCode’s relational tables show the value of query-first read models. Iterate should make it routine to define a rebuildable fleet projection:

```ts
export const ConversationFamilyIndex = defineProjection({
  id: "conversation-family-index",
  consumes: [AgentConversationForked, AgentConversationDeleted, AgentBranchRenamed],
  key: (event) => event.payload.familyId,
  reduce: (family, event) => updateFamilyTree(family, event),
  storage: "durable-object-sql",
  rebuildFrom: "project-stream-catalog",
})
```

The API should advertise projection freshness/checkpoint. Do not silently pretend a cross-stream index is transactionally current with every source DO.

### 9. Pair race gates with crash gates

For every new protocol, ask two different questions:

- **race:** what if another append/connection arrives between these lines in the same live world?
- **crash:** what if the current incarnation disappears after this durable/external boundary?

OpenCode is especially good at the first; Iterate is especially good at the second. A protocol should generally have both a deterministic interleaving test and an incarnation-restart matrix.

## What not to steal

1. **Do not make one project-wide SQLite database the Iterate authority.** It would collapse tenant/Stream isolation and move the consistency bottleneck to one place. Local SQL projections inside a DO are fine.
2. **Do not load arbitrary project plug-ins into the OS Worker/Agent DO process.** Config Worker/DO isolation is a strategic feature, not incidental overhead.
3. **Do not let user callbacks run synchronously inside Stream append transactions.** Deterministic platform-owned projectors are one thing; untrusted network/package code would make append availability depend on userspace.
4. **Do not copy OpenCode’s external-parent fork replay.** Materialize the selected canonical snapshot or a content-addressed immutable reference so child refold is time-stable.
5. **Do not use a sparse inherited sequence as proof of inherited content.** A parent cutoff is lineage metadata; it is not a digest or snapshot.
6. **Do not recursively delete conversation descendants by default.** Make retention/cascade an explicit product policy.
7. **Do not expose every runner transition/error because v2 has names for it.** Adopt the conceptual distinctions; publish only stable facts clients and recovery need.
8. **Do not confuse plugin scope cleanup with durable workflow cancellation.** Disposal unregisters callbacks; cancellation needs durable state and settled obligations.
9. **Do not encode conversational parenthood in path nesting.** It mutates capability/workspace/channel behavior.
10. **Do not optimize forks with shared prefix ranges before the canonical context format exists.** Structural sharing preserves whatever semantics it is given, including the wrong ones.

## A pragmatic sequence of experiments

### Experiment A — event compatibility inventory

Generate a report of every processor `consumes`/`emits` type, duplicate owner, durability use, current schema, and fixture availability. Add one old-version fixture and upcaster path end to end. This reveals whether a global catalog can be layered rather than imposed.

### Experiment B — `synced` log for one Agent UI

Implement fixed-target replay/follow behind an experimental itx method and convert one chat view. Add deterministic append-during-page and reconnect tests. Measure duplicate/gap handling and whether ephemeral offset gaps complicate the marker.

### Experiment C — extension manifest as observation only

Have the seeded config worker export a manifest. Display consumes/emits/capabilities and use consumes only to filter delivery; do not change execution ownership yet. Validate atomic build-generation provenance in logs.

### Experiment D — fork projection spike with no execution API

Write a pure `canonicalContextAt(parent, boundary)` projector and golden tests over real Agent journals: ordinary chat, code fence/result, failed LLM attempt, channel boot, compaction, attachments. Serialize/hash its result. This de-risks the hardest semantic question without creating children.

### Experiment E — child seed and crash matrix

Add the seed-only reducer path and create fresh detached children in the harness. Ensure refold causes no side effect. Then add multi-Stream and real-DO tests before exposing UI branching.

### Experiment F — workspace snapshot as a separate feature

Compare fresh/latest-main, shared overlay, and content-addressed/Git snapshot behavior. Link the chosen workspace ref from a fork; do not make conversation delivery wait on an unnecessary filesystem copy when `fresh` is selected.

## Bottom line

OpenCode v2 is strongest where Iterate is currently informal: precise public vocabulary, catalog composition, relational projection ergonomics, and the replay/live handoff. Iterate is strongest where OpenCode is currently pragmatic/local: distributed isolation, recoverable processor consequences, eviction adoption, and userspace execution boundaries.

The right move is not convergence on one implementation. It is a deliberate exchange of invariants:

- give Iterate OpenCode’s event/version/profile/log clarity;
- keep Iterate’s Stream authority, processor recovery, and Worker isolation;
- model plugins, app workers, and durable processors as separate extension tiers;
- model a fork as semantic context initialization plus immutable lineage;
- keep operational history, subscriptions, capabilities, workspaces, channels, and accounting branch-local unless a policy explicitly says otherwise.

For the specific fork question: **use an O(current-context) self-contained snapshot first.** It is less storage-efficient than a prefix pointer and dramatically easier to make correct. Once the canonical context format, digest, deletion semantics, and effect-free projection are proven, replace the embedded bytes with immutable content-addressed segments or ancestor ranges without changing what callers believe a fork means.

## Source map

### OpenCode v2 source at the exact reviewed commit

- Event definitions and durability: [`packages/schema/src/event.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/schema/src/event.ts)
- Static event inventory: [`packages/schema/src/event-manifest.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/schema/src/event-manifest.ts)
- Session event schema, including fork: [`packages/schema/src/session-event.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/schema/src/session-event.ts)
- Event transaction, replay, and log: [`packages/core/src/event.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/event.ts)
- Event tables: [`packages/core/src/event/sql.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/event/sql.ts)
- SQLite configuration: [`packages/core/src/database/database.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/database/database.ts)
- Session/message/pending/instruction tables: [`packages/core/src/session/sql.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/session/sql.ts)
- Session create/fork/remove API: [`packages/core/src/session.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/session.ts)
- Session transactional projector and fork materialization: [`packages/core/src/session/projector.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/session/projector.ts)
- Forked instruction lineage: [`packages/core/src/session/instruction-state.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/session/instruction-state.ts)
- Run coordinator: [`packages/core/src/session/run-coordinator.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/session/run-coordinator.ts)
- Execution and restart behavior: [`packages/core/src/session/execution.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/session/execution.ts), [`packages/core/src/session/execution/restart.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/session/execution/restart.ts)
- Agent schema and catalog: [`packages/schema/src/agent.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/schema/src/agent.ts), [`packages/core/src/agent.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/agent.ts)
- Markdown/config Agent contribution: [`packages/core/src/config/plugin/agent.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/config/plugin/agent.ts)
- Public plugin host: [`packages/core/src/plugin/host.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/plugin/host.ts)
- Plugin hook domains: [`packages/core/src/plugin/hooks.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/plugin/hooks.ts)
- Privileged internal plugin services/order: [`packages/core/src/plugin/internal.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/plugin/internal.ts)
- Plugin activation generations: [`packages/core/src/plugin/supervisor.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/plugin/supervisor.ts)
- Subagent tool: [`packages/core/src/tool/subagent.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/src/tool/subagent.ts)
- Fork and Session creation tests: [`packages/core/test/session-create.test.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/test/session-create.test.ts)
- Instruction/fork/replay tests: [`packages/core/test/session-runner.test.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/test/session-runner.test.ts)
- Durable log race tests: [`packages/core/test/event.test.ts`](https://github.com/anomalyco/opencode/blob/83cfafc8842c959f7ab794e9634b65a646b6a3f4/packages/core/test/event.test.ts)

### Iterate source

- Stream envelopes, source/provenance, and ephemeral shape: [schemas.ts](../../src/domains/streams/schemas.ts)
- Stream creation, append, and control journal: [stream-durable-object.ts](../../src/domains/streams/stream-durable-object.ts)
- Processor contract definitions and event ownership: [processor-contracts.ts](../../src/domains/streams/processor-contracts.ts)
- Fold/checkpoint/consequence runtime: [stream-processor.ts](../../src/domains/streams/stream-processor.ts)
- Hosted wake/alarm/incarnation behavior: [stream-processor-host.ts](../../src/domains/streams/stream-processor-host.ts)
- Crash-shaped test harness: [test-helpers.ts](../../src/domains/streams/test-helpers.ts)
- Agent event/state contract: [agent-processor-contract.ts](../../src/domains/agents/agent-processor-contract.ts)
- Agent fold/effects/reconciliation: [agent-processor-implementation.ts](../../src/domains/agents/agent-processor-implementation.ts)
- Agent multi-processor host: [agent-durable-object.ts](../../src/domains/agents/agent-durable-object.ts)
- Seeded config Worker/DO application surface: [worker.ts](../../config-repo-template/worker.ts)
- Config Worker dispatch/fetch-lane model: [dynamic-worker-dispatch.md](../dynamic-worker-dispatch.md)
- Public capability/RPC targets: [rpc-targets.ts](../../src/rpc-targets.ts)
- Domain objects and processors overview: [domain-objects-and-stream-processors.md](../../../../docs/domain-objects-and-stream-processors.md)
- Consequence and reconciler guidance: [writing-stream-processors.md](../../../../docs/writing-stream-processors.md)

### Forking and log prior art

- Git: [data model](https://git-scm.com/docs/gitdatamodel.html), [repository layout](https://git-scm.com/docs/gitrepository-layout.html)
- Temporal: [History service architecture](https://github.com/temporalio/temporal/blob/8224a5375112079ad905c4ea829420306431462c/docs/architecture/history-service.md), [HistoryTree protocol](https://github.com/temporalio/temporal/blob/8224a5375112079ad905c4ea829420306431462c/proto/internal/temporal/server/api/persistence/v1/history_tree.proto)
- Kurrent/EventStore: [system projections](https://docs.kurrent.io/server/v25.0/features/projections/system), [`linkTo` stream semantics](https://docs.kurrent.io/server/v25.0/features/streams)
- Kafka: [log and consumer-offset design](https://kafka.apache.org/20/design/design/)
- Persistent data structures: Driscoll et al., [Making Data Structures Persistent](https://www.cs.cmu.edu/~sleator/papers/making-data-structures-persistent.pdf)
- CRDT contrast: [Automerge changes and history](https://automerge.org/automerge-swift/documentation/automerge/changesandhistory/), [Yjs updates](https://docs.yjs.dev/api/document-updates)
- Storage branching: Neon [page-at-LSN](https://neon.com/blog/get-page-at-lsn), [lakeFS data model](https://docs.lakefs.io/v1.81/understand/model/), [Dolt merge semantics](https://www.dolthub.com/docs/concepts/dolt/git/merge/)
- Agent/workflow forks: [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [LangGraph time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel), [Claude Code sessions](https://code.claude.com/docs/en/sessions), Codex [fork parameters](https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L486) and [fork implementation](https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/core/src/thread_manager.rs#L970)

### Public OpenCode history cited

- [PR #22335 — 2.0 exploration](https://github.com/anomalyco/opencode/pull/22335)
- [PR #30785 — event-sourced Session inputs](https://github.com/anomalyco/opencode/pull/30785)
- [PR #34917 — instruction belief model](https://github.com/anomalyco/opencode/pull/34917)
- [PR #34945 — prompt context](https://github.com/anomalyco/opencode/pull/34945)
- [PR #34962 — log/change/snapshot synchronization proposal](https://github.com/anomalyco/opencode/pull/34962)
- [PR #35040 — deterministic log synchronization](https://github.com/anomalyco/opencode/pull/35040)
- [Issue #35014 — event protocol review](https://github.com/anomalyco/opencode/issues/35014)
- [PR #35172 — explicit durability](https://github.com/anomalyco/opencode/pull/35172)
- [PR #35218 — lifecycle vocabulary](https://github.com/anomalyco/opencode/pull/35218)
- [PR #35272 — retries/provider/tool settlement](https://github.com/anomalyco/opencode/pull/35272)
- [Issue #35325 — reduce the public error surface](https://github.com/anomalyco/opencode/issues/35325)
- [PR #35371 — compaction as inbox barrier](https://github.com/anomalyco/opencode/pull/35371)
- [Issue #35448 — daemon restart/reconnect trace](https://github.com/anomalyco/opencode/issues/35448)
