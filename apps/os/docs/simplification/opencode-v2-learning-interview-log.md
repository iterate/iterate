# OpenCode v2 learning interview — append-only log

Started: 2026-07-15 (Europe/London)

Purpose: grill Jonas on which OpenCode lessons Iterate should adopt, reject, or investigate. This file is append-only. Each round preserves Jonas's response verbatim, then records an explicit interpretation, tension, decision, or follow-up. Later clarification may supersede an earlier interpretation, but earlier text is never rewritten.

Background:

- [Chronological OpenCode research](./opencode-v2-research-log.md)
- [Consolidated architecture assessment](./opencode-v2-architecture-assessment.md)

## Entry 001 — request to begin the interview

### Jonas, verbatim

> OK can you now grow me and keep a log of what I say on things we maybe could learn from OpenCode or not? I don't know.

### Working interpretation

“Grow me” is understood phonetically as “grill me.” The uncertainty is part of the task: the interview should expose preferences and contradictions rather than ask Jonas to arrive with a settled list. Questions should force architectural tradeoffs, one at a time, and distinguish adopting an invariant from copying an implementation.

## Entry 002 — question: is the journal sufficient authority?

### Question

Iterate says state is a fold over the append-only journal and checkpoints are disposable. OpenCode compromises that in its fork: replaying the child can consult the parent's current projection and produce a different result later.

Would you make this a hard Iterate invariant—**a Stream plus immutable referenced content must always be sufficient to reconstruct its semantic state without reading another live projection**?

Saying yes means accepting larger self-contained facts/snapshots, retaining historical decoders, and treating cross-stream projections as rebuildable indexes. Saying no permits cheaper lineage references and authoritative materialized views, but “refold” is no longer local or necessarily time-stable.

## Entry 003 — correction: make the grilling concrete; account for the config repo

### Jonas, verbatim

> Sorry can you make this more concrete? This is a super abstract question. In general just give examples and code snippets and so on in this grilling. This breaks my brain otherwise. I think one thing to bear in mind is that we also have the config repo. An interesting consideration is whether the state of the config, the hash of the config repo, should be sort of dragged around at all times or something like this. Because a config repo is not a stream

### Working interpretation

The interview protocol changes here: every architectural question should start with a specific scenario and include pseudocode or a data-shape example. Introduce at most one primary decision per round. Avoid asking Jonas to decide from architecture vocabulary alone.

The config repository exposes an important split hidden by Entry 002: reconstructing the **recorded conversation state** is different from reproducing the **computation that produced it**. The transcript may fold without config, while replaying an agent or processor faithfully may require the exact config commit. Git commits are immutable, content-addressed references even though the config repo is not itself an Iterate Stream.

## Entry 004 — revised question: which config should a conversation fork execute?

### Concrete scenario

At 10:00, config commit `aaa111` defines the agent's prompt and tools. The agent produces offsets 1–60 of conversation `agent/alice` under that config. At noon, the config repo advances to `bbb222`, changing the prompt and removing a tool. A user then forks the conversation at offset 40 and says, “Try a different approach.”

The transcript prefix is the same in all cases. The concrete choice is which config the **next agent run on the fork** uses:

```ts
type ConversationForked = {
  childStreamId: StreamId;
  parent: {
    streamId: StreamId;
    throughOffset: 40;
  };

  // Which of these semantics do we want?
  config: { mode: "inherit"; commit: "aaa111" } | { mode: "upgrade"; commit: "bbb222" };
};
```

We do not necessarily need the config hash on every tool-call or token event. It could be pinned once per execution and inherited through `runId`:

```ts
type AgentRunStarted = {
  runId: RunId;
  conversationStreamId: StreamId;
  configCommit: GitSha;
};

type ToolCallCompleted = {
  runId: RunId; // resolves transitively to the pinned config commit
  toolCallId: string;
  output: unknown;
};
```

### Question

