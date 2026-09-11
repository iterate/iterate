# V4 runtime portability: proposed code and test structure

2026-09-07. Research and recommendations only; no application refactor or runtime
port has been implemented. Evidence: [celld v0.4.1](v4-celld-compatibility-research.md)
and [RivetKit 2.3.15 / historical Alchemy v2](v4-rivetkit-portability-research.md).

## Recommendation

Make the durable context and processor modules portable, while treating live
capability transport and isolated execution as separate, substantial work.
Do not model the whole product as one generic `Runtime` interface. Celld and
RivetKit vary at different seams, and neither currently supplies all V4 semantics.

There is also a public-contract choice that a folder reorganization cannot hide:
V4 accepts [native WorkerLoader input and author-defined Workers classes](../packages/v4/project-worker/src/context/worker-loader.ts#L20-L45).
Running that existing source unchanged on a Rivet-backed product still needs a
Cloudflare-compatible executor. A Rivet actor wrapper around a new portable
authoring interface would be a different contract, not full compatibility with
the existing one. Preserve the native contract unless a change is explicitly
chosen; label a smaller supported profile as partial, not as a successful port.

## Keep and strengthen the seams already present

### 1. Processor logic stays independent of its host

[`ProcessorEngine`](../packages/v4/project-worker/src/stream/processor.ts) already
takes a `ProcessorStream` and `ReduceCheckpointStore`. Author processors can be
constructed directly in Node. Keep this module and its tests; adapt its host.

The current [SDK Durable Object shell](../packages/v4/project-worker/src/sdk/stream-processor-durable-object.ts)
owns `ctx.props`, native ITX calls, checkpoint wiring, and capability disposal.
Those belong in a Workers adapter. Give portable processor exports their own
entrypoint rather than forcing a Rivet import through the current
[SDK barrel](../packages/v4/project-worker/src/sdk/index.ts), which also exports
Workers-specific hosting and transport. Retain the existing native SDK entrypoint
for compatibility.

Acceptance: one unchanged processor runs through the same engine contracts under
the existing Workers host and a concrete Rivet host. Pure unit tests remain fast;
native connection and storage behavior gets separate acceptance tests.

### 2. The durable context owns commit semantics, not a fake DO-shaped store

The existing [stream storage slice](../packages/v4/project-worker/src/stream/stream-storage.ts#L6-L12)
is useful for Cloudflare/celld and real local SQLite. It is **not** a universal
actor interface: Rivet SQL and transactions are asynchronous, while V4's storage
reads, repository checks and writes are synchronous.

The next concrete Rivet slice should drive an asynchronous _context command_
interface, keeping the pure transition logic synchronous and the transaction
implementation private. Commit must cover event rows, idempotency, offsets, core
checkpoint, and transaction-local projections. Do not move
[repository parent/head checks](../packages/v4/project-worker/src/repos.ts#L137-L151)
to a later processor: their atomicity is part of the contract.

Serializing SQL alone is insufficient if two actor actions can calculate offsets
or projections from stale in-memory state. The adapter must preserve per-context
mutation ordering through commit and only publish committed state. It must also
retain bounded reads; an eager array of the whole event history is not an adapter
for the current lazy, budgeted paging implementation.

Before broad extraction, prove one real append/read/reopen/rollback slice with
Rivet's transaction interface. Let that evidence determine the smallest required
change to `StreamStorage`; do not build a general SQL emulation framework first.
([Rivet transaction contract](https://rivet.dev/actors/docs/sqlite/))

### 3. Durable wake-up is an obligation, not an interchangeable timer

[`Stream.armAlarmNoLaterThan`](../packages/v4/project-worker/src/stream/stream.ts#L650-L658)
does not await `setAlarm`: it relies on the native output gate to make failures
observable. The [Node SQLite adapter](../packages/v4/project-worker/src/stream/node-sqlite-durable-object-storage.ts)
has a no-op alarm and therefore cannot prove that property.

Keep due time, attempts, cursor and halt reason as durable facts. Each runtime
adapter must make a pending obligation eventually discoverable after a crash,
including a crash between committing the fact and arming the scheduler. An
unobserved background call or “arm on next ordinary request” is insufficient.
The implementation needs either the required atomic scheduling guarantee or a
durable, independently wakeable reconciliation mechanism.

The shared driver would decide what is due and record the result. Workers alarms and
Rivet scheduled actions would invoke it through their native lifecycle hooks. Their
different retry and overlap rules belong in adapter conformance tests.
([Rivet scheduling contract](https://rivet.dev/actors/docs/schedule/))

### 4. Keep capability lifetime and isolated execution out of storage

The [session relay](../packages/v4/project-worker/src/context/rpc-stub-relay.ts)
owns a live client capability; the context borrows it only when needed. That
allows the context to hibernate without revoking a connected client's authority.
Preserve this interface's authority, lifetime, failure and disposal laws, even
if its transport changes.

[`ReachableContext`](../packages/v4/project-worker/src/stream/stream.ts#L678-L682)
already concentrates append/read/invoke. Its `invoke(): Promise<unknown>` does
**not** mean its results can be serialized as JSON: a result may be a capability.
A named actor action can carry inert commands, but live capabilities require an
explicit authenticated transport. Cap'n Web can remain the public client
protocol; the native relay behind it still needs an actual alternative.

Keep loader cache identity, context authority, resource admission, and egress
policy owned by an execution module. A second executor must preserve the
owner/deployment/source identity rules and fail closed on unavailable policy
mediation. Never make a celld port “work” by omitting `globalOutbound`, or run
untrusted bundles in the Rivet process with ambient network or deployment secrets.
Neither native runtime currently supplies the complete required execution
interface; the research reports give the exact gaps.

## Concrete test layout

Use the existing package and test lanes; introduce directories only as tests move.
The following are roles and suggested paths, not scaffolding to create empty now.

| Location                                                            | Owns                                                                                                   | Must not claim                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Existing `src/stream/*.test.ts` and pure expression/processor tests | Deterministic decisions, replay, reduction, resource admission                                         | Host durability or lifecycle proof                   |
| `test/contracts/`                                                   | Shared public outcome scenarios: append/read, idempotency, atomic projection, delivery, lease lifetime | That every runtime implements every scenario         |
| `test/hosts/{cloudflare,celld,rivet}/`                              | Boot/address/auth, fixture installation, restart/eviction controls, log collection                     | Application assertions or silently altered contracts |
| Existing `__workers-tests__/`, plus per-host conformance tests      | Native transaction, scheduler, transport and lifecycle guarantees                                      | A mock or a different runtime as production proof    |
| Existing `e2e/` and browser specs                                   | Same externally visible assertions against supplied runtime URLs                                       | Automatic portability of native source fixtures      |

A celld host additionally requires a separately validated build/deployment
translation, including SQLite-class declarations and supported configuration
keys. The current V4 Wrangler configuration cannot deploy there unchanged; a
listed test-host role does not imply an implemented or passing adapter.

[`WORKER_BASE_URL` already avoids local boot](../packages/v4/project-worker/e2e/support/global-setup.ts#L67-L97).
Preserve that. Move runtime setup out of assertion bodies incrementally:
[`auth.e2e.test.ts`](../packages/v4/project-worker/e2e/auth.e2e.test.ts) and the
[log harness](../packages/v4/project-worker/e2e/support/log-harness.ts) boot their
own Wrangler instances. [Source fixtures](../packages/v4/project-worker/e2e/support/sources.ts)
also embed `cloudflare:workers` classes. A shared test should request a named
behavioral fixture from its host; tests specifically asserting the native source
contract must keep that exact source and remain a separately visible requirement.

Maintain an explicit requirement matrix. An unsupported capability is a failed
full-port requirement or a declared partial-profile exclusion—not a silent skip
that makes the runtime green. Report passed, failed, unsupported and untested
separately. Keep runtime-specific measured limits explicit while preserving V4's
existing public admission contract until a deliberate change is accepted.

## The small first implementation, if we proceed

1. Extract a handful of existing public stream assertions into a shared contract
   runner, preserving a Workers pass and the existing native regressions.
2. Add a real Rivet actor for just append/read/idempotency and processor snapshots.
   Prove atomic rollback, concurrent mutation ordering and recovery from persisted
   state. This tests the storage seam before spreading async changes everywhere.
3. Add a durable delivery obligation and kill the actor at the commit/schedule
   handoff. Prove recovery without a client request, bounded retries and a durable
   terminal explanation. Test passive wakes do not create a self-sustaining loop.
4. Only then design and prove the live-capability and isolated-execution adapters.
   Retain unchanged full-capability Workers tests as the acceptance specification.

Across runtime acceptance, include commit-before-reply crashes, rollback of a
mixed batch, concurrent repository head conflicts, stale callbacks after
disconnect/reconnect, cross-tenant capability rejection, streaming backpressure,
WebSocket close/hibernation/reconnect, and hostile bundle egress. Preserve exact
operation IDs across bounded retries. Deployed logs, traces and recovered state
must agree; a returned success or a local green suite is insufficient.

## What to take from Alchemy v2

Its historical [shared Counter fixture](https://github.com/alchemy-run/alchemy/blob/1d0d7af2c88d962049f2ca69a61d7d99d55df6bf/packages/alchemy/test/Worker/conformance/counter.ts)
and [remote Rivet conformance runner](https://github.com/alchemy-run/alchemy/blob/1d0d7af2c88d962049f2ca69a61d7d99d55df6bf/packages/alchemy/test/Worker/conformance/rivet/Conformance.test.ts)
are the useful pattern: one behavior, different real hosts, the same assertions.

Do not copy its [ActorBridge](https://github.com/alchemy-run/alchemy/blob/1d0d7af2c88d962049f2ca69a61d7d99d55df6bf/packages/alchemy/src/Rivet/ActorBridge.ts)
as a parity guarantee. That version runs `blockConcurrencyWhile` without input-gate
exclusivity, makes `abort` a no-op, and collects Effect streams into arrays. Its
conformance scope did not establish the stronger V4 laws. Adopt the test pattern,
and make those laws explicit in our own suite.
