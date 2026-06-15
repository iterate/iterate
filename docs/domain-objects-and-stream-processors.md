# How to think about domain objects and stream processors

Owner doctrine, recorded 2026-06-11 during the itx address-unification
review. This is the way to design ANY durable domain object on this
platform — agents, contexts, MCP sessions, whatever comes next.

## Creation is an event. The journal begins with its own birth certificate.

A durable thing's existence is not configuration — it is the FIRST EVENT
in its own stream:

```text
creating a thing:
  1. mint its id
  2. append event #1 to its journal:  { type: …/thing-created, payload: { id, parent, … } }
  3. return a handle

the thing, on ANY wake:
  derive identity from its name → its journal → consume from offset 0
  → event #1 reduces its parentage/config into state, like any other event
```

What this doctrine buys, every time:

- **No initialize() RPC, no `ON CONFLICT DO NOTHING`, no idempotency keys
  as a correctness mechanism.** Exactly-once is a property of the FOLD
  (`reduce` takes the first creation event and ignores any later one),
  not of delivery. Retried appends are inert.
- **No setup code path at all.** Creation-time facts are an event type
  with a reduce case — nothing more. There is no "configured" residue
  that replay cannot reproduce: a wake rebuilds EVERYTHING, parentage
  included, from event #1 through the same reducer that handles live
  events.
- **Lazy materialization.** Nothing needs to touch the new object at
  creation; it comes alive on first dispatch by reading its own journal.
  Creating a thing is literally one append.
- **The record and the state cannot disagree** — state is a pure function
  of the journal. "Audit log" stops existing as a separate concept;
  anything that needs to be auditable is an event, because events are the
  only writes.

## The supporting rules

- **Derive what names carry; reduce everything else.** DO names on this
  platform are structured records (project id, path). Identity, the
  journal ref, and the self-address are PROJECTIONS of the name — never
  configuration. Anything a name cannot carry arrives as an event.
- **State is a fold; the checkpoint is disposable.** A processor's
  storage holds `{offset, state}` as a cache of `reduce` over the
  journal. Delete it and replay rebuilds it. The stream is the only
  authority.
- **Side effects live in `processEvent`, never in `reduce`.** Replay
  rebuilds state and can re-run side effects for events past the durable
  checkpoint, so side effects must be idempotency-keyed; serialized batches
  give in-order execution and requested/completed event pairs make
  at-least-once reruns detectable.
- **Host machinery is a facet, composition is one line.** A domain DO
  embeds its processors as facets (private storage, no checkpoint
  wiring in the host) or as a processor-composition subclass — the host
  knows THAT it has processors, never how they are wired.

- **Self-describing, always.** Agents are a first-class audience and
  their only sense organ is `describe()`. Every domain object answers
  it; every fold doubles as a description; every provided surface
  carries `instructions` (prose) and `types` (declarations) from the
  moment it exists. The acceptance test: an agent with no prior
  knowledge, handed a stub, acts competently from describe() alone.

The itx capability layer is the reference implementation of all of this
(see `apps/os/docs/itx-next.md`, "The address unification"); a context is
a domain object whose state is its capability table and whose creation
event is `context-created`.