When a user forks at offset 40, should the new run default to:

1. `aaa111` — inherit the original config, so “fork” means continue the historical world faithfully;
2. `bbb222` — use current config, so “fork” means reuse the transcript but run today's agent; or
3. require an explicit choice, with the chosen commit recorded once on `AgentRunStarted`?

Separately, does the proposed **once-per-run** config pin feel sufficient, or is there a concrete reason the Git SHA must be copied onto every emitted event?

## Entry 005 — park forking and switch to a guided OpenCode tour

### Jonas, verbatim

> I don't know. I think this is a little bit abstract. I'm not sure this is a real thing. Can you walk me through the other stuff related to open code that I think you think would be interesting to discuss? Like ideas and pros and cons, etc. Just continue. Let's back out of this fork and we know it's an issue. Let's put a pin in it.

### Working interpretation

Fork semantics and config provenance are now explicitly **parked, unresolved**. They are known design issues, but the interview should not manufacture a decision before a concrete product need makes the choice real.

The format changes again: guide the discussion through source-backed OpenCode ideas one at a time. For each idea, show a normal product scenario and small code/data shapes, explain what OpenCode chose, compare Iterate's current shape, and state practical benefits, costs, and a tentative recommendation. Ask for reaction only after the idea is understandable on its own.

Planned non-fork sequence:

1. Agent definition versus conversation and execution state.
2. Durable input admission, Steps, attempts, and stable IDs.
3. Replay-to-live log synchronization.
4. Plugin contribution generations versus config Worker deployments.
5. Durable event catalog/version governance.
6. Persistence and consequence atomicity.
7. Race-shaped and crash-shaped testing.
8. Permissions, tools, and delegated subagents.

## Entry 006 — guided topic 1: an Agent definition is not the running Agent

### Concrete OpenCode idea

OpenCode makes an Agent a declarative profile: prompt, preferred model, permissions, visibility, and limits. A Session owns the conversation. A Step is one execution using a resolved profile. Changing the profile affects later Steps; it does not rewrite the definition used by completed Steps.

```ts
type AgentProfile = {
  id: "reviewer";
  systemPrompt: string;
  preferredModel?: string;
  permissions: PermissionRule[];
  maxSteps?: number;
};

type Session = {
  id: string;
  messages: Message[];
};

type StepStarted = {
  stepId: string;
  sessionId: string;
  profileId: "reviewer";
  profileDigest: string;
  selectedModel: string;
};
```

Iterate's Agent processor currently owns both categories: durable runtime facts such as model-visible history, pending work, attempts, usage, and obligations, but also configuration such as prompt and model choice. The useful OpenCode lesson is not to replace the durable processor. It is to add a small declarative profile layer above it, likely compiled from the config repo, and resolve that profile when a Step begins.

### Practical upside

- Writing a new Agent becomes “declare policy and capabilities,” without understanding the processor's recovery state machine.
- The same runtime can execute many Agent profiles.
- Config/plugin contributions can compose into a visible effective profile with provenance.
- A completed Step can say exactly which resolved profile/model/authority it used.

### Practical downside

- Iterate would gain another named concept and resolver.
- Prompt/model/capability defaults could accidentally exist in several places.
- Composition precedence must be deterministic and inspectable.
- OpenCode itself demonstrates the danger: some profile fields exist in its schema but are not yet honored by its runner.

### Tentative Iterate translation

```ts
export const reviewer = defineAgentProfile({
  id: "reviewer",
  system: reviewerPrompt,
  model: { preference: "reasoning" },
  capabilities: {
    allow: ["project.files.read", "github.pullRequest.read"],
    deny: ["project.files.write", "github.pullRequest.merge"],
  },
});

// The existing Agent processor still owns history, recovery, and effects.
type AgentStepStarted = {
  stepId: string;
  profileId: "reviewer";
  profileGeneration: string;
  profileDigest: string;
  model: string;
  authorityDigest: string;
};
```

