# How to think about domain objects and stream processors

Owner doctrine, updated 2026-07-15 after surveying every hosted stream
processor. This is the convention for durable domain objects on this platform.

For the practical half—side-effect guarantees, the obligation/reconciler
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

`get(path)` therefore only returns an addressable handle. It never creates
anything. Mutation hangs off that handle:

```ts
const agent = itx.agents.get("/agents/researcher");
await agent.create({ systemPrompt: "..." });
await agent.message("Start the research");
```

This is why the API is `agents.get(path).create(...)`, rather than
`agents.create(...)`: addressing and existence remain separate, and every
subsequent operation uses the same path-bound handle.

## Creation is an explicit birth certificate

Every hosted domain processor owns a distinct past-tense `*/created` event.
Its payload has one convention and no generic identity fields:

```ts
{
  config: {
    // facts this processor needs in order to exist
  },
}
```

Path, parent path, and "kind" do not belong in this generic shape. Paths come
from event/source coordinates; domain-specific facts belong under `config`.
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
create command is different: creators use a stable idempotency key, so the
stream append deduplicates the retry and the processor still sees exactly one
birth. Reducer leniency must never hide two actual `*/created` records.

### Creation commands own the whole birth batch

A public `create` command appends everything universally required for the
object—not just its one birth—including sibling processor births, setup facts,
and explicit processor subscriptions. It then calls `waitUntilProcessed` on
the processors it created through the final offset in that batch. Returning
from `create` therefore means later command calls observe the birth and setup.

An agent creation batch is the reference shape:

1. `agent/created` with the agent config;
2. `capability-host/created` for the same stream;
3. the ordinary workspace capability and boot-input setup events;
4. explicit Agent and Capability Host subscriptions;
5. `waitUntilProcessed({ offset: finalBatchOffset })` on both processors.

Transport routers use the same batch shape when they create routed agents,
with one additional facet birth and subscription. Their source webhook is
appended after all births and setup in that same destination-stream batch.

Some objects have asynchronous provisioning after birth. They use a separate
`*/ready` fact rather than stretching the meaning of `*/created`. Project and
Repo are the current examples. Their public create APIs may additionally wait
for readiness when their caller needs a usable provisioned result.

## Configuration after birth

The birth certificate holds the complete initial config. Later configuration
is an ordinary domain event, not another birth and not a universal framework
method. Today Agent owns `agent/configured`; callers can append that event
directly.

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

| Processor                 | Birth                     | Who appends it                                                                                        | Other creation work                                                                                                                                                                                                                      |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project                   | `project/created`         | `session.projects.create(...)`                                                                        | Subscribes Project; Project's birth reaction creates the root Capability Host, primary Scheduler, config Repo, and Email router. `project/ready` follows config-repo and worker readiness.                                               |
| Repo                      | `repo/created`            | `project.repos.create(...)`, global repo creation, or Project bootstrap for `/repos/config`           | Subscribes Repo, cross-posts its birth to `/`, provisions the artifact, then emits `repo/ready`.                                                                                                                                         |
| Agent                     | `agent/created`           | `project.agents.get(path).create(...)` or a Slack/Telegram/Email/GitHub router                        | Creates the paired Capability Host, setup events, and subscriptions; cross-posts its birth to `/`.                                                                                                                                       |
| Capability Host           | `capability-host/created` | Agent creation, Project bootstrap for `/`, or `capabilityHosts.get(path).create()`                    | Subscription is explicit; standalone create waits through its batch.                                                                                                                                                                     |
| Scheduler                 | `scheduler/created`       | Project bootstrap or `schedulers.get(path).create()`                                                  | Subscription is explicit; create waits through its batch.                                                                                                                                                                                |
| Secret                    | `secret/created`          | `secrets.get(path).create(...)`; integration connection setup uses that same Secret DO API            | Encrypts material before append, subscribes Secret, waits for processing, and cross-posts the birth to `/` without plaintext material.                                                                                                   |
| Email router              | `email/created`           | Project birth reaction on `/integrations/email`                                                       | Subscribes Email. Raw email ingress only appends `email/received`; it never creates the router.                                                                                                                                          |
| Email agent facet         | `email-agent/created`     | Email router when it resolves a new inbound thread, or the first outbound send from an existing agent | New routed threads share a stream with Agent and Capability Host; outbound binding adds only the Email facet to an already-created agent. In both cases the facet birth precedes route context and subscription.                         |
| Slack router              | `slack/created`           | Slack connection setup on `/integrations/slack/<connection>`                                          | Connect setup appends the router birth, subscription, then the provider-connected fact.                                                                                                                                                  |
| Slack agent facet         | `slack-agent/created`     | Slack router when it resolves a new thread                                                            | Shares a stream with Agent and Capability Host; config names the explicit connection/channel/thread.                                                                                                                                     |
| Telegram router           | `telegram/created`        | Telegram connection setup on `/integrations/telegram/<connection>`                                    | Connect setup appends the router birth, subscription, then the provider-connected fact.                                                                                                                                                  |
| Telegram agent facet      | `telegram-agent/created`  | Telegram router when it resolves a new chat session                                                   | Shares a stream with Agent and Capability Host; config names the explicit connection/chat/topic.                                                                                                                                         |
| GitHub agent facet        | `github-agent/created`    | Repo processor when it resolves a pull-request agent stream                                           | Shares a stream with Agent and Capability Host; config contains the repo/PR/connection coordinates.                                                                                                                                      |
| Sandbox status projection | `sandbox/created`         | The Sandbox instance DO called by `sandboxes.create(...)`                                             | The collection first claims the unique name with `sandbox/create-requested` in `/sandboxes`; the instance then emits its own birth and optional `sandbox/configured` facts. `SandboxProcessor` is currently a pure, unhosted projection. |

### Other processor shapes and deliberate exceptions

- The Core stream processor owns the infrastructure-level `stream/created`
  fact. It establishes the journal, not a domain object on that journal, so it
  does not use `state.birthCertificate`.
- `SandboxProcessor` folds a domain lifecycle but is not currently wired to a
  host or durable subscription and exposes no command surface. Sandbox create
  waits for the birth append, not for this projection to process it. If the
  folded status becomes a live server-side API, its host, subscription, and
  `waitUntilProcessed` boundary must be added explicitly.
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
