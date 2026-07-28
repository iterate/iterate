# Agent Collection And Runtime Design

This document describes the implemented agent catalog and transient-runtime
architecture. The central rule is simple: the agent catalog is the reduced
state of one ordinary stream processor, not a side database maintained by the
project Durable Object.

## Invariants

1. Every project has one AgentCollectionDurableObject, addressed by the
   project id and the fixed stream path /agents.
2. AgentCollectionRpcTarget.processEvent(batch) is stateless. After checking
   that the caller has trusted stream-delivery authority, it calls the singleton
   collection DO and does nothing else.
3. Every agent stream installs one outbound ITX-expression subscription in its
   creation batch.
   The subscription selects exactly:
   - events.iterate.com/agent/created
   - events.iterate.com/agent/summary-updated

4. The collection DO runs AgentCollectionStreamProcessor over its own /agents
   stream.
5. AgentDatabase is exactly that processor's reduced state.
6. Runtime is direct Agent processor state. There is no runtime journal event,
   and runtime is not copied into the collection.
7. The Project processor and Project DO do not maintain a second agent
   catalog.

## Event Flow

```text
agent stream /agents/<path>
  agent/created
  agent/summary-updated
          |
          | outbound ITX-expression receiver
          | expression: ["agents", "processEvent"]
          | start: beginning
          v
AgentCollectionRpcTarget.processEvent(batch)
          |
          | direct call-through
          v
singleton AgentCollectionDurableObject
  projectId + "/agents"
          |
          | receiveCopiedEvents(batch)
          v
/agents collection stream
          |
          v
AgentCollectionStreamProcessor
          |
          v
AgentDatabase reduced state
```

The source agent's subscription is committed in the same creation batch as
its birth event. Starting at the beginning lets it deliver that birth fact.
Stream-receiver provenance retains the source project, path,
offset, event type, and creation time; the collection reducer derives agent
identity from that provenance rather than trusting a path in the payload.

## RPC And Durable Object Boundary

AgentCollectionRpcTarget resolves the collection DO with:

```ts
{
  projectId,
  path: "/agents",
}
```

Its processEvent method is intentionally only an internal ITX receiver. It does
not fold records, touch Project state, append agent facts itself, or schedule
detached work.

On delivery, the collection DO idempotently appends two pieces of local
infrastructure to its own stream:

- agent-collection/created;
- the normal wake subscription for the agent-collection processor.

It then passes the delivered batch to receiveCopiedEvents. From that point onward the
normal stream processor registry owns wakeup, reduction, durable progress,
snapshot, and live-state publication.

The DO exposes the same conventional surfaces as other processor hosts:

- processor for snapshots and waitUntilProcessed;
- liveState for callback-driven reduced state;
- wakeStreamProcessor and alarm for the processor registry.

## Agent Database

The processor contract's state schema is named AgentDatabase:

```ts
type AgentDatabase = {
  birthCertificate: {} | null;
  agents: Record<AgentPath, AgentCatalogRecord>;
  waitingForSinceOffsets: Record<AgentPath, number>;
};
```

agents is the product-facing catalog. waitingForSinceOffsets is technical
reducer state used to make conditional waiting clears race-safe.

One catalog record contains only facts reducible from the narrow subscription:

```ts
type AgentCatalogRecord = {
  path: AgentPath;
  summary: {
    title?: string;
    description?: string;
    activity?: string;
    waitingFor?: "user_input" | "external_event" | "timer";
    pinned: boolean;
  };
  timestamps: {
    createdAt: string;
    lastWorkAt: string;
    summaryUpdatedAt?: string;
    activityUpdatedAt?: string;
  };
};
```

There is deliberately no runtime or integration binding in this database.
Presentation code may use the wider AgentRecord shape for optional overlays,
but the collection itself returns AgentCatalogRecord.

Summary changes use the ordinary typed append surface:

```ts
await itx.agent.append({
  type: "events.iterate.com/agent/summary-updated",
  payload: { activity: "Researching booze" },
});
```

There is no summary setter or metadata compatibility API. Agents, humans, and
processors append the same event, and the Agent and collection reducers apply
the same update semantics.

### Reduction rules

- agent-collection/created creates the singleton processor.
- A received agent/created creates one row using the source path and event
  creation time.
