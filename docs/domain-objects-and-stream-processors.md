# How to think about domain objects and stream processors

Owner doctrine, updated 2026-07-15 after surveying every hosted stream
processor. This is the convention for durable domain objects on this platform.

For the practical half—side-effect guarantees, the obligation
pattern, eviction recovery, staleness policy, and the node test harness—see
[Writing and testing stream processors](writing-stream-processors.md).

## A stream path is an address, not a processor declaration

Creating or subscribing to a stream does not make the stream an agent, repo,
router, or any other domain object. The path is only an address. The processor
identity and its creation mechanism are explicit and orthogonal to that
address.

This distinction matters for nested paths. `/agents/slack` can be a container
for streams below it without itself being an agent. Likewise, no code should
infer an "agent kind" from a path: one agent may span Slack, GitHub, and other
facets. A facet exists because its own birth event and processor subscription
were appended, not because its stream happens to match a prefix.

Capability inheritance follows the same rule. A read passes through an
uncreated container scope on its way to the next enclosing born host, while
writes and script execution at a scope still require that capability host's
explicit birth. Namespace folders therefore need no synthetic domain object.

`get(path)` therefore only returns an addressable handle. It never creates
anything. Mutation hangs off that handle:

```ts
const agent = itx.agents.get("/agents/researcher");
await agent.create();
await agent.append({
  type: "events.iterate.com/agents/context-added",
  idempotencyKey: "researcher-role:v1",
  payload: {
    role: "system",
    key: "agent/researcher-role",
    content: "You are the project's research specialist.",
  },
});
await agent.message("Start the research");
```

This is why the API is `agents.get(path).create()`, rather than
`agents.create(...)`: addressing and existence remain separate, and every
subsequent operation uses the same path-bound handle.

## Creation is an explicit birth certificate

Every hosted domain processor owns a distinct past-tense `*/created` event.
Its payload contains only immutable facts required for that domain object to
exist, and no generic identity fields. Many processors use a `{ config }`
shape; an existence-only birth can be empty:

```ts
{
  // domain-owned immutable birth facts, if any
}
```

Path, parent path, and "kind" do not belong in this generic shape. Paths come
from event/source coordinates. The Agent birth is deliberately `{}`: model
configuration and prompt context are mutable stream events, not birth facts.
The reducer stores the exact payload in `state.birthCertificate`.

The birth must be the first event in that processor's domain history. A
physical stream has its infrastructure-level `stream/created` record first,
and a shared stream may contain sibling processors' births, but a valid domain
processor never receives one of its own ordinary domain events before its own
birth.

Subscriptions are deliberately appended after the births and setup events in
a creation batch. A newly installed durable subscription catches up from the
beginning of the stream, so late subscription does not lose earlier events.
The birth-first ordering is established by the creator's atomic append, not by
timing between append and subscription delivery.

### The processor-author convention

There is no host abstraction that guesses this lifecycle. Each processor says
the rule plainly in its normal reducer and side-effect hook:

```ts
const State = z.object({
  birthCertificate: BirthCertificate.nullable().default(null),
  // ordinary reduced state
});

reduce({ state, event }) {
  switch (event.type) {
    case "events.iterate.com/widget/created":
      if (state.birthCertificate !== null) {
        throw new Error("widget received more than one created event");
      }
      return { ...state, birthCertificate: event.payload };

    // Ordinary events are reduced here, in the same monolithic reducer.
    case "events.iterate.com/widget/renamed":
      return { ...state, name: event.payload.name };

    default:
      return state;
  }
}

processEvent({ state, event }) {
  if (event.type === "events.iterate.com/widget/created") {
    // Optional birth reactions belong here.
    return;
  }
  if (state.birthCertificate === null) return;

  // Ordinary actions are allowed only after birth.
}
```

Reducers still fold ordinary events before birth; they do not need a second
dispatcher or a `reduceConfiguredEvent` abstraction. The pre-birth guard is
only around actions. Command/RPC methods that require a live object assert
that `birthCertificate !== null` and fail clearly when called too early.

A second distinct birth is a corrupt journal and MUST throw. Retrying the same
create command with the exact same batch is different: creators use stable
idempotency keys, so the stream append deduplicates the retry and the processor
still sees exactly one birth. Reusing a key for a different type, payload,
metadata, or durability is rejected rather than silently returning the first
event. Reducer leniency must never hide two actual `*/created` records.

