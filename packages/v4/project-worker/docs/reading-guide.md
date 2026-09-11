# Read v4 one idea at a time

The aim is structural simplicity: a small vocabulary that explains the program,
followed by increasingly complete implementations of those ideas. The current
landing budget is 15k total implementation lines. A teaching path below 5k lines
is a separate, **not yet measured or demonstrated** goal. It is not permission to
exclude difficult production code from the implementation count.

This guide uses the running v4 implementation. There is no second tutorial
runtime to maintain. Each chapter has a public regression to run and points to
the production code that makes it work. The complete operational status and
source count live in [README](../README.md), not in this guide.

## Recovering the original plan

The original [Build the Iterate Context tutorial](../../../v3/project-worker/docs/tutorial-build-the-iterate-context.md)
planned a small Part 0, then full chapters about three primitives: the context,
fetch, and the stream. Its order note records the agreed conceptual progression:
**rpc stubs → expressions → rewrite rules → subscriptions → processors**.
Fetch is a parallel chapter. The stream arrives as the reveal that durable
configuration is ordinary data, not a second control protocol.

The other useful records are:

- [The onion design](../../../v3/project-worker/docs/design-onion-subscriptions-processors.md):
  physical things versus data, sugar versus primitives, and why a processor is
  a subscription to a facet. Its early sections describe the as-built model;
  its later alternatives and implementation sequence are history.
- [The as-built surface](../../../v3/project-worker/docs/itx-surface-as-built.md):
  the later source of truth for spellings, `itx.builtins`, rewriteable short
  names, and lifetime rules.
- [The old layer map](../../../v3/project-worker/LAYERS.md): the intended reading
  structure. Some claims predate the fixed `itx.builtins` root; do not copy its
  older “built-ins cannot be shadowed” wording onto short names in v4.
- [The narrative/layering review](../../../v3/project-worker/docs/reviews/2026-09-04-round2-narrative-and-layering.md):
  a useful checklist of places where the explanation had drifted from code.

The historical [onion-as-structure proposal](../../../v3/project-worker/docs/proposals/itx-surface-C-onion-as-structure.md)
contributed a good test: removing an outer composition should not require
rewriting the primitives beneath it. Its proposed signatures and strict ring
order were not all adopted.

## The vocabulary to carry through every chapter

A context is an address, `{ projectId, path }`, and things callable there.
An expression names a call. A rewrite rule changes that expression. A live rpc
stub is a capability held by a session, not an event. A subscription names a
delivery. A processor is a subscription targeting a hosted facet, with its
own checkpoint and processing contract.

Two distinctions are essential, not advanced implementation details:

1. **Durable data versus live authority.** A log may name a provider; it cannot
   keep that provider's socket alive. Lending, replacement, disposal and
   hibernation have observable semantics even when their transport code is
   deferred to a later reading pass.
2. **Decide before commit versus react after commit.** Repository head checks
   and trust decisions must succeed in the same transaction as the fact they
   admit. A normal asynchronous processor cannot replace them without changing
   the caller's guarantees. A notification or application reaction belongs
   after commit.

## Nine chapters, two passes through each

Start with [session.ts](../src/session.ts):
`authenticate().projects.get(id).cd(path)` establishes the familiar client shape.
Then follow the chapters below. “Expansion” means the second pass through the
same production program, **not code that can safely be deleted**.

### 1. A live capability can cross sessions

Learn lend → borrow → return. The edge holds the browser's live capability; a
Durable Object borrows a native RPC leg while active. A hibernatable pager lets
it borrow again. Presence describes a physical connection, never a durable
promise that a provider is online.

First run [a callback firing back](../e2e/rpc-stubs-callback-fires-back.e2e.test.ts).
Then read [the session-owned leases](../src/session.ts), the `provide` live-target
branch in [IterateContext](../src/iterate-context.ts), then
[the directory](../src/context/rpc-stub-directory.ts) and
[the relay](../src/context/rpc-stub-relay.ts).
Run [bare functions across clients](../e2e/rpc-stubs-bare-function-across-clients.e2e.test.ts)
and [context-scoped lease replacement](../e2e/session-lends-per-context.e2e.test.ts).
Expansion: keepalives, bounded paging and [hibernation at scale](../__workers-tests__/hibernation-at-scale.test.ts).
The next problem: a capability can disappear with its session. A durable name
must describe how to find a capability without pretending to persist the socket.