Tentative recommendation: steal this separation as an **authoring layer**, while keeping Iterate's durable Agent processor as the execution substrate. Do not make `AgentProfile` another long-lived mutable aggregate.

## Entry 007 — correction: an Iterate Agent is its events

### Jonas, verbatim

> I don't agree with this. Naming is one thing. It's kind of irrelevant but the main thing is an agent is just a set of events, okay?

### Corrected interpretation

Yes. Entry 006 made the wrong architectural translation by introducing an `AgentProfile` as though it were a second kind of Agent object. In Iterate, the Agent is the events on its Stream. Its state, pending work, prompt, selected behavior, and history are projections of those events; they are not properties of a separate long-lived runtime or profile object.

```ts
const agentAt = (events: AgentEvent[], offset: number) =>
  events.slice(0, offset + 1).reduce(processEvent, initialAgentState);
```

A config-repo helper could still provide naming or authoring convenience, but only by producing commands/event inputs or projections. It must not become another authority that the runner consults instead of the Agent's events:

```ts
// Acceptable as convenience: this resolves to event inputs.
await createAgent("reviewer");

// Conceptual result:
await agent.append([
  { type: "agent-created", data: { name: "reviewer" } },
  { type: "system-prompt-set", data: { text: reviewerPrompt } },
  { type: "model-selected", data: { model: "reasoning" } },
]);
```

Therefore the proposed first-class profile/runtime split is **rejected as an Iterate architectural lesson**. At most, OpenCode's profile mechanism suggests surface-level naming/composition ergonomics that compile into events. It does not alter what an Agent is.

## Entry 008 — guided topic 2: distinguish accepting input from acting on it

### Concrete scenario

An Agent is already generating an answer. The user sends, “Stop—run the tests first.” The server acknowledges the message, then the Agent host crashes before another model request begins.

There are at least two different facts:

1. the Agent durably received the user's input;
2. a particular execution actually incorporated that input.

OpenCode v2 makes this distinction explicit through its durable inbox, promotion into a Step, and attempt/tool settlement identities. An Iterate-shaped event vocabulary could express the same distinction without introducing another Agent object:

```ts
type AgentInputAdded = {
  inputId: string;
  delivery: "queue" | "steer";
  content: AgentInputItem[];
};

type AgentStepStarted = {
  stepId: string;
  inputIds: string[];
};

type AgentAttemptStarted = {
  stepId: string;
  attemptId: string;
  attempt: number;
  model: string;
};
```

After the crash, folding the events can answer precisely: input `input-17` was accepted, but no Step yet incorporated it. If a provider request fails and is retried, both attempts belong to one semantic Step but have different `attemptId`s.

### Potential upside

- An acknowledged user input cannot become ambiguous after a crash.
- Queue versus steer behavior is explicit data rather than implicit timing.
- UI logs, provider traces, tool results, usage, and retries can refer to stable semantic IDs.
- An event offset remains causation/audit position without also serving as the identity of every higher-level concept.

### Potential downside

- More IDs and event types can restate information already implied by ordered offsets.
- “Step” and “attempt” become platform vocabulary that must remain stable.
- If no real consumer needs to correlate these things across retries or Streams, the extra identity layer is ceremony.

### Tentative recommendation

Keep the Agent-as-events model. Investigate only whether the current use of event offsets as input/request/execution identity creates concrete ambiguity in steering, retries, traces, or cross-Stream references. Introduce `inputId`, `stepId`, or `attemptId` only where a real lifecycle cannot be named cleanly with the existing events and offsets.

## Entry 009 — interview leadership rule

### Jonas, verbatim

> Okay crack on. Never just say something. Always then always needs to be its next step and next question and so on. We really lead here.

### Working interpretation