`create` ensures existence; it does not apply later configuration or
context. Once a birth exists, a repeated call waits through the already
observed creation boundary and returns without rebuilding mutable setup.
Concurrent first creators may both observe `null`; their identical,
idempotency-keyed batches safely converge, while different batches fail
loudly. Policy changes after birth are new domain events.

### Creation commands own the whole birth batch

A public `create` command appends everything universally required for the
object—not just its one birth—including sibling processor births, setup facts,
and explicit processor subscriptions. It then calls `waitUntilProcessed` on
the processors it created through the final offset in that batch. Returning
from `create` therefore means later command calls observe the birth and setup.

An agent creation batch is the reference shape:

1. existence-only `agent/created` with payload `{}`;
2. `capability-host/created` for the same stream;
3. ordinary `agent/configured` model policy and keyed system-context events;
4. the workspace capability and boot-context setup events;
5. explicit Agent and Capability Host subscriptions;
6. `waitUntilProcessed({ offset: finalBatchOffset })` on both processors.

Agent `create()` deliberately takes no arguments. It establishes only the
shipped defaults and machinery above; caller-selected context, model
configuration, and tasks are ordinary events appended afterwards through
`agent.append(...)` or a higher-level helper. This keeps an agent's birth independent of
the caller that happened to win the creation race. The default model and base
prompt are still visible as events rather than hidden properties of birth.

Post-creation events own their own retry contract. Give durable startup facts
an explicit revisioned idempotency key, and retry the append independently if
a process fails between `create()` and `append()`. One idempotency key names
one exact event payload forever; when shipped policy content changes, bump its
revision and append the new occurrence. Onboarding follows this pattern: it
ensures the generic agent exists and then always appends the same revisioned
prompt and kickoff facts, so retries and concurrent callers converge. A keyed
context item composes with every differently keyed item; it supersedes only
the prior item with the same key. `agent/system-prompt` is the well-known
readiness and execution-policy slot, not a separate authorization mechanism:
any project member with access to that stream can intentionally update it.
Additional instructions should normally use their own key so they compose.

Transport routers use the same batch shape when they create routed agents,
with one additional facet birth and subscription. Their source webhook is
appended after all births and setup in that same destination-stream batch.

Some objects have asynchronous provisioning after birth. They use a separate
`*/ready` fact rather than stretching the meaning of `*/created`. Project and
Repo are the current examples. Their public create APIs may additionally wait
for readiness when their caller needs a usable provisioned result.

## Prefer a typed append door to one-event wrapper methods

Every durable domain object should normally expose `append(...)` as its direct
event-writing API. Derive its input from the processor contract rather than
hand-copying a union:

```ts
type WidgetEventInput = ConsumedInput<WidgetProcessorContract>;

async append(...events: WidgetEventInput[]): Promise<StreamEvent[]> {
  await this.assertCreated();
  return this.stream.append(
    ...events.map((event) => WidgetProcessorContract.parseConsumedInput(event)),
  );
}
```

`ConsumedInput<Contract>` resolves every payload from the event catalog and
the exact `consumes` tuple. `parseConsumedInput` is its runtime twin, so an RPC
caller cannot send a merely resolvable but unconsumed event after TypeScript is
erased. The resulting input requires each contract payload and excludes
`ephemeral: true`, because a durable wake processor cannot receive ephemeral
rows. Call the raw stream door for events outside that processor's vocabulary
or for intentionally ephemeral events.

This derived union proves durable shape and processor vocabulary, not that an
event is a valid next state transition or has particular provenance. It does
not create a privileged append lane: anyone with access to the containing
project can append any event type through the raw stream API, and a valid
matching event has the same reducer meaning whichever append API wrote it.
`create()` remains the normal birth path, and higher-level methods remain
responsible for coordinated lifecycle invariants; a low-level caller can still
append a second birth or an unmatched completion and make the reducer reject
the journal. Do not misdescribe `ConsumedInput` as a command-state validator
or an authorization boundary.

Do not add `configure()`, `rename()`, `setFoo()`, or one method per event when
the implementation would only wrap `stream.append({ type, payload })`. Those
methods duplicate the event schema, hide the journal model, and drift when the
contract changes. A higher-level method earns its place when it adds real
domain semantics—encryption, external I/O, attachment storage, provenance,
multi-stream coordination, birth/readiness waits, or another invariant that
cannot be expressed by validating and appending the event itself. Convenience
helpers may build on `append`; they are not a substitute for the typed door.

This is an API-shape rule, not merely an implementation preference. Do not
expose a domain object that has only `setName`, `addContext`, and similar
event-shaped commands while hiding its journal vocabulary. The mechanically
derived typed `append` is the primary mutation contract; named methods are
reserved for operations that actually coordinate more than validation plus
one append.

