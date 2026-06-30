---
state: backlog
priority: medium
size: medium
dependsOn: []
tags: [itx, minimal-itx-v4, dynamic-workers, durable-objects, facets]
---

# Minimal ITX v4 dynamic worker app runner

Capture the follow-up architecture work from the minimal ITX v4 discussion on
2026-06-29. This is deliberately separate from the immediate
`ItxDurableObject` refactor.

## Context

Cloudflare Dynamic Workers are the low-level primitive for loading code at
runtime. Durable Object facets let a deployed Durable Object act as a
supervisor, load a Durable Object class from dynamic code, and run it as a child
facet with isolated SQLite storage:

<https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/>

The v4 prototype already has most of that runtime hidden in
`apps/minimal-itx-v4/src/domains/dynamic-workers/rpc-targets.ts`:

- stateless dynamic worker execution via `worker.getEntrypoint(...)`
- stateful dynamic Durable Object execution via `ctx.facets.get(...)`
- inline and repo-backed source resolution
- version tracking and facet abort on source changes

Today that runtime is constructed ad hoc by domain objects:

- `ProjectDurableObject` constructs a dynamic runtime for the default project
  worker and its embedded ITX processor.
- `AgentDurableObject` constructs a dynamic runtime for agent-scoped ITX.
- `ProjectWorkerRpcTarget` constructs a partial dynamic runtime without
  `facets` or `storage`, so it can only safely run stateless worker entrypoints.

The current code works, but the boundary is confusing: the dynamic-workers
domain owns the concept, while project/agent/itx objects each assemble it
locally.

## Direction

Do not make `ItxDurableObject` the universal dynamic worker or facet runner.
Split the responsibilities:

1. `ItxDurableObject` is the ITX capability host for one scope. It owns the
   dynamic capability table, live capability retention, script execution, and
   capability invocation.
2. The dynamic-workers domain owns the general runtime/app-runner abstraction.
   It knows how to load stateless WorkerEntrypoints and stateful Durable Object
   facets from inline or repo-backed source.
3. The project domain keeps ownership of the default project worker. Loading and
   invoking that worker should use the dynamic-workers runtime, but the project
   worker remains a project concept, not an ITX-provided capability.

The main conceptual distinction:

- ITX answers: "what capabilities are mounted at this scope?"
- dynamic-workers answers: "how do we load and run dynamic code safely?"
- projects answer: "what is this project's default worker, and how do project
  events/fetches reach it?"

## Target shape

Sketch:

```txt
apps/minimal-itx-v4/src/domains/itx/
  itx-durable-object.ts
    Capability host for one project or agent ITX scope.
    Delegates dynamic-worker capability refs to dynamic-workers runtime.

apps/minimal-itx-v4/src/domains/projects/
  project-durable-object.ts
    Hosts project stream processing.
    Owns project worker behavior.
    Uses dynamic-workers runtime for project worker loading.

apps/minimal-itx-v4/src/domains/dynamic-workers/
  runtime.ts
    Shared library for loading WorkerEntrypoints and DO facets.

  app-runner-durable-object.ts
    Optional generic supervisor DO for dynamic stateful apps when storage and
    lifecycle should not be tied to project, agent, or ITX host storage.
```

The app runner may be either:

- a library used by existing supervisor DOs that already have `ctx.facets`; or
- a first-class `DynamicWorkerAppRunnerDurableObject` when a dynamic app needs a
  stable stateful home that is not naturally the project, agent, or ITX DO.

Do the smallest useful version first. The current `DynamicWorkerRuntimeRpcTarget`
may only need to be renamed/moved and given clearer construction helpers before
introducing a new durable object namespace.

## Project worker implication

The default project worker still needs dynamic worker runtime support.

Today there are two paths:

- `ProjectDurableObject.defaultProjectWorker()` has `facets`, `storage`, and
  `loader`, so it can run both stateless entrypoints and stateful facets.
- `ProjectWorkerRpcTarget.defaultProjectWorker()` constructs a runtime with only
  `loader`, so it should not be the long-term path for stateful dynamic worker
  behavior.

Prefer one canonical project-worker execution path. Likely options:

1. Route `project.worker.fetch/processEvent/invokeCapability` through
   `ProjectDurableObject`, so project worker execution always has the project
   DO as supervisor.
2. Route project worker execution through a dynamic-workers app runner DO, if
   project worker state should live in a generic runner rather than the project
   DO.

Option 1 is simpler and preserves the current mental model: the project worker
is supervised by the project.

## Open questions

1. Should stateful dynamic capabilities provided to ITX use facets under
   `ItxDurableObject`, or should they use a dynamic-workers app runner DO?
   The former ties lifecycle/storage to the ITX scope; the latter creates a
   reusable app-hosting primitive.
2. Should the default project worker use project DO facets, or should it move to
   a generic dynamic app runner? Start with project DO facets unless there is a
   concrete lifecycle reason not to.
3. What is the durable identity of a dynamic app/facet?
   Current v4 derives facet names from project id and source/cache key. A more
   explicit app runner may need a stable app id.
4. Which bindings should dynamic code receive by default?
   At minimum, dynamic workers should receive a scoped `ITX` entrypoint binding.
   Other bindings should be explicit and host-controlled.
5. How should this relate to `tasks/stream-processors-as-facets.md`?
   Both tasks use the same supervisor/facet doctrine. Keep the dynamic-workers
   runner focused on user/source code; keep stream processor facet work focused
   on platform processors.
6. `tasks/itx-dialable-target-data-simplification.md` contains older guidance
   saying not to introduce a generic dynamic Durable Object runner. If this task
   is accepted, update or supersede that section so the task files do not give
   conflicting architectural direction.

## Acceptance criteria

- [ ] The dynamic-workers domain exposes a clear abstraction for stateless
      WorkerEntrypoint execution and stateful Durable Object facet execution.
- [ ] `ItxDurableObject` uses that abstraction for dynamic-worker capabilities
      instead of becoming the general-purpose runner itself.
- [ ] The project worker has one canonical execution path with the right
      supervisor context for facets/storage.
- [ ] Tests cover a stateless dynamic worker capability, a stateful dynamic DO
      facet capability, and default project worker invocation.
- [ ] Documentation or task notes resolve the relationship with
      `itx-dialable-target-data-simplification.md` and
      `stream-processors-as-facets.md`.

## Out of scope

- Implementing the immediate `ItxDurableObject` refactor.
- Changing the public ITX capability API shape.
- Porting this from minimal ITX v4 into `apps/os`.