This is a standing protocol for the remainder of the interview: the assistant owns sequencing and momentum. Every response must do more than acknowledge or summarize. It must advance to the next OpenCode lesson, make the next issue concrete, and end with a focused next question for Jonas. Do not ask Jonas to choose the agenda.

## Entry 010 — guided topic 3: replay history, mark the boundary, then follow live

### Concrete race

A browser has processed an Agent Stream through offset 100. It reconnects while the durable head is 150 and wants both the missing history and new live events.

The naïve ordering loses an event:

```ts
const history = await stream.read({ after: 100 }); // returns through 150
// Event 151 commits here.
const unsubscribe = stream.onEvent(render); // too late: 151 was missed
```

Reversing the order avoids the loss but introduces buffering, duplicate suppression, and an unclear moment when the UI has caught up.

OpenCode's durable Session log uses this protocol:

```text
install wake listener
capture durable head H = 150
read durable rows (100, 150]
emit synced(150)
on every wake, re-read durable rows after lastSeen
```

If event 151 commits during replay, the wake is merely a hint to query durable storage again. The in-memory notification is never the only copy. Even an empty Stream emits `synced(H)`.

An Iterate API could make the safe ordering impossible to get wrong:

```ts
for await (const item of stream.replayThenFollow({
  afterOffset: 100,
  durableOnly: true,
})) {
  if (item.type === "event") render(item.event);
  if (item.type === "synced") markUiCurrentThrough(item.throughOffset);
}
```

### Potential upside

- One race-tested primitive for the Agent UI, itx clients, and subscription consumers.
- Consumers know exactly when historical replay is complete; they do not infer it from timeouts or an empty page.
- Slow clients cannot lose committed events because wakes cause durable rereads.
- Reconnect behavior can be tested deterministically at the replay/live boundary.

### Potential downside

- `synced(150)` means only “all selected durable events through 150 have been emitted”; it does not mean downstream effects are complete.
- Iterate's ephemeral events create offset gaps, so the marker must name the last durable boundary or explicitly permit gaps.
- If the existing Stream subscription handshake already exposes this exact guarantee, a new API would duplicate it rather than improve it.

### Tentative recommendation and next question

This is one of the strongest small ideas to steal: put the wake-installation, target capture, paging, and `synced` marker inside one Stream-owned primitive.

Concrete question: when an Agent UI reconnects after offset 100, do we already have one API that guarantees it receives every durable event through a fixed head, then an explicit caught-up marker, then every later event? If not, should `replayThenFollow()` with `synced(throughOffset)` become that canonical API?

## Entry 011 — correction: inspect the production path before asserting a replay/live race

### Jonas, verbatim

> Can you just read how this actually works in production right now and you will see that this is an incredibly dumb comment? I don't think the error you were thinking of can happen in our architecture.

### Investigation obligation

The generic `read()` followed by `subscribe()` example in Entry 010 was asserted without first tracing Iterate's actual production UI, API, subscription, Stream, and processor-host path. Treat the claimed race and the tentative `replayThenFollow()` recommendation as retracted pending source inspection.

Before drawing the next comparison, map the real production modules and callers using Iterate's domain vocabulary, identify the precise authority and handoff mechanism, and construct an actual interleaving from the code. If no loss interleaving exists, record why it is impossible and identify whether OpenCode's `log.synced` supplies any remaining benefit at all.

## Entry 012 — production result: the proposed replay/live gap does not exist

The source inspection used production tag `v2026-07-14-21-00-56` (`7b106d623`), then checked the relevant files against fetched `origin/main` (`b560198aa`). They are unchanged. Entry 010's proposed missing safety primitive is **rejected**, not merely downgraded.

The browser does not perform the naïve `read(); subscribe()` sequence from Entry 010. Its actual shape is:

