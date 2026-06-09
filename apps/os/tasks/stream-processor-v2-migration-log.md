# Stream Processor V2 Migration Spike Log

Branch: `codex/os-stream-processor-v2-migration`

This is a working log from trying to route OS processors through the new class-based
`StreamProcessor` shape. The goal is to identify design and ergonomics issues before
hardening the API.

## What Was Migrated

- `apps/os/src/domains/streams/durable-objects/stream-processor-runner.ts` no longer hosts OS
  processors through `createProcessorRunner`.
- The OS runner now constructs `StreamProcessor` instances and subscribes from each processor's
  `checkpointOffset`.
- Every processor currently hosted by the OS runner goes through the v2 lifecycle:
  - `project-lifecycle`
  - `repo`
  - `codemode`
  - `slack`
  - `slack-agent`
  - `jsonata-reactor`
  - `agent-chat`
  - `agent`
  - `cloudflare-ai`
  - `openai-ws`
  - `agent-host`
- Most processors are still legacy shared implementations behind a v2 adapter. This was deliberate:
  it moves the hosting/cursor model first and shows where the v2 authoring API does not yet fit.

## What Was Not Migrated

- Browser-hosted processors in `packages/streams`:
  - `packages/streams/src/processors/browser-raw-events/implementation.ts`
  - `packages/streams/src/processors/browser-event-feed/implementation.ts`
- The built-in stream core processor in `packages/streams`:
  - `packages/streams/src/processors/core/contract.ts`
  - `packages/streams/src/processors/core/implementation.ts`
- The older shared core lifecycle processor in `packages/shared`:
  - `packages/shared/src/stream-processors/core/contract.ts`
  - `packages/shared/src/stream-processors/core/implementation.ts`

## Issues Found

### 1. SQL Storage Type Was Too Fancy

The first `SyncSqlStorage` type used a generic `exec<Row>()` return. Cloudflare Durable Object SQL
storage is not assignable to that shape because its `toArray()` row type is fixed by the platform
types. The base class should ask for the smallest possible sync SQL surface and cast internally
where it reads its own schema.

Decision for now: `SyncSqlStorage.exec(...)` returns `Record<string, unknown>[]`.

### 2. Runner Runtime State Is OS-Specific

Existing OS code waits on `reducedThroughOffset` / `afterAppendCompletedThroughOffset`. The shared
`StreamProcessorRunnerRpc` type from `@iterate-com/streams` does not model those OS inspection fields.

Decision for now: `apps/os` exports `OsStreamProcessorRunnerRuntimeState` and casts DO stubs where
needed.

Open question: should v2 standardize runtime inspection field names, or should OS own this shape?

### 3. The New Base Has No First-Attach Side-Effect Policy

Legacy shared processors have `firstAttachAfterAppend` policy and rely on `shouldApplySideEffects`.
The v2 adapter had to reimplement the policy with a `sideEffectAnchor`.

Open question: should `StreamProcessor` provide a first-attach policy hook, or should this remain a
runner/adapter concern?

### 4. Legacy `waitUntil` Maps Poorly To V2 `runInBackground`

Codemode uses a detached side-effect option where legacy `waitUntil` gets threaded into
`afterAppend`. In v2 the closest equivalent is `runInBackground`, but the adapter has to pass it as
`waitUntil: (promise) => runInBackground(() => promise)`.

This confirms the new API is clearer for new code, but migration from old processors is awkward.

### 5. `processEvents` Should Not Receive Async Helpers

The current v2 base passes `blockProcessorWhile` and `runInBackground` only into `processEvent`.
This matched the conversation: batch hooks are for synchronous projection work, while event-specific
blocking belongs in `processEvent`.

Open question: should `processEvents` be renamed to avoid confusion with `processEventBatch`?

### 6. Any-Event Processors Need First-Class Support

`agent-host` consumes every event using `consumes: ["*"]` / `consumesAllEvents`. This worked at
runtime because the existing reducer helper supports wildcard consumption, but the v2 contract type
does not advertise `consumesAllEvents`.

