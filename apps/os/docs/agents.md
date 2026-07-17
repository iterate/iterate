# Agent Context And Turns

An agent stream is an append-only event journal. Its model-facing memory is a
provider-neutral projection reduced from that journal, not a second message
store. The event contract in
`src/domains/agents/agent-processor-contract.ts` is the source of truth for the
shape.

## One Context Event

Everything the model can see is appended as
`events.iterate.com/agents/context-added`:

```ts
await agentStream.append({
  type: "events.iterate.com/agents/context-added",
  payload: {
    role: "user",
    actor: { type: "user", origin: "web" },
    content: "Please review this change.",
    refs: [
      {
        type: "event",
        streamPath: "/integrations/github/main",
        offset: 42,
        eventType: "events.iterate.com/github/webhook-received",
      },
    ],
    llmRequestPolicy: { behaviour: "after-current-request" },
  },
});
```

The roles are product semantics before they are provider wire roles:

- `system` is the compaction-immune instruction prefix.
- `developer` is compactable application, integration, or agent context in the
  product projection.
- `user` is a human-authored message.
- `assistant` is an earlier model output. Only an assistant item carrying a
  genuine `llmRequestOffset` may request code execution.

Actor metadata records who supplied an item independently of its product role.
An actorless developer item is application- or platform-authored. Before a
provider call, developer items carrying Slack, Telegram, email, GitHub, or
script actors are downgraded to the provider's `user` role. External data
therefore cannot acquire instruction precedence merely because an application
chose to summarize it as developer context. Agent-authored and actorless
developer items remain developer messages. Compaction summaries are the
exception: although structurally recorded as developer history, they project as
provider `user` messages because a faithful summary can quote untrusted
instructions and must not launder them into developer/system precedence. A
script result still counts as agent-loop feedback for the autonomous-turn
circuit breaker; provider trust and turn budgeting are separate decisions.
`refs` point back to richer source events or objects so the model need not
receive an entire webhook. Files are attached directly to the context item.

Agent actors intentionally share one trusted instruction domain within a
project. Sending a message to another agent is an explicit capability call, so
agent-authored developer context remains developer on a native transport and
maps to system on a transport without a confirmed developer role. Do not stamp
an agent actor onto third-party data merely to preserve that precedence.

The payload `key` and the event envelope's `idempotencyKey` are deliberately
different. `idempotencyKey` prevents a processor retry from appending the same
journal event twice and therefore names one exact payload forever. Shipped
policy uses explicit revisioned idempotency keys; changing its content means
bumping the revision and appending a new occurrence. `key` identifies the
logical model-context slot, so that new occurrence supersedes only the prior
value of the same slot while every real update remains in the journal.

## Projection And Publication

Reduced agent state keeps the complete provider-neutral projection:

```text
context
├── system[]      compaction-immune prefix
├── history[]     developer, user, and assistant items
└── publishedThrough
```

There is no sorting or placement field. Requests render the system lane first,
then history. New items otherwise follow stream order within their lane.

A key has one mutable unpublished slot per lane:

1. The first occurrence creates a slot.
2. Any number of updates before an LLM request replace that slot in memory, so
   the model sees only the latest value.
3. `llm-request-requested` publishes the projection through its event offset.
4. The next update to a published key appends a new projected occurrence with
   `updatesOffset` pointing at the previous published occurrence. Further
   updates before the next request coalesce into that new slot.

Replacing an unpublished slot preserves its lane position. Its newer source
offset can therefore appear before a lower offset in the rendered projection;
offsets are journal coordinates, not a presentation sort. Unkeyed context
always appends.

This boundary preserves prompt-cache prefixes: content can settle freely
before any request observes it, but content already sent to a provider is
never rewritten in a later normal request. A compaction request similarly
publishes exactly the prefix through its cutoff. A requested turn that is
later superseded still seals conservatively; this may append an extra update,
but cannot rewrite a request snapshot.

A post-publication system update appends inside the system lane. The old
system prefix remains cacheable, but inserting the new durable instruction
ahead of history invalidates cached history. That is the deliberate cost of
changing durable instructions.

## Request Rendering

Every request starts with one stable system message explaining the context
protocol. Each projected item then has a compact header followed by its
content:

```text
@81 key="github/review-task" updates=@17 refs=["/integrations/github/install-789@240"]
Review pull request #123 at its immutable head. Read the referenced event for the full payload.
```

Only present fields are rendered. The `@offset` is always present, but offsets
need not increase: the system lane renders first and an unpublished keyed slot
keeps its position when its source event changes. Projection order is
authoritative. The adapter keeps this projection provider-neutral. The direct
OpenAI BYOK endpoint preserves `developer` natively; the unified Workers AI
interface and transports without a confirmed developer role conservatively map
trusted developer context to `system`. A timestamp derived from the journaled
request event is appended at the tail so it does not invalidate the cached
conversation prefix. Only the first line is metadata; later content is opaque
even when it begins with `@`, so external text cannot spoof a second item
header.