```ts
const checkpoint = await processor.snapshot();

// Only when far behind: page, ingest, and persist each page.
let catchUpOffset = checkpoint.offset;
while (farBehind(catchUpOffset, serverHead)) {
  const page = await stream.getEvents({
    afterOffset: catchUpOffset,
    includeEphemeral: true,
  });
  await processor.ingest({ events: page, streamMaxOffset: serverHead });
  catchUpOffset = page.at(-1)!.offset;
}

await stream.subscribe({
  replayAfterOffset: catchUpOffset,
  processEventBatch,
});
```

That pull phase is an optimization, not the correctness handoff. The subscription replays from the last successfully persisted offset, so an event committed between the final pull and `subscribe()` is inside the replay range.

Inside the Stream Durable Object, `subscribe()` synchronously calls `StreamSubscribers.openEphemeral()`. The shared connection path establishes the ordering:

```ts
let cursor = replayAfterOffset;
const connection = { wake: () => void pump() /* ... */ };

connections.set(subscriptionKey, connection);
appendSubscriberConnectedFact();
connection.wake(); // immediate replay batch
```

Every append commits its rows and then calls:

```ts
for (const connection of connections.values()) connection.wake();
```

The pump repeatedly reads the journal after its cursor until empty. The possible interleavings are therefore covered:

- append before `connections.set` -> the first replay query reads it;
- append after `connections.set` -> append wakes that installed connection;
- append while the pump is draining -> the pump loops and reads again after its yield;
- append after the pump returns -> the append starts another pump.

There is no asynchronous gap between the empty-read decision and the pump returning in which the same Durable Object can run an append. Wakes are only scheduling; the journal and cursor are the truth.

The initial batch is also already the synchronization boundary Entry 010 was looking for. It is delivered immediately even when it contains zero selected events, and it carries `state` plus `streamMaxOffset` captured in the same synchronous block. Hosted processors checkpoint the consumed prefix and call `reconcile()` only when `checkpointOffset >= streamMaxOffset`; a trailing unfiltered catch-up handles a filtered batch whose checkpoint is behind the raw durable head. The browser serializes OPFS/SQLite ingest and, on ingest failure or a dead connection, reconnects from the persisted processor checkpoint.

OpenCode's `log.synced(H)` remains a good description of OpenCode's own fixed-target log protocol. It does **not** close a correctness hole in Iterate. The only plausible translation is optional UI vocabulary such as “the mirror has ingested through head H,” derived from the existing batch/checkpoint coordinates. That would be presentation sugar, not a new Stream primitive.

### Next investigation

The next OpenCode comparison will be the config-repository activation boundary, but it must start from production code rather than the abstract word “plug-in.” Trace this exact case: config commit A is serving and processing project events; commit B builds; an event commits during replacement. Determine which revision receives it, whether A and B can both receive it, whether neither can, and where the durable cursor lives. Only then ask whether OpenCode's scoped generation/rollback algebra buys Iterate anything.

## Entry 013 — guided topic 4: the config repo is late-bound code, not a deployed generation

The production trace again changes the abstraction. There is no single active “config generation” through which all project event traffic passes.

Every project-scoped Stream is born with this ordinary durable fact before a user event can land:

```ts
{
  type: "events.iterate.com/stream/subscription-configured",
  payload: {
    subscriptionKey: "project-worker",
    delivery: { mode: "push", expression: ["processEventBatch"] },
    deliver: "all",
    onPoison: "skip",
  },
}
```

Each source Stream owns a separate SQLite cursor for that subscription. Its push drain reads after `ackedOffset`, awaits `ProjectRpcTarget.processEventBatch(batch)`, and only then writes a fenced ack. The project RPC target delegates to `this.worker.processEventBatch(batch)`. `this.worker` constructs the default stateless ref to `/repos/config/worker.ts` with no pinned commit and no build budget. On every invocation the dynamic worker runner calls the loader, which resolves the branch head at that moment:

```ts
const head = await repo.getHead();
const source = { branch: head.branch, commitOid: head.commitOid /* ... */ };
const artifact = await buildOrReadContentAddressedArtifact(source);
const entrypoint = load(artifact);
await entrypoint.processEventBatch(batch);
```