Open question: make wildcard consumption first-class in `StreamProcessorContract`.

### 7. `this.ctx.project.streams` Is Easy To Fake But Not Yet Real

The OS runner adapter currently builds a small context around `sharedProcessorStreamApi`. That is
enough to exercise `this.ctx.project.streams`, but a real project-scoped, stream-narrowed
`IterateContext` should be constructed by OS instead of hand-assembling an object in the runner.

### 8. Adapting Shared Processors Is Still Shallow

Most processors were migrated through an adapter class, not rewritten as idiomatic v2 processors.
That helped validate hosting but does not yet validate authoring ergonomics deeply enough.

Next useful ports:

- Rewrite `repo` as a real `RepoProcessor extends StreamProcessor<RepoProcessorContract, Deps>`.
- Rewrite `project-lifecycle` as a real `ProjectProcessor`.
- Rewrite one complex processor, probably `agent-host` or `agent`, without the legacy adapter.

### 9. Browser Processors Were Missed

The migration spike only covered OS runner-hosted processors. It did not cover the browser-hosted
processors in `packages/streams`:

- `browser-raw-events`, which owns the browser `events` table and uses that table as its checkpoint.
- `browser-event-feed`, which owns `feed_items` and reconstructs both resume offset and grouping
  state from that output table.

These are important because they stress different parts of the API than the OS Durable Object
runner:

- They are batch-native today. Both use `afterAppendBatch` and commit a whole delivered batch in one
  SQLite transaction. A v2 base that reduces and calls `processEvents({ events: [event] })`
  per-event loses that shape.
- They use an async browser `SqlClient`, not synchronous Durable Object SQLite. The current v2 base
  assumes sync SQL for its own snapshot table, which does not fit browser storage.
- They often derive checkpoint/state from processor-owned output tables rather than a generic
  `stream_processor_snapshots` row. The new design needs a pluggable storage/checkpoint strategy
  instead of assuming every processor stores `{ state, offset }` in the same table.
- They currently run through `createProcessorRunner` inside the browser stream runtime, with Web
  Locks and React view lifetime deciding which tab/view is the active writer. That is a different
  host from the OS `StreamProcessorRunner` Durable Object.

Design implication: v2 should be designed around processor host shapes, not just processor authoring
syntax. At minimum we have Durable Object-hosted, browser-hosted, and inline stream-core execution.

### 10. The Stream Core Processor Is A Different Category

`packages/streams/src/processors/core` is not a subscription processor. The `Stream` Durable Object
runs it inline while appending:

- `beforeAppend` can reject an event before it is committed, for example when the stream is paused.
- `reduce` updates stream-owned runtime state such as `maxOffset`, `eventCount`, child stream paths,
  registered processors, and configured subscriptions.
- `afterAppend` can trigger stream-internal side effects, such as propagating child-stream-created
  events to ancestor streams.

That means the new class-based `StreamProcessor` shape cannot be the only processor shape unless it
also accounts for privileged inline hooks. Ordinary processors should not get `beforeAppend`, because
they run after commit and should not be able to veto stream writes.

There is also an older `packages/shared/src/stream-processors/core` processor. That one is mostly a
shared lifecycle-event contract plus an empty implementation; it emits/defines
`events.iterate.com/core/stream-processor-registered` and `events.iterate.com/core/error-occurred`.
It is conceptually different from the `packages/streams` stream-core processor, whose events are
`events.iterate.com/stream/...` and whose state is the stream's own reduced state.

Open questions:

- Should v2 have a separate `BuiltinStreamProcessor` / `StreamCoreProcessor` concept with
  `beforeAppend`, or should the stream core stay outside the public processor authoring API?
- Should the older shared core lifecycle events be retired in favor of
  `events.iterate.com/stream/processor-registered` and `events.iterate.com/stream/error-occurred`?
- Should contracts distinguish ordinary subscription processors from inline/builtin processors at
  the type level, so `beforeAppend` is impossible to expose accidentally?

## Validation So Far

- `pnpm --dir apps/os typecheck`
