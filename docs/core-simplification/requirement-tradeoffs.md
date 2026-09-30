# Requirements whose relaxation removes the most core machinery

This audit uses the frozen `ce251e06c` checkout. Line counts are physical
TypeScript lines in the named source file, not a promise that every line can be
deleted. A number is counted in one proposal only. Shared context addressing,
durable append, jail admission, Cap'n Web calls, and the public processor API
are not counted as savings.

The proposed relaxations retain the core's expressive power where an
application can implement the same behaviour as loaded code or an SDK service.
They remove a convenience or an operational guarantee when the platform cannot
provide it without owning the resulting state machine.

**Current direction.** The durable-delivery work is moving plumbing into a
private `subscriptions` host, not deleting durable delivery. Its behaviour,
authority, lifecycle, and Workers evidence must be proved before this first
ranked relaxation can be adopted. Because this proof of concept permits
breaking state, removed rows should be explicitly refused or recreated; this
report does not recommend a compatibility migration tool.

## Ranking

| Rank | Requirement relaxed                                                                                                                                             |                                           Direct, non-overlapping core source | What remains possible                                                                                      | What is given up                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1    | The platform durably brokers every subscription to an arbitrary expression and changes delivery mode when that expression resolves differently                  |                              1,962 lines in `stream/subscription-delivery.ts` | Append, durable reads, ephemeral events, live callback delivery, and SDK-authored processors               | Platform-owned cursor, retry, halt, fan-out, mode migration, and automatic resume for an arbitrary target |
| 2    | An `itx.fetch` call through a lent live provider or project host transparently carries and resumes WebSockets                                                   | 978 lines in `context/fetch-upgrade.ts` and `context/fetch-upgrade-splice.ts` | HTTP fetch, Cap'n Web live capabilities, and WebSockets that terminate at a deliberate user-owned endpoint | Transparent 101 forwarding and survival of a context reset for that proxied connection                    |
| 3    | User configuration may rewrite any expression prefix to another expression, including forwarding a dynamic final argument with `@` or object spread with `...@` | 234 lines in `context/itx-expression-rewriting.ts`, lines 205–362 and 390–465 | Named adapter workers, static named capabilities, `cd`, direct built-ins, and jails                        | Declarative dynamic interception, prefix precedence, masks, and argument template substitution            |

The first two are materially larger than the other requirement relaxations
examined below. The third is valuable because it removes a pervasive semantic
model, but its defensible direct source count is modest: the remainder of the
1,240-line expression-routing module still resolves direct calls, context
addressing, and jail admission.

## 1. Make durable processing an SDK service, not an arbitrary core broker

### The requirement today

`SubscriptionDelivery` owns three forms of delivery: push to a facet, cursor
delivery, and unordered fan-out. It evaluates a subscription `target` as an
arbitrary expression, decides whether that target owns progress, holds cursors
and claims in core storage, retries, records halts and dead letters, and
re-evaluates a target after its rule snapshot expires. Its 1,962 lines are in
[`subscription-delivery.ts`](../../apps/os/src/stream/subscription-delivery.ts).
Its direct node contract is 2,459 lines in
[`subscription-delivery.test.ts`](../../apps/os/src/stream/subscription-delivery.test.ts).

