# Iterate

Iterate uses append-only event streams to coordinate processors, tools, agents,
and user-facing projections.

## Language

**StreamProcessorRunner**:
A component that runs one or more stream processor implementations against one or more streams, owns reduced-state persistence/progress, provides stream capabilities, performs catch-up, and invokes lifecycle hooks.
_Avoid_: host, runtime, adapter, mount

**Runtime dependencies**:
Backend-only services passed to a processor implementation factory, such as AI bindings, code executors, MCP clients, loaders, or third-party API clients.
_Avoid_: processor dependencies

**Processor dependencies**:
Public processor contracts or event catalogs that a processor contract references for event definitions, and optionally for public reducer/state-schema projection.
_Avoid_: runtime dependencies

**Standard processor behavior**:
Reusable contract and implementation pieces that ordinary stream processors include to register their public contract on a stream once per processor version.
_Avoid_: well-behaved defaults, fragment, mixin, base processor

## Relationships

- A **StreamProcessorRunner** provides stream capabilities to processor implementations.
- A **StreamProcessorRunner** receives **Runtime dependencies** indirectly by constructing processor implementations.
- **Runtime dependencies** are not safe for frontend imports.
- **Processor dependencies** are safe for frontend imports when they are full public contracts.
- A processor can use a **Processor dependency** to consume or emit another processor's events.
- A processor can use a **Processor dependency** reducer to keep an independent projection in its own reduced state.
- **Standard processor behavior** is copied into a processor contract and implementation; it is not a separate processor identity.

## Example dialogue

> **Dev:** "Should the AI binding be part of the StreamProcessorRunner?"
> **Domain expert:** "No — the StreamProcessorRunner creates the processor implementation, and the AI binding is one of that implementation's Runtime dependencies."

> **Dev:** "Codemode depends on Agent — is that a Runtime dependency?"
> **Domain expert:** "No — Agent is a Processor dependency when Codemode imports Agent's public contract and reducer. Codemode's code executor is a Runtime dependency."

> **Dev:** "Is Standard processor behavior a composed processor?"
> **Domain expert:** "No — it is a plain bag of repeated state, reducer, event, and hook pieces. If it later needs independent state or ordering, it should become a real processor."

## Flagged ambiguities

- "host", "runtime", "adapter", and "runner" were all used for the component that runs processors against streams — resolved: use **StreamProcessorRunner**.
- "dependencies" was used for both public processor contracts and backend services — resolved: use **Processor dependencies** for public contracts/catalogs and **Runtime dependencies** for backend services.
- "well-behaved processor defaults" sounded moralizing and vague — resolved: use **Standard processor behavior** for the shared self-registration pieces.
