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

**ProjectId**:
A stable project identifier used for durable identity and long-lived storage keys.
_Avoid_: project slug, project name

**ProjectSlug**:
A user-facing project routing label that can appear in hostnames and URLs.
_Avoid_: project ID, stable project identity

**Stream Runtime**:
The shared implementation and core types for durable append-only streams.
_Avoid_: Events app stream implementation

**OS2 Streams API**:
OS2-owned oRPC procedures that expose project stream operations by thinly wrapping the Stream Runtime.
_Avoid_: OS2 Stream API, Events app stream API, Events contract

**StreamsCapability**:
A project-bound RPC capability for stream operations, optionally narrowed to a default Event Stream Path.
_Avoid_: StreamCapability, generic stream client

**Processor Subscription**:
A durable callable registration that asks the Stream Runtime to invoke a processor runner after matching stream events append.
_Avoid_: WebSocket subscription, callback URL

**Runtime Config**:
Typed app configuration serialized into the deployed runtime and readable by the running app.
_Avoid_: app config, deployment config

**Deployment Config**:
Typed deployment-time configuration read by Alchemy while declaring cloud resources and not serialized into the running app.
_Avoid_: runtime config, app config

## Relationships

- A **StreamProcessorRunner** provides stream capabilities to processor implementations.
- A **StreamProcessorRunner** receives **Runtime dependencies** indirectly by constructing processor implementations.
- **Runtime dependencies** are not safe for frontend imports.
- **Processor dependencies** are safe for frontend imports when they are full public contracts.
- A processor can use a **Processor dependency** to consume or emit another processor's events.
- A processor can use a **Processor dependency** reducer to keep an independent projection in its own reduced state.
- **Standard processor behavior** is copied into a processor contract and implementation; it is not a separate processor identity.
- A **ProjectId** identifies durable stream storage.
- A **ProjectSlug** may route users to a project, but must not be used as durable stream identity.
- In the Events app, a project subdomain segment is interpreted as **ProjectId**.
- Project-scoped Events app APIs should carry **ProjectId**, not parallel slug and ID fields.
- The current Events app POC may expose direct Durable Object debug links publicly.
- **Stream Runtime** belongs in shared code; app contracts may import or re-export its core types.
- OS2 uses the **OS2 Streams API** for stream access and must not depend on the Events app or Events contract.
- A **StreamsCapability** is always scoped to one **ProjectId**.
- A **StreamsCapability** may be narrowed to one default stream path, making path arguments optional for operations such as append and read.
- In a narrowed **StreamsCapability**, stream paths without a leading slash, including `./` paths, are relative to the default stream path.
- In a narrowed **StreamsCapability**, stream paths with a leading slash are absolute within the same **ProjectId** and still constrained by capability policy.
- Navigating to or reading a project stream may initialize that stream; a separate create command is not required for ordinary stream discovery.
- A **Processor Subscription** delivers events through Durable Object RPC callables, not WebSockets.
- **Runtime Config** is available inside deployed app code.
- **Deployment Config** is available to Alchemy deployment code only.
- Cloudflare API credentials and cross-script binding script names belong in **Deployment Config**, not **Runtime Config**.

## Example dialogue

> **Dev:** "Should the AI binding be part of the StreamProcessorRunner?"
> **Domain expert:** "No — the StreamProcessorRunner creates the processor implementation, and the AI binding is one of that implementation's Runtime dependencies."

> **Dev:** "Codemode depends on Agent — is that a Runtime dependency?"
> **Domain expert:** "No — Agent is a Processor dependency when Codemode imports Agent's public contract and reducer. Codemode's code executor is a Runtime dependency."

> **Dev:** "Is Standard processor behavior a composed processor?"
> **Domain expert:** "No — it is a plain bag of repeated state, reducer, event, and hook pieces. If it later needs independent state or ordering, it should become a real processor."

> **Dev:** "Can I use the project slug in a Durable Object name?"
> **Domain expert:** "No — use **ProjectId** for durable identity. **ProjectSlug** is routing language."

> **Dev:** "Should a Worker script name used for a cross-script Durable Object binding live in Runtime Config?"
> **Domain expert:** "No — that is **Deployment Config**, because only Alchemy needs it to create the binding."

## Flagged ambiguities

- "host", "runtime", "adapter", and "runner" were all used for the component that runs processors against streams — resolved: use **StreamProcessorRunner**.
- "dependencies" was used for both public processor contracts and backend services — resolved: use **Processor dependencies** for public contracts/catalogs and **Runtime dependencies** for backend services.
- "well-behaved processor defaults" sounded moralizing and vague — resolved: use **Standard processor behavior** for the shared self-registration pieces.
- "project" identity was mixed between slugs and IDs — resolved: use **ProjectId** for durable identity and **ProjectSlug** for routing labels.
- Events app project context carried slug-shaped values into durable stream identity — resolved: use **ProjectId** as the project-scoped API identifier instead of carrying both fields.
- Durable Object debug access is usually private/admin-only, but the Events app POC intentionally exposes direct debug links publicly.
- Durable stream implementation was treated as Events app-owned — resolved: move shared stream implementation and core types into **Stream Runtime**.
- OS2 stream access was coupled to the Events contract — resolved: expose an **OS2 Streams API** that wraps the shared Stream Runtime directly.
- Processor subscriptions were described as WebSocket callbacks — resolved: use **Processor Subscription** callables that invoke Durable Object RPC methods.
- "app config" mixed runtime-readable values with deployment-only values — resolved: use **Runtime Config** for app-readable config and **Deployment Config** for Alchemy-only deployment inputs.
- "stream API" and "streams API" were both used for OS2's project stream surface — resolved: use **OS2 Streams API** and **StreamsCapability** because callers can operate over a project-scoped set of streams, not only one stream.