- A received agent/summary-updated merges the bounded summary update and
  updates summary timestamps.
- A second creation for one path, summary before creation, or received agent
  facts without source-stream provenance are data-model violations and fail
  loudly.
- Exact redelivery is handled by normal copy and processor
  idempotency.

waitingFor clears use the summary event family too. A processor-authored
clear has:

```ts
{
  waitingFor: null,
  clearWaitingForThroughOffset: sourceOffset,
}
```

Both the individual Agent reducer and collection reducer clear only when the
current wait was established at or before that source offset. A stale clear
therefore cannot erase a newer wait, and no third event type is required by
the collection subscription.

## Public Agent Collection Surface

itx.agents exposes:

- get(path) for one agent;
- list() derived from the collection processor snapshot;
- processor for the collection processor;
- liveState for the complete AgentDatabase.

Catalog, sidebar, command-palette, and agent-route consumers subscribe to
itx.agents.liveState. They no longer read ProjectLiveState.agents.

## Transient Runtime

The Agent processor derives exact counts after every consumed event:

```ts
type AgentRuntime = {
  triggers: { pending: number; runnable: number };
  llmRequests: {
    scheduled: number;
    requested: number;
    started: number;
  };
  runningScripts: number;
};
```

When those counts change, the reducer stamps this directly into
AgentProcessorState.runtimeChange:

```ts
type AgentRuntimeTransition = {
  runtime: AgentRuntime;
  sinceOffset: number;
  since: string;
};
```

This is reduced state, not a new journal fact. The Agent DO publishes a small
AgentLiveState containing only runtimeChange; context and history stay behind
the processor snapshot instead of being copied through live state on every
conversation update.

The selected agent conversation subscribes to
itx.agents.get(path).liveState. The browser reducer projects each transition
into transient feed items without writing it to the local journal mirror.
Every current useLiveState value is authoritative and is presented immediately:
non-zero runtime opens or updates the transient work, and zero runtime settles
it. The browser has no offset watermark, idle debounce, handoff window, or
other policy that can reject or delay the live value.

Collection views have only the durable summary. They can show semantic waiting
states, titles, activity, summaries, pins, ancestry, and catalog timestamps;
they do not pretend to have project-wide transient runtime.

## Slack Runtime Presentation

The Agent DO observes committed state changes from the Agent and Slack
processors through the processor registry. It passes the current Agent runtime
transition and current Slack reduced state directly to
SlackAgentProcessor.presentRuntimeTransition.

- Active runtime paints assistant-thread status immediately.
- The current summary activity is preferred; exact runtime supplies a factual
  fallback.
- Zero runtime clears status and the eyes reaction after Slack's one-second
  handoff window.
- Ordinary Slack channels never receive assistant-thread status calls, but
  their eyes reaction is still cleared.
- A newer transition or DO disposal cancels a pending idle paint.
- Processor revival reconciles presentation from current direct state.
- Expected idempotent Slack outcomes are quiet success; unexpected cosmetic
  failures are reported once and settled rather than retried forever.

No Slack processor consumes or emits a runtime journal event.

## Clean Replacement Boundary

This is a clean replacement, not an online migration. Agent streams created by
the new code contain the collection subscription; old streams are not scanned
or backfilled by a compatibility path. Deploying across persistent old state
therefore requires the planned environment recreation.

There is no fallback to the removed Project SQLite agent database, no dual
write, and no tolerated divergence between two catalogs.

## Verification

The implementation is guarded by tests that prove:

- the agent creation batch installs the exact two-event selector and
  ["agents", "processEvent"] ITX receiver address;
- the collection processor folds creation and summary, retains source
  provenance, rejects invalid ordering, and applies conditional waiting clears
  safely;
- routed Slack, Telegram, and email agents receive the collection subscription
  as part of normal vanilla agent creation;
- Project reduced state no longer contains an agent catalog;
- Agent runtime transitions appear in reduced state while no runtime event is
  appended;
- browser runtime projection handles activity, settlement, stale transitions,
  and handoffs;
- direct Slack presentation handles active, delayed-idle, handoff, disposal,
  custom activity, and non-assistant channels;
- generated ITX declarations, Wrangler bindings, type checks, formatting, and
  the full unit suite remain coherent.
