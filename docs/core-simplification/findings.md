# Cook the context kernel back down

**Status: draft finding report, 29 September 2026.** This is a breaking
proof-of-concept recommendation, tracked in draft PR
[#3451](https://github.com/iterate/iterate/pull/3451). The audit baseline is
`cfd8a1d3687c77755817d6c5ece586bc15a24bf6`; the reproducible count baseline is
`ce251e06c1c3c5894aebdc674e57b2196be0ae08` after #3442. Current main is
`8615d4560`, which merged #3447 and moved OS birth/deployment shape and
resource naming from root `envs.ts` into `apps/os`. The count remains pinned to
`ce251e06c1` for comparability; #3447 is an integration input for any rewrite.
Implementation is a separate, unmerged effort.

The core does not need a large new type system to become simpler. It needs a
smaller answer to one question: what is an Iterate context?

A context is an event log and an `itx` namespace of ordinary Cap'n Web
capabilities. It can append, read, wait, subscribe, invoke, fetch, and `cd` to
another context. A jail is an explicit inheritance boundary. Capabilities are
ordinary objects; agents, voice, Garple policy, webhook policy, and integration
logic are ordinary code above the context.

```ts
await itx.append({
  type: "events.iterate.com/example/task-created",
  payload: { id: "task-1" },
});

const task = await itx.tasks.get("task-1");
const child = itx.cd("/visitor");
```

That is the active recommendation. It keeps the words and the client shape
that already exist: `itx`, `append`, `readEvents`, `provide`, `subscribe`,
`invoke`, `cd`, processor, and facet. The proof of concept may break durable
row shapes and overloaded subscription behaviour; it should not invent a
second vocabulary without a semantic reason.

## The small model

### Ordinary capabilities and an explicit jail

Today `provide` attaches a live Cap'n Web stub or writes a durable rewrite row;
`cd` addresses a child; `append` records durable context facts. The core should
retain those verbs and make their simple meaning easier to see. A capability is
named in the `itx` namespace and invoked as normal Cap'n Web RPC. A local name
wins; otherwise the context may inherit through its parent. A jailed context
does not inherit until a permitted capability is explicitly provided.

```ts
// Existing live-provider spelling: the handle recalls the provider at disposal.
using camera = await itx.provide(["itx", "clients", "camera"], cameraStub, {
  description: "The connected camera for this context.",
});

// Existing address and invocation spelling.
await itx.cd("/visitor").invoke(["itx", "catalog", "search"], "lamp");
```

The resolver may cache an inherited surface for latency. A parent change or a
jail change still needs the existing revision fence before a cached call is
admitted. That fence is implementation below `cd`, not a JavaScript prototype
API and not a new expression language.

There are three distinct things here:

- A **live capability** is a current RPC object, such as a browser, tunnel, or
  connected client. It is held by the pager/session, borrowed for a call, and
  released afterwards.
- A **durable recipe** is owner-controlled state that can recreate a capability
  when its owner supports restoration. It is not transparent serialization of
  a live Cap'n Web reference.
- A **description** is documentation. The existing `provide` description and
  `rewriteRules.list()` projection are the right shape. If type information is
  added, use one optional TypeScript declaration string on that same record;
  absent means unknown. Do not add a schema engine or runtime reflection.

Do not persist live references or secret values as context state. Cap'n Web
targets and TypeScript types do not provide general durable reflection. A
short, author-supplied description is more honest and more useful to people
and language models than a descriptor framework that claims to know every
method at runtime.

### Private factories, not public capability kinds

Trusted/untrusted and stateful/stateless describe how platform code constructs
a capability. They do not describe what a caller sees in `itx`, and they should
not become a public tagged union stored with every capability.

The existing private `buildBuiltIns(deps)` factory is the appropriate place to
choose whether a capability is backed by a Worker Entrypoint or a Durable
Object/facet and which bindings a trusted implementation receives (for example
`env.AI`). An untrusted Worker or facet receives only its `itx` facade. Project
and global contexts differ because their factories assemble different objects.
This is the useful meaning of `ITX.Builtins`: privileged construction code,
not a public universal object or an extensible policy taxonomy.

The current implementation slice has already removed the public
`TrustedBuiltInCapability` taxonomy and metadata-only availability projection.
Private physical routing descriptors remain an implementation aid. They should
stay private, be reduced where they duplicate factory wiring, and never become
the public model or a general-purpose configuration format.

### Subscribe through ordinary RPC; repair durable work from the log

`provide` and live `subscribe` already lend their session-bound targets through
the same pager/relay mechanism. Keep that mechanism. A committed batch reaches
a current subscriber through ordinary RPC. The pager carries the notification
when the target is live. A durable consumer treats the notification range as a
hint and reads from its own checkpoint; an ephemeral event exists only in the
current notification.

This keeps low latency without asking the context to preserve a live browser
callback. It also avoids a false distinction between a provider transport and a
subscription transport: both use the same borrow/page/release/redial path.
The provider call lease remains bounded. Expiry releases the caller's borrowed
invocation; it does not cancel arbitrary provider-side work or a returned
streaming body.

## Near-term simplification: durable names and live `provide`

The next source slice is smaller than the earlier delivery rewrite. A durable
configured name becomes one simple mapping: an absolute context address plus a
fixed list of `invoke` steps. A jail is the one parent entry that refuses
fallback. Fixed steps preserve current facet and webhook paths with calls in the
middle, while removing holes, argument-prefix matching, and repeated rewrite
rules. This is an internal representation behind existing `itx`, `cd`, and
`invoke` spelling, not a new public target-kind framework.

`provide` becomes live-stub attachment only. Its pager attachment carries the
name, optional `consumes`, optional fetch route, and description. Attaching and
detaching a live stub writes no durable rule event. A live attachment shadows a
durable name while connected; when it detaches, the durable name becomes visible
again. This removes the current bug where detaching a live `provide` can remove
the durable name it shadowed.

The third independent Opus review estimates roughly 530 net product lines
removed after the new lookup, temporary offer overlay, snapshot epoch, and
reattach wake hook are added. It identifies deletable pieces: offer census,
rule-based provider cleanup, live subscription rule branches,
expression/null provision, hole/pinned-prefix rewrite handling, reduce-time
target re-resolution, and the no-op platform birth hook. This is a review
estimate for the proposed source slice, not a committed deletion or a whole
repository line-count claim.

Ordered cursor delivery remains in the core for this slice. No first-party
writer currently uses it, but removal needs a production row count and a real
consumer migration. A generic SDK outbox also remains a product convenience
idea, not a core deletion claim: the current runner cannot replace config birth
delivery authority, batching, wake behaviour, or retry semantics.

The review caught a proof-of-concept state incompatibility: making `delivery`
required while leaving `CoreContract` at `17.0.0` silently skipped existing
birth subscriptions. The working implementation now uses `18.0.0` and rejects
and reports replayed rows without a delivery contract. It requires fresh
contexts; it does not migrate existing logs. Backward compatibility is not
required, but silently stopping config-worker delivery is unacceptable.

React event-log/live-state hooks keep their current callback and gap-repair
behaviour. The vanilla Iterate Cap'n Web client remains a vanilla Cap'n Web
client.

## What remains core

Core owns the append-only durable log, bounded ephemerals, `itx` name
resolution with `cd` and jail, the live pager, fetch entry/exit, and minimal
Worker/facet activation. Fetch is a Request/Response adapter at the context
boundary, not a new kind of capability. Core does not own agent loops, voice
protocols, Garple sales policy, webhook retry policy, app configuration
languages, or a universal persistence mechanism for Cap'n Web references.

Cloudflare Durable Object, hibernation, alarm, Worker Loader, and facet
workarounds stay behind these implementation boundaries. They remain wherever
tests prove platform behaviour; they must not leak into the public context model
as a large target/descriptor/type taxonomy.

## Measured audit evidence and priorities

The reproducible narrow runtime count is **25,545 physical TypeScript/TSX
lines**: 18,787 in the OS context runtime and a 6,758 SDK upper bound. Broader
OS runtime is 45,012 lines. [`count-loc.sh`](count-loc.sh) records the exact
selectors; these are physical counts, not a deletion promise.

Three root causes account for the most concentrated complexity.

1. Built-ins are described, routed, placed, and assembled in parallel lists.
   Keep the private physical routing data while collapsing duplicate factory
   wiring. Do not replace those lists with a public descriptor framework.
2. Live callbacks and subscriptions already share a pager, but durable generic
   delivery separately infers guarantees from an evaluated target. Separate the
   temporary live attachment from the durable name mapping; retain cursors now.
3. One facet lifecycle spans durable keys, in-memory mirrors, worker identity,
   and recovery paths. Preserve tested abort/start and alarm pins; consolidate
   only after a replacement removes state transitions rather than repacks them.

The biggest potential payoff is relaxing **automatic core-owned durable
delivery to an arbitrary stateless target**. Its 1,962-line broker includes
cursor, retry, fan-out, halt, and dead-letter policy. An ordinary processor
could own that policy instead, using the existing log, storage, and wake
mechanisms. That would retain reliable delivery as a capability while requiring
the consumer to own its progress. This is a recommendation to prove, not a
safe deletion today: config delivery needs the same authority and recovery,
and the SDK replacement must demonstrate them before the broker is removed.

The other measured relaxations are transparent WebSocket forwarding through a
lent provider/project host (978 direct lines), and arbitrary expression-prefix
matching/templates (234 directly exclusive resolver lines). The current source
work tries the latter by replacing templates with ordinary confined worker
code. Dropping WebSocket forwarding would lose existing convenience and needs
a concrete replacement; it is not recommended for this implementation. None
of these counts alone proves a 15–20k core target.

The earlier typed export/descriptor proposal is paused. Its complete report,
evidence ledger, and independent review are retained in
[archived-first-design-full.md](archived-first-design-full.md) and the
supporting documents below because their counterexamples remain useful. They
are not the best current model and must not be resumed without a fresh decision.

## Verified defects and test boundaries

`whileClientAnswers` can probe forever when a provider answers liveness checks
but the original call never settles. That retains a borrowed answer and can pin
an invocation indefinitely. The bounded provider-call lease is a real defect
fix: it returns a typed timeout and releases the caller's borrowed answer. A
larger declared deadline remains available for legitimate long work; a returned
streaming body retains its current ownership and cancellation contract.

The compact facet control-row experiment was parked. It was a net **+26
physical lines** and did not reduce lifecycle branches. The review found a
selected identity could advance ahead of durable identity after failed start, a
missing named-worker generation could roll publication back, and a late
recovery write could recreate state after deletion. It is not part of the
source direction. Keep the established abort/start adjacency and alarm/reset
tests until a replacement proves fewer lifecycle states and a recovery path.
The facet loader's remote-error classifier mismatch also remains an
investigation: add telemetry and parent-side failure injection before changing
retry classification.

The direct provider/subscription area has at least 9,371 test lines. They are
not redundant merely because they are large: unit, Workers, and deployed e2e
exercise distinct failure models. Keep native RPC lifecycle, hibernatable
socket, memory, alarm/watch, abort/reset, and Cap'n Web e2e pins. A test can be
deleted only when its production branch and outcome have a named
equal-or-higher-fidelity replacement.

## Concrete next work and validation

1. Replace durable rewrite interpretation with the simple address-plus-fixed-
   steps mapping, keeping `itx`, `cd`, and `invoke` as the public vocabulary.
2. Make `provide` a live pager attachment only. Validate attach, hibernate,
   reset, redial, detach, route appearance/removal, and a durable name becoming
   visible again after detach.
3. Reject or recreate old `delivery`-less rows before enabling the new reducer;
   do not silently drop config-worker delivery. Test config publication switch,
   Garple jail grants, child/stateless attachments, and unchanged firmware C.
4. Keep ordered cursors and their tests. A later removal needs a production row
   count, a real consumer migration, and a named equal-or-higher-fidelity
   replacement. Retain native RPC, hibernation, alarm, abort/reset, and Cap'n
   Web e2e pins.
5. Keep project/global built-in assembly in private factories. Add descriptions
   to existing `provide`/list data only where they help; do not make metadata a
   second runtime.

Before an implementation PR counts, require typecheck; relevant unit, Workers,
and deployed e2e rows; latency/throughput and soak evidence; and preview logs
without new unexplained errors. Preview, performance, and soak validation are
authorized by this audit. Production rollout is not.

## Source trail and evidence ledger

- Current code inventory and test ownership: [`tests-inventory.md`](tests-inventory.md), [`core-userspace.md`](core-userspace.md), [`rpc-subscriptions.md`](rpc-subscriptions.md), and [`facets-loader.md`](facets-loader.md).
- Paused delivery-removal proposal: [`design-delivery.md`](design-delivery.md). It remains useful evidence, but cannot justify a current cursor deletion.
- Requirement tradeoffs and Cloudflare comparison: [`requirement-tradeoffs.md`](requirement-tradeoffs.md), [`cloudflare-os-comparison.md`](cloudflare-os-comparison.md), and [`validation-plan.md`](validation-plan.md).
- Archived first-pass framework and reviews: [`archived-first-design.md`](archived-first-design.md), [`archived-first-design-full.md`](archived-first-design-full.md), [`exports-not-expressions.md`](exports-not-expressions.md), [`design-capabilities.md`](design-capabilities.md), [facet review](reviews/facets-plan-opus.md), [facet experiment](reviews/facets-control-experiment.md), [exports review](reviews/opus-exports-round-2.md), and [lean-model review](reviews/opus-lean-round-3.md).
- Cloudflare, workerd, Cap'n Web, and Kenton Varda research synthesis: [`reports/Iterate core runtime review.md`](../../reports/Iterate%20core%20runtime%20review.md) and [targeted primary-source notes](../../research_notes/Iterate%20core%20runtime%20review/).
