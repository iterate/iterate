# Independent Opus review: lean binding model — round 3

**Reviewer:** Claude Opus 5.5 xhigh, read-only. The raw result is
`/tmp/core-simplification-opus/round-3.json`; its model usage records canonical
`claude-opus-5-5`.

## Immediate blocker in the current checkpoint

`delivery` is now required while `CoreContract.version` remains `17.0.0`; the
reducer copies `payload.delivery` without a default. Existing project birth
rows have no field, and cursor/fan-out filtering therefore skips them silently.
This stops every existing context's config worker delivery. Recreate state as
part of deployment or derive the prior policy in the reducer; silence is not
an acceptable migration behavior.

## Verdict

The lean direction is sound. It eliminates the rule interpreter without
exposing a taxonomy of implementation kinds. Every first-party product writer
fits one general durable binding: an absolute context address plus fixed invoke
steps. No product writer uses expression holes or pinned prefix arguments.

```ts
type Step = string | [method: string, ...args: Json[]];
type Binding = { at: string | null; steps: Step[] };
type Scope = Map<DottedName | "", Binding | null>;
type Offer = {
  key: DottedName;
  consumes?: string[];
  fetchRoute?: FetchRoute;
  description?: string;
};
```

The empty scope entry is the only parent/jail state: a binding is the parent;
`null` is a jail. An `Offer` is temporary pager attachment state, never a
durable log row. That separates durable restoration from an actual live RPC
stub without exposing Cloudflare Durable Objects, Workers, facets, or provider
kinds through the public model.

## Lookup

1. `itx.builtins.*` reaches the current scope's private kernel layer. It stays
   a reserved spelling and is not an entry name or a new public kind.
2. Select the longest property-name prefix among durable bindings and current
   offers. An exact offer wins while it exists.
3. A binding continues at `at` (or locally) with its fixed steps plus the
   caller's remaining invocation, spending a normal context-hop budget.
4. A jail refuses before parent fallback. Context-local kernel operations retain
   their existing yield behavior before a parent takes a call.
5. An offer delegates to the existing pager stub directory. A missing offer is
   unavailable, never a persisted stub.

Fixed _lists_ of steps are necessary: facets and webhooks use calls in the
middle of a path. The final caller call applies after those fixed steps. There
are no holes, partial match arguments, or repeated rewrite rules.

## Concrete second PR: names are bindings, offers are sockets

Keep the public vocabulary: `itx`, `context`, `invoke`, `provide`, `subscribe`,
`processor`, `facet`. Do not introduce public `exports`, `cap`, `mount`, or
implementation-kind names.

Make `provide` accept a live stub only. Its attachment contains the offer and
optional route; attach/detach emits no durable rule event. This fixes the
current bug where a live provide shadows a durable name and its detach destroys
the old durable entry. An offer shadows while attached and the binding becomes
visible again after detach.

Delete the offer census, rule-based provider cleanup, live subscription rule
branches, expression/null provision, hole/pinned-prefix rewrite code,
reduce-time target re-resolution, and the no-op platform birth hook. The
review estimates roughly 530 net product lines removed after the new map lookup,
offer overlay, snapshot offer epoch and reattach wake hook are added.

Do not remove ordered cursors in this PR. No first-party writer uses them, but
their removal needs a production row count and a real consumer migration.

## Subscription and outbox conclusion

The review rejects claiming a generic SDK outbox or agent RPC is a kernel net
deletion now. The current runner adds more code and cannot replace the config
birth subscription's kernel-minted delivery authority, batching, wake behavior
or retry semantics. Existing agent RPC is already log-backed (`run-requested` /
`run-settled`). Consider a processor-owned outbox only as a product convenience
after it proves equivalent backlog complexity and failure behavior.

## Proof

Test attach, hibernate, reset and redial from a child and stateless code; route
appearance/removal with an offer; a durable binding targeting an offer waking
again after reattach; Garple jail grants; config publication switch; firmware C
tests unchanged; and zero durable log events for offer attach/detach. Turn on
slow residency e2e rows because the pager path changes.