## Configuration after birth

A birth certificate holds only the immutable facts required for existence.
Configuration that may change is an ordinary domain event, not another birth
and not a universal framework method. Agent's birth is empty; its creation
batch establishes the default model with `agent/configured`, and callers can
append the same event type later to change model policy:

```ts
await agent.append({
  type: "events.iterate.com/agent/configured",
  idempotencyKey: "researcher-model:v1",
  payload: { config: { llm: { model: "openai/gpt-5.6-sol" } } },
});
```

Additional instructions are keyed `agents/context-added` events, as in the
earlier example. Use a distinct key to compose; reusing a key explicitly
supersedes only that context item.

`agent.append(...)` follows the general pattern above: its `AgentEventInput`
is `ConsumedInput<AgentProcessorContract>`. Use the lower-level
`agent.stream.append(...)` only when intentionally writing an event outside
the Agent processor's vocabulary or an ephemeral event to the shared stream.

Config patches use `mergeProcessorConfig` with these exact rules:

- plain JSON objects merge recursively;
- omitted keys retain their current values;
- arrays, scalars, and `null` replace the old value wholesale;
- the processor validates the complete merged value with its full config
  schema before storing it.

Facet processors whose config is immutable simply keep it in their birth
certificate. A processor may define its own later config events when the
domain needs them; for example, Sandbox has `sandbox/configured`. We do not
invent a generic `configure()` RPC merely to wrap ordinary appends.

## Empty-state contract cutovers stay empty-state