The resolved commit is immutable for that one invocation. `IterateWorkerEntrypoint.processEventBatch` then awaits the events sequentially inside that same loaded entrypoint. The relevant deployed files are unchanged on current `origin/main`.

### Concrete revision outcomes

Suppose source Stream `/orders` has event `X@42`, A is the old config commit, and B is the new commit.

```text
X commits -> invocation resolves A -> B commits -> A returns
                                                   -> cursor acks X; B never sees X

X commits -> B commits -> invocation resolves branch head
                         -> B handles X even though X predates B

X commits -> invocation resolves A -> A performs an effect -> A rejects
          -> B commits -> retry resolves B
                       -> B receives the same X and the same delivery identity

/orders invocation resolves A  ||  /github invocation resolves B
```

Therefore revision choice is **attempt-time**, not event-commit-time. A successful delivery cannot be received by both revisions because its source cursor advances after A or B resolves. An unsuccessful delivery can cross revisions on retry, which is normal at-least-once behavior and is why `${event.path}@${event.offset}` and `deliveryId` exist. Separate Streams can concurrently execute different commits because they have separate Durable Objects, cursors, and invocations. There is no project-wide atomic cutover.

OpenCode's process-local plug-in generation swap does not fix any of those distributed facts. It can make a catalog replacement internally coherent, but it cannot retroactively atomically switch an already-running A invocation, several Stream cursors, or an external side effect.

### The real failed-generation defect

A narrower part of OpenCode's rollback behavior does translate. OpenCode keeps the previous plug-in generation when the candidate cannot activate. Iterate's default stateless worker does not retain a last-known-good active artifact. More importantly, its error taxonomy currently distinguishes only the bootstrap cases:

```ts
if (isRepoNotSeededError(error) || isWorkerBuildInProgressError(error)) {
  throw new StreamReceiverUnavailableError(/* ... */);
}
throw error;
```

A real TypeScript/bundler/materialization failure is the final `throw error`. The project-worker subscription has `onPoison: "skip"`, so the spine treats this receiver-wide failure as though individual events might be poison. The production unit test for “receiver is down” proves the exact outcome: after bisection and three confirmations per event, offsets 1 and 2 are skipped; the third consecutive poison verdict parks the subscription at offset 2. This prevents mass loss but still loses two healthy event deliveries. The `StreamReceiverUnavailableError` tests prove the desired fail-closed behavior: keep the whole batch, move no cursor, retry, then park after the receiver-outage limit with zero skips.

Two fixes are now concrete:

1. **Minimum correctness fix:** give build/load/materialization failures a stable error type and translate it to `StreamReceiverUnavailableError`. A bad config commit blocks and eventually parks the feed but cannot diagnose healthy facts as poison.
2. **Availability policy:** retain a per-project last-known-good artifact. Build B as a candidate; activate it only after materialization succeeds; otherwise keep serving A and surface B as rejected. This borrows OpenCode's failed-generation rollback without pretending it supplies an atomic cross-Stream barrier.

Revision provenance is still useful for traces and for the rare reaction whose audit must say which code ran. It should be supplied by the worker runtime, not copied onto every Agent event. Agent configuration already materialized as Agent events is pinned by those facts; the config repo is not a second Agent authority.

### Next concrete question

Take a syntax error committed to `worker.ts` while three GitHub webhook facts are waiting. Today two can be skipped and the feed parks on the third. The minimum fix is unambiguous: **zero skips**. The next product choice is whether the facts should wait behind broken B, or whether last-known-good A should continue reacting while B is visibly rejected.

My recommendation is to land the fail-closed error classification independently, then test last-known-good as an explicit availability policy rather than silently changing semantics. The focused question is: for a broken config commit, do you expect project reactions to stop loudly until repaired, or should the last buildable commit keep handling new facts?
