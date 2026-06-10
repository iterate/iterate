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

**OS Streams API**:
OS-owned oRPC procedures that expose project stream operations by thinly wrapping the Stream Runtime.
_Avoid_: OS Stream API, Events app stream API, Events contract

**StreamsCapability**:
A project-bound RPC capability for stream operations, optionally narrowed to a default Event Stream Path.
_Avoid_: StreamCapability, generic stream client

**Secret**:
A project-scoped credential record whose Secret Material may be read by authorized OS runtime capabilities.
_Avoid_: environment variable, integration, connection

**Secret Material**:
The raw credential value stored for a Secret.
_Avoid_: token, key, secret metadata

**Secret Metadata**:
Non-material descriptive or operational data returned with a Secret, such as provider, scope, expiry, or connection details.
_Avoid_: secret, secret value

**SecretsCapability**:
A project-bound RPC capability for reading and managing Secrets for one ProjectId.
_Avoid_: global secret client, egress proxy

**OAuth Client Configuration**:
App Config for a provider OAuth app, including client identity, client secret, scopes, and provider-specific webhook verification secrets.
_Avoid_: deployment config, connection, token secret

**Connection**:
A provider account or workspace grant that links an external system identity to one ProjectId and yields one or more Secrets.
_Avoid_: integration, OAuth client, secret

**Provider Claim**:
A mutually exclusive Connection from one external provider identity to one ProjectId.
_Avoid_: user connection, shared integration, provider config

**Webhook Provider Identifier**:
A third-party identifier present on inbound webhook payloads or headers that OS uses to find the claimed ProjectId.
_Avoid_: organization ID, project slug, connection name

**Slack Team Claim**:
A mutually exclusive Connection from one Slack team to one ProjectId for inbound Slack webhook forwarding.
_Avoid_: Slack secret, Slack app config

**Processor Subscription**:
A durable registration that asks the Stream Runtime to deliver one Event Stream Path to a StreamProcessorRunner.
_Avoid_: Domain DO callback, afterAppend subscriber, WebSocket subscription

**App Config**:
Typed runtime configuration serialized into the deployed app and readable by running app code.
_Avoid_: runtime config, deployment config

**Deployment Config**:
Typed deployment-time configuration read by Alchemy while declaring cloud resources and not serialized into the running app.
_Avoid_: app config, runtime config

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
- Project-scoped stream APIs should carry **ProjectId**, not parallel slug and ID fields.
- **Stream Runtime** belongs in shared code; app contracts may import or re-export its core types.
- OS uses the **OS Streams API** for stream access; the standalone Events app that once owned streams has been deleted.
- A **StreamsCapability** is always scoped to one **ProjectId**.
- A **StreamsCapability** may be narrowed to one default stream path, making path arguments optional for operations such as append and read.
- In a narrowed **StreamsCapability**, stream paths without a leading slash, including `./` paths, are relative to the default stream path.
- In a narrowed **StreamsCapability**, stream paths with a leading slash are absolute within the same **ProjectId** and still constrained by capability policy.
- In the current OS secrets slice, every **Secret** belongs to exactly one **ProjectId**.
- A **Secret** may have **Secret Metadata** in addition to **Secret Material**.
- For the current OS secrets/codemode slice, `getSecret` returns raw **Secret Material** and **Secret Metadata**, not a Secret Reference for later egress substitution.
- **OAuth Client Configuration** belongs in **App Config** because workers and local/Docker runtimes need it when handling OAuth callbacks and webhooks.
- A **Connection** may yield a project-wide **Secret** that runtime capabilities can read.
- In the current OS secrets slice, every **Connection** is project-level; user-level and organization-level Connections are out of scope.
- A **Provider Claim** binds one **Webhook Provider Identifier** to exactly one **ProjectId**.
- Organizations (in the Iterate Auth Worker, which replaced Clerk) do not scope **Provider Claims**; claims bind to a **ProjectId** directly.
- A **Webhook Provider Identifier** must not resolve to more than one **ProjectId**.
- A **Slack Team Claim** is the lookup record for routing inbound Slack webhooks to the claimed ProjectId.
- Google Connections are project-level in the current OS secrets slice.
- Navigating to or reading a project stream may initialize that stream; a separate create command is not required for ordinary stream discovery.
- During the OS `packages/streams` migration, **Processor Subscriptions** deliver events to standalone **StreamProcessorRunners**; domain Durable Objects remain command and capability owners rather than processor hosts.
- The OS `packages/streams` migration is a POC cutover, not a backwards-compatible data migration; existing stream histories may be discarded.
- During the OS `packages/streams` migration, OS-specific processor contracts stay in OS code for now; `@iterate-com/streams` remains app-agnostic runtime infrastructure.
- The first OS `packages/streams` migration slice is creating and accessing a **Project** through oRPC with current OS behavior preserved after the stream cutover.
- The first OS `packages/streams` migration slice may use a compatibility adapter to run existing OS processor contracts in the new **StreamProcessorRunner**.
- The first OS `packages/streams` migration slice keeps broad project stream append authority; stream safety and event-type policy are out of scope.
- The OS `packages/streams` migration uses only the new **Processor Subscription** event schema; legacy callable subscription events are not translated.
- **SecretsCapability** and **Workspace** lifecycle are out of scope for the first OS `packages/streams` migration slice.
- **App Config** is available inside deployed app code.
- **Deployment Config** is available to Alchemy deployment code only.
- Cloudflare API credentials and cross-script binding script names belong in **Deployment Config**, not **App Config**.