When a contract change is paired with deleting and recreating production data,
do not add migration readers, compatibility reducers, fallback parsers, heal
paths, or tests for the discarded contract. Those mechanisms create a second
behavioral mode that the rollout explicitly does not need. Treat the data reset
and recreation as part of the change's acceptance proof, then test only the
new contract against the new state. Agent v2 follows this rule; its production
procedure is documented in
[Agents: Production Reset](../apps/os/docs/agents.md#production-reset).

## Catalogs list domain births, not path prefixes

The Project processor keeps two independent projections:

- `state.streams` records physical streams from `stream/created` and
  `stream/child-stream-created`;
- `state.agents`, `state.repos`, and `state.secrets` record cross-posted
  domain `*/created` events.

The domain path comes from the event's processor/cross-post provenance, not
from a made-up field in the birth payload. A router or domain processor that
creates a catalogued object cross-posts that object's birth to `/`. As a
result, a container stream such as `/agents/slack` appears in the physical
stream tree but not in the agent catalog unless an `agent/created` fact
actually exists on it.

## Survey of domain processor contracts

The table records the creation owner as of 2026-07-15. "Router" means a
processor that creates a destination stream batch while handling an ingress
event; it does not mean the destination path implicitly selects a processor.

| Processor                 | Birth                     | Who appends it                                                                                        | Other creation work                                                                                                                                                                                                  |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project                   | `project/created`         | `session.projects.create(...)`                                                                        | Subscribes Project; Project's birth reaction creates the root Capability Host, primary Scheduler, config Repo, and Email router. `project/ready` follows config-repo and worker readiness.                           |
| Repo                      | `repos/created`           | `project.repos.get(path).create(...)`, global repo creation, or Project bootstrap for `/repos/config` | Appends `repos/create-requested`, subscribes Repo, provisions the artifact, cross-posts its birth to `/`, then emits `repos/created`.                                                                                |
| Agent                     | `agent/created`           | `project.agents.get(path).create()` or a Slack/Telegram/Email router                                  | Creates the paired Capability Host, setup events, and subscriptions; cross-posts its birth to `/`. Caller-selected context/configuration is appended afterwards.                                                     |
| Capability Host           | `capability-host/created` | Agent creation, Project bootstrap for `/`, or `capabilityHosts.get(path).create()`                    | Subscription is explicit; standalone create waits through its batch.                                                                                                                                                 |
| Scheduler                 | `scheduler/created`       | Project bootstrap or `schedulers.get(path).create()`                                                  | Subscription is explicit; create waits through its batch.                                                                                                                                                            |
| Secret                    | `secret/created`          | `secrets.get(path).create(...)`; integration connection setup uses that same Secret DO API            | Encrypts material before append, subscribes Secret, waits for processing, and cross-posts the birth to `/` without plaintext material.                                                                               |
| Email router              | `email/created`           | Project birth reaction on `/integrations/email`                                                       | Subscribes Email. Raw email ingress only appends `email/received`; it never creates the router.                                                                                                                      |
| Email agent facet         | `email-agent/created`     | Email router when it resolves a new inbound thread, or the first outbound send from an existing agent | New routed threads share a stream with Agent and Capability Host; outbound binding adds only the Email facet to an already-created agent. In both cases the facet birth precedes route context and subscription.     |
| Slack router              | `slack/created`           | Slack connection setup on `/integrations/slack/<connection>`                                          | Connect setup appends the router birth, subscription, then the provider-connected fact.                                                                                                                              |
| Slack agent facet         | `slack-agent/created`     | Slack router when it resolves a new thread                                                            | Shares a stream with Agent and Capability Host; config names the explicit connection/channel/thread.                                                                                                                 |
| Telegram router           | `telegram/created`        | Telegram connection setup on `/integrations/telegram/<connection>`                                    | Connect setup appends the router birth, subscription, then the provider-connected fact.                                                                                                                              |
| Telegram agent facet      | `telegram-agent/created`  | Telegram router when it resolves a new chat session                                                   | Shares a stream with Agent and Capability Host; config names the explicit connection/chat/topic.                                                                                                                     |
| Sandbox status projection | `sandbox/created`         | The Sandbox instance DO called by `sandboxes.create(...)`                                             | The collection first claims the unique name with `sandbox/create-requested` in `/sandboxes`; the instance appends its birth and processor subscription in one batch, then waits for its hosted reducer to fold them. |

### Other processor shapes and deliberate exceptions

- The Core stream processor owns the infrastructure-level `stream/created`
  fact. It establishes the journal, not a domain object on that journal, so it
  does not use `state.birthCertificate`.
- `SandboxProcessor` is a pure fold hosted by the same container-backed
  Sandbox Durable Object whose lifecycle it projects. It disables processor
  recovery because the Containers SDK owns that object's single alarm. The
  sandbox collection relays `processor(path)` and `liveState(path)` while
  `get(path)` remains the bare Sandbox SDK stub.
- Browser raw-event, feed, and composite processors are client-side
  projections over existing streams. They do not declare durable domain
  existence and therefore have no domain birth.
- The project worker is a worker-hosted subscriber with its own durable
  delivery cursor, not a path-created domain object.
- Custom-domain events are folded and acted on by ProjectProcessor; there is
  no separately hosted CustomDomain processor to create.
- Sandbox's catalog claim is intentionally a request fact in a separate
  journal. `sandbox/created` remains the authoritative birth on the sandbox's
  own stream.

## The supporting rules

- **Derive what names carry; reduce everything else.** Durable Object names
  carry project id and stream path. Identity, journal reference, and self
  address are projections of that name—not birth config. Facts the processor
  needs arrive as events.
- **State is a fold; the checkpoint is disposable.** A processor's storage
  holds `{offset, state}` as a cache of `reduce` over the journal. Delete it
  and replay rebuilds it. The stream is the only authority.
- **Side effects live in `processEvent`, never in `reduce`.** Replay rebuilds
  state and can re-run side effects for events past the durable checkpoint, so
  side effects must follow the guarantees in the companion guide.
- **Appends go through stamped lanes; `emits` is the complete append
  vocabulary.** A processor appends through `args.append`/`args.appendTo`
  (event-bound) or `this.append`/`this.appendTo` (alarms and whole-fold
  decisions). Both validate against `contract.emits`. Build stable keys with
  `this.idempotencyKey(key, event?)` unless a deliberately shared cross-lane
  key must be byte-identical.
- **Host machinery is a facet.** A domain Durable Object embeds processors as
  facets or via processor composition. The host knows that processors exist,
  not what a path means or how a domain object is born.
- **Self-describing, always.** Every domain object answers `describe()` and
  every provided surface carries instructions and declarations from the
  moment it exists.

## Events

Use the rules in [Event naming](events.md): event types are
`events.iterate.com/...` URI strings, facts are past tense, and
`...-requested` records an asynchronous request rather than completion.

Every stream processor contract makes its vocabulary explicit. Event schemas
and reducers live in `*-processor-contract.ts` and the processor's monolithic
`reduce`; side effects live in the matching `*-processor-implementation.ts`.
Raw third-party ingress preserves the vendor payload as a
`.../webhook-received` or equivalent ingress fact before processors project
normalized domain facts.

itx (`apps/os/src/`) is the reference implementation: projects, repos,
agents, capability hosts, schedulers, secrets, routers, facets, and sandboxes
all follow the explicit-birth convention above.
