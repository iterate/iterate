---
state: in-progress
priority: medium
size: medium
dependsOn: [minimal-itx-v4-dynamic-worker-app-runner]
tags: [minimal-itx-v4, workers, itx, durable-objects, facets]
---

# Minimal ITX v4 workers domain refactor

Companion note for the first implementation pass that replaces the v4
`dynamic-workers` domain with a simpler `workers` domain.

## Decisions implemented

- The domain is named `workers`.
- Worker refs are split by execution mode:
  - `StatelessWorkerRef` runs a `WorkerEntrypoint`.
  - `StatefulWorkerRef` runs a dynamic `DurableObject` class through a stateful
    worker Durable Object/facet.
- Every worker ref has `path`. This is the project-relative stream path where
  worker lifecycle events should eventually be written.
- Repo source identity stays separate from event ownership:
  - `ref.path` is where lifecycle events belong.
  - `ref.source.repoPath` is where code comes from.
- Stateful refs have `durableWorkerKey`. It is a slug-like key and is unique
  only within `ref.path`.
- Stateful worker Durable Object names use the same key name as the ref:
  - `prj_123.iterate/?durableWorkerKey=db`
  - `prj_123.iterate/agents/alice?durableWorkerKey=counter`
- Durable Object name path still means "the stream path where related events
  belong"; query props identify auxiliary state under that stream path.
- `project.workers.get(ref)` is the direct worker capability-tree surface.
- `project.worker` remains, but is a shortcut to
  `project.workers.get(defaultProjectWorkerRef)`.
- `project.worker` always means the default stateless project worker entrypoint.
- ITX `provideCapability` stores a worker ref using capability type `worker`.
- ITX eagerly validates worker refs before appending `capability-provided`.
- Direct `project.workers.get(ref)` validates/loads lazily on first call.
- Run scripts use a generated stateless worker ref.
- Dynamic code receives a scoped `env.ITX` binding and calls `env.ITX.get()`;
  ITX auth props are no longer passed through worker refs.
- Source changes deliberately affect the next use of a worker ref.
- Stateful worker facets keep the same durable identity and abort/restart when
  the resolved source/class version changes.
- Stateful worker runtime bookkeeping uses SQLite-backed Durable Object
  synchronous KV (`ctx.storage.kv`) rather than awaited storage APIs. Cloudflare's
  current SQLite DO guidance calls out synchronous KV/SQL as the preferred path
  for keeping storage work in one DO turn.
- Provided worker capabilities are expected to call sibling capabilities through
  their scoped `env.ITX` binding. The host ITX context supplies that binding; a
  worker ref does not carry ITX auth or reserved internal props.

## Current implementation shape

```txt
apps/minimal-itx-v4/src/domains/workers/
  types.ts
  schemas.ts
  worker-loader.ts
  worker-runner.ts
  rpc-targets.ts
  stateful-worker-durable-object.ts
```

`WorkerRunner` is a plain internal module, not an RPC target.

`WorkerCollectionRpcTarget` and `WorkerRpcTarget` are the public capability-tree
surface.

`StatefulWorkerDurableObject` is the supervisor for stateful worker refs. It
loads the dynamic worker source, verifies the exported Durable Object class,
tracks the active source/class version in storage, and uses a single facet named
`target`.

## Apps OS precedent

The apps/os implementation separates source address, build memo, and runtime
isolate. Repo builds are memoized into R2, then Worker Loader materializes the
runtime. Current apps/os stateful source capabilities use facets hosted by the
ITX context Durable Object. Future notes there describe durable workers as
repo-associated with identity `(repo, name)`.

Useful precedent from apps/os:

- Keep source identity separate from build identity and runtime placement.
- Store built modules as a build result rather than making Worker Loader
  callback code the only build boundary.
- Do not encode code/build identity into durable storage identity when state
  should survive upgrades.
- If v4 wants immediate code upgrades for stateful workers, explicitly abort
  and restart the facet when the resolved source/class version changes.

## Deliberately simple choices

- No worker lifecycle events are emitted yet. `path` is present on refs so this
  can be added without reshaping refs.
- No separate build artifact model yet. The current loader still resolves source
  directly and hands modules to Worker Loader.
- No Worker Bundler integration yet in this pass. The current implementation is
  still the existing inline/repo JavaScript module path.
- No reserved prop keys. Worker refs can carry `props`, and the runner passes
  them through as `ctx.props`.
- No helpers that tie ITX capability paths to `durableWorkerKey`.
- No separate abstraction layer above `WorkerRunner` yet. A review of the first
  pass found one over-split helper in `StatefulWorkerDurableObject`; that was
  collapsed so "load dynamic DO class, version-check it, return the facet" stays
  in one method.

## Open questions

1. What exact worker lifecycle events should be emitted?
   Likely candidates: `worker/build-requested`, `worker/typecheck-failed`,
   `worker/build-failed`, `worker/build-completed`.
2. Should lifecycle events be appended directly by RPC methods/runners, or
   mediated by a workers stream processor?
3. Should eager `provideCapability` validation append build events before
   `capability-provided`, or should that wait for a real build subsystem?
4. Should Worker Bundler run inside every caller that can load workers, or move
   behind a dedicated builder Worker/Durable Object to avoid pulling bundler
   cost into all runtime hosts?
5. What is the minimal typecheck contract for TypeScript worker sources?
6. Should build results eventually be cached separately from Worker Loader
   cache keys?
7. Should `durableWorkerKey` be globally meaningful enough to become a path
   segment in a later app/rootable concept, or remain only a query prop under a
   stream path?
8. Should stateful worker direct calls and ITX-mounted worker calls share the
   same `durableWorkerKey` intentionally, or should tests/docs discourage that
   until a clearer sharing story exists?
9. Should the direct `StatefulWorkerDurableObject.get(ref)` method remain public?
   Current ITX and worker RPC paths use `invokeCapability` so method replay
   happens inside the owning DO; `get(ref)` is useful for direct worker refs but
   could be revisited if it encourages cross-DO facet stub plumbing.

## Difficulties encountered

- Durable Object stub inference became too deep when callers used the full
  `StatefulWorkerDurableObject` type. The implementation uses small local RPC
  types for stateful worker stubs, matching the shallow return-type pattern
  already used around `ItxDurableObject`.
- `runScript` needs the owning stream path because `WorkerRef.path` is required.
  The processor now receives that path directly from `ItxDurableObject`.
- The existing project worker, ITX script runner, and dynamic capability code
  had all grown their own worker-loading paths. This pass concentrates them on
  the workers domain while keeping project event forwarding working.
- Returning a dynamic durable facet stub out of the stateful worker DO and then
  replaying a method path elsewhere produced opaque internal RPC failures. The
  current design keeps stateful worker method replay inside
  `StatefulWorkerDurableObject.invokeCapability`, which also makes the storage
  affinity boundary explicit.
- The stateful worker runner's own version marker uses sync KV, and dynamic
  stateful worker fixtures/templates also use sync KV. This is part of the
  expected contract for SQLite-backed dynamic Durable Object facets.
- Tests now cover repo-sourced and inline worker capabilities across project and
  agent scopes, both stateless and stateful, including capabilities calling
  other capabilities through `env.ITX`.