### 2. Dots and strings describe the same call

Learn one expression representation and one `invoke` door. The string codec
and dotted spelling are conveniences over it; a mid-chain handle must remain
a real capability, not an eagerly flattened value.

Read [expression.ts](../src/context/expression.ts),
[dispatch.ts](../src/context/dispatch.ts),
[invoke-handle.ts](../src/context/invoke-handle.ts) and the small
[prototype fallback](../src/context/dotted-path-proxy.ts).
Run [dotted calls](../e2e/context-dotted-calls-fall-back-to-the-invoke-door.e2e.test.ts)
and [one-round-trip pipelining](../e2e/session-wire-frames-one-round-trip.e2e.test.ts).
Expansion: JSON5 parsing costs, native brand checks, RPC admission and explicit
native-result disposal. These are obligations under real limits, not blanket
health claims: the 4.5 MiB JSON5 case crashed a deployed isolate before the
intended admission refusal. The [parser/printer patch](json5-memory.md) passes
the capped local reproduction and the original deployed public admission test.
See the operational status in [README](../README.md).
The next problem: a name embedded in every caller cannot be redirected centrally.

### 3. Names are data; the stream is the commit point

A rewrite is one event that updates a map. Short names consult that map;
`itx.builtins` is the physical fixed point. `provide` returns a session-scoped
handle even for an expression target; a raw appended configuration fact is the
durable spelling. The log does not contain a socket.

Read [the rewrite module](../src/context/itx-expression-rewriting.ts),
[events.ts](../src/stream/events.ts), the control-state fold in
[core-processor.ts](../src/stream/core-processor.ts), and the commit sequence in
[stream.ts](../src/stream/stream.ts).
Run [map and chains](../e2e/rewrite-rules-map-and-chains.e2e.test.ts),
[the builtins fixed point](../e2e/rewrite-rules-builtins-root.e2e.test.ts), and
[the core reduce](../e2e/stream-core-reduce.e2e.test.ts).
Also run [lend, recall and offline behavior](../e2e/rpc-stubs-lend-recall-and-offline.e2e.test.ts):
compare a provided rule's lifetime with a raw appended rule. Read the log after
providing a live target: the rule is data there, but the callback itself is not.
Expansion: event chunking, bounded reads, idempotency, pause/recovery, and
checkpoint admission. Atomic rollback is essential; the storage mechanics are
the second pass.
The next problem: a committed fact needs to reach a named consumer even when
that consumer is temporarily unavailable.

### 4. A subscription names a delivery

One configuration event names the target. A facet or live subscriber owns its
progress and gets pushes with scanned ranges. A target that cannot own progress
gets a stream-owned cursor and at-least-once delivery. This distinction is part
of the interface, not an arbitrary delivery mode flag.

Read [the event builder](../src/stream/subscriptions.ts) and
[the one delivery loop](../src/stream/subscription-delivery.ts).
Run [range chaining](../e2e/push-delivery-ranges-chain.e2e.test.ts) and
[cursor halt/resume](../e2e/cursor-delivery-halts-ladders-and-resumes.e2e.test.ts).
Expansion: queue budgets, watchdogs and retry timing. The durable explanation of
a terminal failure must remain visible; a retry ladder may not run forever.
The next problem: delivery alone does not give a consumer durable reduced state,
recovery progress, or a live view of that state.

### 5. A processor is a subscription to a facet

The author supplies a pure reduce and optional effects. The SDK hosts that
processor in a facet. `enableProcessor` writes the subscription that names its
`processEventBatch`; it is not a second scheduling system. Checkpointed state,
replay without repeating historical effects, and live-state revision repair
explain the engine. This is not a claim of exactly-once external side effects.