## Example dialogue

> **Dev:** "Should the AI binding be part of the StreamProcessorRunner?"
> **Domain expert:** "No — the StreamProcessorRunner creates the processor implementation, and the AI binding is one of that implementation's Runtime dependencies."

> **Dev:** "Codemode depends on Agent — is that a Runtime dependency?"
> **Domain expert:** "No — Agent is a Processor dependency when Codemode imports Agent's public contract and reducer. Codemode's code executor is a Runtime dependency."

> **Dev:** "Is Standard processor behavior a composed processor?"
> **Domain expert:** "No — it is a plain bag of repeated state, reducer, event, and hook pieces. If it later needs independent state or ordering, it should become a real processor."

> **Dev:** "Can I use the project slug in a Durable Object name?"
> **Domain expert:** "No — use **ProjectId** for durable identity. **ProjectSlug** is routing language."

> **Dev:** "Should a Worker script name used for a cross-script Durable Object binding live in App Config?"
> **Domain expert:** "No — that is **Deployment Config**, because only Alchemy needs it to create the binding."

## Flagged ambiguities

- "host", "runtime", "adapter", and "runner" were all used for the component that runs processors against streams — resolved: use **StreamProcessorRunner**.
- "dependencies" was used for both public processor contracts and backend services — resolved: use **Processor dependencies** for public contracts/catalogs and **Runtime dependencies** for backend services.
- "well-behaved processor defaults" sounded moralizing and vague — resolved: use **Standard processor behavior** for the shared self-registration pieces.
- "project" identity was mixed between slugs and IDs — resolved: use **ProjectId** for durable identity and **ProjectSlug** for routing labels.
- Durable stream implementation was treated as app-owned — resolved: use **ProjectId** as the project-scoped API identifier and keep stream runtime infrastructure app-agnostic.
- OS stream access was coupled to the Events contract — resolved: expose an **OS Streams API** that wraps the shared Stream Runtime directly.
- Processor subscriptions were described as WebSocket callbacks or domain Durable Object `afterAppend` callbacks — resolved for the OS `packages/streams` migration: use **Processor Subscriptions** to standalone **StreamProcessorRunners**.
- Stream migration was initially discussed as a staged compatibility move with side-by-side bindings — resolved for the POC: cut over the existing `STREAM` binding and port functionality until tests pass again.
- Moving all stream processor contracts into `@iterate-com/streams` would make the generic stream runtime OS-aware — resolved for now: keep OS-specific processor contracts in OS code.
- "Getting started" could mean proving a domain processor such as Repo first or proving raw stream browsing first — resolved: start by replacing old streams in OS and proving a **Project** can be created and accessed through oRPC after the cutover, without intentionally bypassing current Project lifecycle behavior.
- Porting Project lifecycle directly to `packages/streams` processor shape could front-load contract churn — resolved for the first slice: use a compatibility adapter for existing OS processor contracts if it keeps current behavior intact.
- Stream append policy could be tightened during the cutover — resolved for the POC: leave broad append authority in place and focus on getting the new runtime working.
- Legacy callable subscription events could be translated during migration — resolved for the hardcore cutover: emit and consume only the new `packages/streams` **Processor Subscription** schema.
- Secrets and workspaces were listed as possible stream-owned domain objects — resolved for the first slice: keep them as existing capabilities/stateful surfaces.
- "app config" mixed runtime-readable values with deployment-only values — resolved: use **App Config** for app-readable runtime configuration and **Deployment Config** for Alchemy-only deployment inputs.
- "stream API" and "streams API" were both used for OS's project stream surface — resolved: use **OS Streams API** and **StreamsCapability** because callers can operate over a project-scoped set of streams, not only one stream.
- "getSecret" was used both as a raw credential read and as a placeholder for later egress substitution — resolved for the current OS secrets/codemode slice: `getSecret` is a raw **Secret Material** read through **SecretsCapability**.
- "Slack OAuth client" could mean the OAuth app config, a workspace connection, or a token — resolved: provider OAuth app settings are **OAuth Client Configuration** in **App Config**.
- "Slack connection" could mean the OAuth app, workspace claim, or token — resolved: the Slack workspace grant is a **Slack Team Claim**, an instance of **Provider Claim**, and its token is a project-wide **Secret**.
- "Google connection" was initially considered user-scoped because OS1 works that way — resolved for the current OS secrets slice: Google Connections are project-level, and user-level Secrets are out of scope.