Request bodies are rebuilt by folding consumed events only through the
`llm-request-requested` offset. Retries of one request therefore see identical
bytes even when later events have arrived.

## Scheduling And Distributed Birth

The public agent birth command is deliberately `agent.create()` with no
arguments. It installs the generic Agent and Capability Host machinery and the
shipped base policy. Caller-selected instructions, model configuration, and
tasks are later stream events. Additional instructions should use their own
context key and therefore compose with the base policy. An explicit event using
the same `agent/system-prompt` key updates that well-known slot; authorization
comes from append access to the stream, not from ownership encoded in the key.
Use `agent.append(...)` for durable Agent-consumed events; its input union is
`ConsumedInput<AgentProcessorContract>`, and runtime validation comes from the
same contract's `parseConsumedInput`. Do not add a wrapper method whose only
job would be to append one event type. `agent.stream.append(...)` remains the
raw shared-stream door for events outside the Agent processor's vocabulary and
intentionally ephemeral events.

User messages, integration-authored developer items, and autonomous
agent/platform feedback have separate turn-budget semantics. `llmRequestPolicy`
decides whether an item wakes the model, waits behind the current request, or
interrupts it; it is not inferred from idempotency-key naming.

Agent birth is distributed: an input can arrive before policy has appended the
base prompt. The processor retains that pending trigger but does not publish a
request until system context keyed `agent/system-prompt` exists. When the
system item arrives, the same trigger is scheduled. A trigger waiting only for
that prompt is queued rather than reported as active/busy work, so a failed
configuration path cannot leave surfaces showing "thinking" forever. This
prevents a first turn from racing ahead with a fallback prompt.

## Compaction

Compaction is an ordinary projection change, not wholesale state replacement:

1. The provider receives the exact request whose usage crossed the threshold,
   byte for byte and through the same model, plus a trailing developer
   instruction asking for a dense summary. If catch-up delivers several
   over-threshold reports in one batch, only the newest request is summarized.
2. The processor appends one developer context item with
   `compaction.replacesHistoryThrough` equal to that request event's offset.
   The same metadata carries normalized summarizer usage when the provider
   reports it; neither field is rendered into model-visible content. Its
   provider role is `user`, so quoted third-party instructions remain memory
   rather than acquiring trusted instruction precedence.
3. The reducer prepends that summary, retains history whose source offset is
   greater than the cutoff behind it, and retains the system lane. Because
   compaction already rebases the cache, it also collapses old occurrences of
   each keyed system item to the latest value; unkeyed system items all remain.

The measured assistant answer and anything arriving while it ran are after the
request cutoff. They survive verbatim behind the summary, so compaction cannot
erase an unanswered mid-turn user message.

The cutoff must be lower than the summary event's own offset. The reducer
ignores a raw malformed compaction item rather than allowing it to erase
future history.

An `updatesOffset` may point to an occurrence no longer in the active
projection after compaction. It remains a valid journal coordinate for audit
and retrieval.

The reduced projection is allowed to be large because compaction normally
bounds it by the model-context policy rather than the lifetime of the stream.
That is an operational target, not a hard schema bound: compaction is
best-effort and unkeyed system content is unbounded. Unbounded material—the
raw journal, webhook bodies, response chunks, and execution evidence—stays in
streams and is referenced by coordinates.

The current generic hosted-processor checkpoint serializes the whole reduced
state into one Durable Object KV value after each batch. That is acceptable at
the present compaction target, but it is not a safe storage shape for a literal
million-token projection: it rewrites the growing value and can exceed the
runtime's per-value limit. If the product raises the retained-context target,
materialize context in chunked rows and keep only lifecycle metadata plus the
projection cursor in the generic checkpoint. The logical `context` state and
provider-neutral rendering boundary do not need to change.

## Production Reset

This contract starts against an empty production data set. Before deploying
it, erase the production OS domain data and recreate production through the
normal recreation procedure, including regenerating project config repos from
the current template. Do not add a journal migration, compatibility reducer,
fallback parser, heal path, or tests for the discarded contract.

The reset and recreation are part of this change's acceptance proof. Verify
that newly created agents contain the v2 birth/config/context events, can run a
script with project capabilities, and leave coherent production traces with no
unexplained errors before declaring the rollout complete.

## Authoring Rules

- Append model-visible information only through `context-added`.
- Use `system` only for instructions that must survive compaction.
- Give human input the `user` role and a user actor.
- Give webhook summaries a typed integration actor and an event ref; keep
  secrets and bulky raw payloads in the referenced event.
- Use a payload key only for a logical value that can be updated. Never use it
  merely as append idempotency.
- Do not add an ordering field. If an item must precede history, it belongs in
  the system lane; otherwise arrival order is the fact.
- Build request behavior from the reduced projection, and test both sides of
  the publication boundary whenever changing projection logic.