Read [processor.ts](../src/stream/processor.ts),
[the SDK host](../src/sdk/stream-processor-durable-object.ts), and
[live-state.ts](../src/stream/live-state.ts).
Run [facet reduction and addressing](../e2e/processor-facet-reduces-and-address.e2e.test.ts)
and [checkpoint halting](../e2e/processor-checkpoint-halt.e2e.test.ts).
Expansion: cold recovery, startup memos, loader cache identity and native
eviction. The verified source-replacement path is
[explicit disable then enable](../e2e/processor-facet-same-name-source.e2e.test.ts).
A same-name re-enablement probe kept the old source running locally; treat that
as a current limitation, not a guarantee of hot replacement or an intended law.
The hosting row elides its source, so ordinary delivery supplies no new spec to
replace an existing startup memo. A direct spec-carrying facet call is different.

### 6. Fetch works in both directions under one policy

An incoming project request and a loaded worker's ordinary outbound request both
reach `itx.fetch`. An explicitly addressed fetch lane keeps its target; the native
`globalOutbound` adapter passes that request to the context host unchanged.
A user-space router must send external traffic to
`itx.builtins.fetch`; the physical terminal must refuse an unconfigured request
back to the same project host. A URL routes HTTP; an expression names the
capability handling it.

Read the fetch doors in [the context host](../src/iterate-context-durable-object.ts),
[secret substitution](../src/fetch/secret-substitution.ts), and
[the Docs router](../examples/docs/router.ts).
Run [HTTP and WebSocket fetch](../e2e/fetch-door-expression-http-and-websocket.e2e.test.ts)
and [local project ingress](../e2e/ingress.e2e.test.ts).
The separate [deployed project-ingress proof](../e2e/project-ingress-deployed.e2e.test.ts)
is opt-in via `PROJECT_INGRESS_PROOF`; it is skipped by the default local command.
Expansion: [the native 101 transport](../src/fetch/rpc-stub-fetch.ts).
Its [research note](../../../../docs/native-rpc-fetch-lifecycle-research.md)
explains why a normal native RPC result cannot replace the fetch channel today.

### 7. Some domain decisions must share the transaction

V4 adds immutable repository revisions, signer evidence/trust decisions and
egress approval state. These are domain modules attached to the existing
commit/fetch seams, not asynchronous application processors disguised as
atomic operations.

Read the explicit assembly in [the context host](../src/iterate-context-durable-object.ts):
asynchronous preparation, then the synchronous `Stream` transaction,
then post-commit delivery. Read [repos.ts](../src/repos.ts),
[provenance.ts](../src/provenance.ts), and [fetch/policy.ts](../src/fetch/policy.ts)
one at a time. Run [repository CAS/rollback](../e2e/repos.e2e.test.ts),
[provenance and trust](../e2e/provenance.e2e.test.ts), and
[approval replay protection](../e2e/approval.e2e.test.ts).

The participant contract is narrow: decide, stamp, or update that module's
local transactional projection. No network calls, worker RPC, callbacks to
subscribers, or asynchronous work inside it. Revalidate state-dependent
decisions inside the transaction; preparation alone does not reserve a head or
freeze a policy. Fresh commits and historical reconstruction are different
paths, so admission and replay refusal behavior must be stated explicitly.

Platform-authored facts about physical lifecycle or mechanical outcomes must
be distinguished from externally asserted facts. The internal system append
door is not exposed through ITX or the pager. Run the public
[locked-policy cleanup and halting regressions](../e2e/trusted-mechanical-facts.e2e.test.ts):
they went red before the internal mechanical call sites used that door. This is
scoped proof, not authority justified by a boolean's name. In particular, the
synchronous pager's refusal of unprepared provenance
and caller-supplied verification cannot be deleted without an equivalent proof.
The system flag skips only trust admission: repository and fetch-policy
projections still run, and paused streams still refuse ordinary cleanup facts.
The resume sweep considers only journalled actual disconnects, rechecking current
presence and naming; a raw rule pointing to a never-lent key is not a disconnect.
Trust policy is applied in event
order within a batch; a configuration at its end governs subsequent events.