The requirement also creates coupling outside that file, but those lines are
not included in the payoff: `core-processor.ts` persists subscription rows,
`iterate-context-durable-object.ts` wires delivery to commit and alarms, and
`facet-host.ts` gives a hosted facet a subscription lifecycle. The existing
`targetOwnsProgress` classification in
[`core-processor.ts`](../../apps/os/src/stream/core-processor.ts#L189) is the
clearest sign of the coupling: the platform infers a delivery protocol from
the result of resolving an arbitrary target.

### Smaller contract

Keep the context event log as the authority for durable and ephemeral events.
Keep `subscribe` for a current live provider using the same hibernateable RPC
stub mechanism as any other live capability. Drop the promise that a durable
event will later be delivered by the core to an arbitrary expression.

Move durable consumption into an SDK processor service with an explicit cursor
and an explicit worker/facet endpoint. `packages/iterate/src/stream/processor.ts`
already contains the processor authoring and reduction engine (1,287 lines),
so this is a relocation of responsibility, not removal of processor authoring.
The processor becomes responsible for its own wake schedule, retry policy,
dead-letter policy, and checkpoint. It can use ordinary `readEvents` and
`append` calls, and it can expose its own live provider when it wants pushed
ephemerals.

### Capability and guarantee ledger

| Retained                                                                                                                                             | Relaxed                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable append, atomic idempotency, durable reads, event filtering, ephemeral events, a live subscription callback, and user-authored processor code | A configured target automatically catches up after hibernation; the platform chooses cursor versus fan-out versus push; a target can be re-pointed while its delivery is in flight; the platform retries and records a terminal halt for that target |

This retains the core capability to subscribe. It removes the operational
guarantee that a string or expression in core state creates and operates a
durable delivery service forever without a user-owned processor.

### Why this is the first PR

It has the largest non-overlapping deletion surface and removes the most
cross-cutting state machine. It also makes the suggested common primitive
concrete: both a live event callback and a live capability use the same
provided-stub lifecycle. Durable processing is explicit code, with a cursor
the processor owns, instead of a special second delivery runtime hidden behind
`subscribe`.

The migration should first support a processor that reads a durable cursor and
receives a live callback, then migrate one existing processor. Do not delete
the existing broker until that processor survives an eviction, replay, a
temporarily unavailable receiver, and a redeploy with no duplicate durable
effect. The old public `subscribe` surface needs either a versioned
deprecation or a compatibility package; silently changing a durable row into a
best-effort callback would lose work.

### Validation needed

1. A processor restart replays from its explicit durable cursor and does not
   repeat a keyed effect.
2. A live callback missed during hibernation is repaired from the durable log;
   a purely ephemeral event is documented as best effort.
3. Two processors consume the same log independently and one failure never
   holds the other.
4. The context's alarm, resident time, and throughput stay within the current
   measured budgets for the migrated processor.
5. A migration tool enumerates every current subscription row and either
   installs a processor or reports a named unsupported configuration.

## 2. Stop pretending that a proxied WebSocket is ordinary `fetch`

### The requirement today

[`fetch-upgrade.ts`](../../apps/os/src/context/fetch-upgrade.ts) is 410 lines
and [`fetch-upgrade-splice.ts`](../../apps/os/src/context/fetch-upgrade-splice.ts)
is 568. They bridge a WebSocket-bearing `Response` across Workers RPC and
Cap'n Web, then reconnect both sides after a Durable Object reset. The two
focused unit suites are 619 and 138 lines respectively. The 508-line tunnel
e2e suite exercises the user-facing result, but it also tests broader tunnel
behaviour and is not counted as removable.

### Smaller contract

`itx.fetch` remains an HTTP request/response capability. A live provider can
still expose a Cap'n Web interface and can still return normal responses. A
WebSocket must terminate at an explicitly chosen endpoint: the browser can
connect to a provider's public URL, or a user worker can own a WebSocket
endpoint and its reconnection protocol.

### Capability and guarantee ledger

| Retained                                                                                              | Relaxed                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP egress, streamed HTTP bodies, direct Cap'n Web live calls, and user-owned WebSocket applications | A provider's `fetch()` may transparently return 101 through the context; an already-open proxied connection survives a context deploy/reset; the platform carries selected handshake headers and frame order across its bridge |

This is a convenience loss, not a loss of the ability to build a live agent or
browser connection. It removes an implicit transport promise that currently
requires socket attachment tags, a dedicated upgrade connection, a frame
protocol, redial deadlines, and close-code translation.

### Risks and validation

The main risk is an existing config worker or provider that expects a fetch
route to upgrade. Inventory calls to `itx.fetch` and fetch routes that return
101 before the change. Provide an explicit refusal that names the replacement
endpoint instead of downgrading an upgrade to a broken response. Validate HTTP
fetch, direct provider RPC, expected 101 refusal, and a user-owned WebSocket
sample across a deploy.

## 3. Replace rewrite templates with named adapter workers

### The requirement today

The directly exclusive subset is lines 205–362 and 390–465 of
[`itx-expression-rewriting.ts`](../../apps/os/src/context/itx-expression-rewriting.ts):
prefix matching, specificity ordering, `@` and `...@` substitution, rewrite
iteration, and configuration validation. It is 234 lines. The 1,816-line test
file covers more than this subset: it also protects direct routing, parent
links, grants, and jail behaviour, so it is not a 1,816-line deletion claim.

The rest of the resolver remains necessary even if user-created rewrite rows
go away. In particular, direct `itx` calls, `cd` routing, portable roots, and
the jail's denial must continue to be resolved at the destination context.

### Smaller contract

Permit only static platform-owned capability names in core. A project that
wants `itx.calendar.create(...)` to call an integration, alter arguments, or
dispatch by argument implements `calendar` as a named adapter worker. The
adapter has normal TypeScript control flow and a clear contract. A project
registers the name by its module identity, rather than placing an arbitrary
expression transform in core state.

### Capability and guarantee ledger

| Retained                                                                                                            | Relaxed                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named loaded workers, `cd`, direct built-ins, explicit user adapters, and jail checks at the context that runs code | Declarative prefix interception, longest-prefix precedence, a null mask as a user-configured capability denial, and forwarding arbitrary input with `@` or `...@` without writing code |

The important boundary is jail isolation: a static name registry must still
resolve a call at its destination and check the jail there. Do not replace that
with a caller-side permission check or an adapter that can invoke the physical
scope directly.

### Risks and validation

An adapter is more code than a one-line rule, and a dynamic proxy that forwards
unknown methods may be intentionally unavailable under this contract. Validate
the migration on representative integrations: one fixed alias, one transform
of a request object, and one context-crossing call. Add a refusal for legacy
rule rows and a migration report that identifies rules requiring handwritten
adapters. Preserve the existing jail and cross-context tests.

## Attractive but not first

### Short leases instead of bounded global revocation

The direct cache implementation is only 164 lines in
[`rule-snapshots.ts`](../../apps/os/src/context/rule-snapshots.ts). The change
fence additionally uses `rulesChangeNeedsCommitWait` and `namesTakenAway` in
the expression module, plus commit waiting in the context Durable Object. A
five-second cache already bounds freshness; relaxing the write fence would let
a removed grant or re-pointed target keep working until its lease expires.

That is a real simplification, but it weakens revocation and jail-related
isolation at exactly the moment an operator believes a restriction took
effect. Its direct payoff is too small and its security cost too high for the
first three. Keep it only if revocation has a separately specified propagation
window, visible telemetry, and an emergency no-cache path.

### Fewer exact causal records

`apps/os/src/cause.ts` is 209 lines and `packages/iterate/src/cause.ts` is 101. Most of this carries bounded depth and loop prevention, which is
operationally useful. Removing only stored event-parent detail is a smaller
possible change; it loses precise incident reconstruction but does not remove
enough machinery to justify a first simplification PR. Do not weaken the
hop/depth limits until an independent loop-safety mechanism exists.

### Less loader recovery hardening

`worker-loader.ts` is 511 lines and `module-resolution.ts` is 545, but those
figures include basic worker loading, identity, and package resolution. The
deploy-reset and clone-version recovery paths are only parts of those modules.
Relaxing them would turn transient platform faults into user-visible failures
and risks lowering throughput under redeploys. There is no defensible large,
non-overlapping deletion estimate here.

### Weaker ephemeral ordering

Ephemeral ordering is woven through `stream.ts`, the processor engine, and the
delivery broker. Relaxing it would overlap the first proposal's accounting and
would make high-throughput live contexts less predictable. It should be a
benchmark-driven protocol decision, not a source reduction tactic.

## Single findings PR: recommended shape

The first implementation PR should be titled around **explicit SDK processors
instead of core expression-targeted durable subscriptions**. Its reviewable
scope is:

1. Introduce the SDK processor service and cursor contract beside the current
   broker.
2. Convert one production processor end to end, including an eviction and
   replay proof.
3. Add a migration inventory for durable subscription rows.
4. Remove the old broker only after every row is migrated or deliberately
   rejected.

This ordering makes the requirement relaxation explicit and testable. It does
not claim that a smaller test suite alone is a simplification, and it keeps
the core's durable append, processor authoring, jail isolation, React client,
and vanilla Cap'n Web contracts intact.