The convenience verbs do not sign their configuration events. With a nonzero
minimum trust level, a new unsigned `provide` or `subscribe` is refused. The
cleanup proof establishes those live capabilities before locking the context;
it does not prove a signed live-attachment interface.

Expansion: canonical signing bytes, the preparation receipt, AES-GCM and SQL
savepoints. Their algorithms can be deferred; their authenticity, atomicity
and one-use guarantees cannot.

### 8. A public root is not automatically a primitive

`build` and `check` delegate to an isolated compiler service. `repos` names an
atomic domain module. `secrets.list` and `approvals.pending` are safe views.
Native `workers.load` is another input shape for the existing execution host.
OAuth, demo login, MCP, hostname maps and protocol connectors adapt existing
authority and calls; they do not each introduce a new execution model.

Read [built-ins.ts](../src/context/built-ins.ts) as a classification and assembly
map, then [build.ts](../src/build.ts), [bundler.ts](../src/bundler.ts),
[the loader](../src/context/worker-loader.ts), [auth.ts](../src/auth.ts),
[mcp-server.ts](../src/mcp-server.ts), and [the library](../src/library/index.ts)
as separate modules. Run [build/check](../e2e/build.e2e.test.ts),
[native loader input](../e2e/workers-native-input.e2e.test.ts), and
[configured authentication](../e2e/auth.e2e.test.ts).
The email demo is explicitly unverified; it is not a real account directory.

### 9. Build an application without adding a kernel mechanism

Docs uses a Yjs processor and live state. Publishing commits a pinned repository
revision, checks and builds it, then appends activation and rewrite facts. The
published app survives the installer session. That is a composition of earlier
chapters, not a special Docs runtime.

The example inlines the built bundle into its activation rule. That target remains
in core state and its checkpoint and is printed when listing rules. Source-reference
ergonomics could reduce that cost, but are not implemented or measured here; see
the [research decision and compatibility law](structural-simplicity-research.md).

Read [the processor](../examples/docs/processor.ts),
[the client](../src/client/docs.ts), and [the router](../examples/docs/router.ts).
Run [the Docs application proof](../e2e/docs-app.e2e.test.ts).
The [preview record](../../../../docs/preview-proof.md) contains the real
two-editor and post-session hostname evidence, with deployment versions.

## How this differs from a strict dependency onion

The teaching order is not the import order. The host assembles the modules;
the core state is read by expression resolution, delivery and policy decisions.
The core fold itself understands rewrite/subscription configuration. That is a
real dependency, not something a folder rename removes. Type-only imports
must also be distinguished from runtime imports when inspecting the graph.

The architecture has four useful categories, not four strictly nested rings:
physical primitives; synchronous transaction decisions; post-commit
compositions; and native transport/edge adapters. A module's place is determined
by the guarantee it owns, not whether its public name is flat on `itx`.

Do not add a generic participant framework merely to shorten the host's three
explicit preparation steps. A structural refactor earns its place only if it
removes knowledge from callers, preserves the public contracts, and can pass
their existing tests unchanged. Moving that knowledge behind another name is
not simplification.

## Running a chapter and proving a smaller teaching path

For a chapter's E2E file, from this package run:

```sh
pnpm exec vitest run --config e2e/vitest.config.ts e2e/<chapter-proof>.e2e.test.ts
```

This exercises production source. A green chapter is scoped evidence; it does
not erase known failures elsewhere or replace the deployed operational gate.

Before claiming a sub-5k teaching implementation, create a checked manifest of
the actual executable source it includes, count that source, and pair every
omission with its production module and preserved invariant. If an independent
Part 0 is built later, it must run a named subset of the production public tests
verbatim. Tests it does not pass, including hibernation, authority and resource
limits, must remain explicit gaps. Until that artifact exists, the honest claim
is a small conceptual vocabulary and a production-backed reading path—not a
sub-5k implementation.
