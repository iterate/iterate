# Iterate

Iterate uses append-only event streams to coordinate processors, tools, agents,
and user-facing projections.

## Language

**StreamProcessorHost**:
A component that runs one or more stream processor implementations against one stream subscription surface, owns reduced-state persistence/progress, provides stream capabilities, performs catch-up, and invokes lifecycle hooks. In OS production this host is embedded in the domain Durable Object that owns the processor's runtime dependencies.
_Avoid_: runner, adapter, mount

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
The OS implementation and core contracts for durable append-only streams,
centered on `apps/os/src/domains/streams`.
_Avoid_: Events app stream implementation

**StreamCollection**:
The project-bound itx catalog (`itx.streams`) that vends path-addressed
**Stream** handles. Admin sessions also expose `session.streams` for
deployment-wide streams.
_Avoid_: StreamsCapability, OS Streams API, Events app stream API, Events contract

**Stream**:
A path-addressed RPC capability for one durable event stream: append events,
page committed history, wait for or subscribe to events, and inspect runtime
state.
_Avoid_: StreamCapability, generic stream client

**Secret**:
A project-scoped credential record whose Secret Material is write-only through
the public itx surface and may be used only by authorized server-side runtime
paths such as egress and integrations.
_Avoid_: environment variable, integration, connection

**Secret Material**:
The raw credential value stored encrypted for a Secret. Public itx APIs do not
return it.
_Avoid_: token, key, secret metadata

**Secret Metadata**:
Non-material descriptive or operational data returned with a Secret, such as
egress allowlists and audit state.
_Avoid_: secret, secret value

**SecretCollection**:
A project-bound itx catalog (`itx.secrets`) for creating, listing, and updating
Secret records.
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
A durable registration that asks the Stream Runtime to deliver one Event Stream Path to a hosted stream processor.
_Avoid_: afterAppend callback, ad hoc WebSocket listener

**Itx Type Graph**:
The canonical machine-readable form of the public itx surface: one
`ItxApiDeclaration` record per exported declaration — verbatim source text
including JSDoc, the TSDoc summary (first sentence), per-member summaries,
and referenced type names (the edges a closure walk follows) — generated
from the RpcTarget classes. Discovery responses, the flat type file, human
docs, and script typechecking are all projections of it. Identifiers follow
established vocabulary (TypeScript grammar, TSDoc sections), never invented
middle-layer words.
_Avoid_: the types blob, treating itx-api.generated.ts as the contract,
"brief" (TSDoc calls it a summary)

**Type Surface Projection**:
`itx-api.generated.ts` — the import-free flat join of the Itx Type Graph, kept
for consumers that need standalone TypeScript text: the published `iterate`
package, internal client typing, and virtual-filesystem type environments
(REPL, repo IDE, script checker).
_Avoid_: the contract, design-of-record (the graph is canonical)

**Capability Type Declaration**:
TypeScript module source describing one capability — the canonical
description format for everything callable on itx regardless of origin. One
grammar: inline declarations, bare names resolving against the ambient Itx
Type Graph, and standard type-level `import("pkg")` references whose packages
are declared in a `typesDependencies` semver map, typm-resolved and
snapshotted content-addressed at provide time (the journal records the
resolved version and content hash). Non-TS descriptions (MCP JSON Schema,
OpenAPI specs) normalize to it at the boundary where the capability enters
the system. Authored types are always plain: RPC stubification is one
canonical recursive transform (capnweb's) applied at the itx entry point by
consumers, never spelled per capability. Description and checking only —
runtime validation stays with the runtime schema (zod today).
_Avoid_: instructions (that is prose), JSON schema as a description format,
per-mount stubify flags, read-time npm type resolution

**Docs Door**:
`itx.docs` — the scope-aware corpus query surface (search + budget-shaped
fetch) over the Itx Type Graph, the caller's mount table, and the example
catalogue. Exists once per scoped itx handle (subtree narrowing is a
parameter); `__describe()` exists on every node. Division of labor: describe
identifies one node and is never big; docs queries the corpus and is always
budget-shaped. Subsumes the former `itx.examples` node (protected term
deleted; the internal example catalogue remains authoring infrastructure).
_Avoid_: overloading `__describe` with query arguments, per-node `__docs` verb,
itx.examples

**App Config**:
Typed runtime configuration serialized into the deployed app and readable by running app code.
_Avoid_: runtime config, deployment config

**Deployment Config**:
Typed deployment-time configuration read by the deploy scripts (envs.ts, Cloudflare credentials) and not serialized into the running app.
_Avoid_: app config, runtime config

**Scheduler**:
A project-scoped domain component — one Durable Object plus one stream processor over one stream — that owns durable time: it triggers due Schedules and records every Schedule change and Trigger as events on its own stream.
_Avoid_: cron service, alarm manager, agent

**Schedule**:
A keyed, upsertable record on a Scheduler stream combining a Recurrence (when to trigger) with an Action (what happens on a Trigger). Re-setting a key replaces the Schedule; cancelling a key removes it.
_Avoid_: cron job, timer, scheduled task

**Action**:
What a Schedule does when it triggers. A closed discriminated union owned by the Scheduler. The only kind today is running an itx script; a future kind may append stored events verbatim to a target stream.
_Avoid_: callback, handler, job, hook

**Trigger**:
One due occurrence of one Schedule: the Scheduler resolves the Schedule's current Action at execution time, runs it, and records the request and outcome (with the defining set-event offset as provenance) as events on the Scheduler stream.
_Avoid_: firing, tick, invocation

**SchedulerCollection**:
The project-bound itx catalog (`itx.schedulers`) that vends path-addressed Scheduler handles; `itx.scheduler` is the default handle for `/scheduler/primary`. `set` returns only after the Scheduler has ingested the set event, so a successful set is read-your-writes visible and provably alarm-armed.
_Avoid_: cron API, scheduler client

## Relationships

- A **StreamProcessorHost** provides stream capabilities to processor implementations.
- A **StreamProcessorHost** receives **Runtime dependencies** from the domain Durable Object that constructs processor implementations.
- **Runtime dependencies** are not safe for frontend imports.
- **Processor dependencies** are safe for frontend imports when they are full public contracts.
- A processor can use a **Processor dependency** to consume or emit another processor's events.
- A processor can use a **Processor dependency** reducer to keep an independent projection in its own reduced state.
- **Standard processor behavior** is copied into a processor contract and implementation; it is not a separate processor identity.
- A **ProjectId** identifies durable stream storage.
- A **ProjectSlug** may route users to a project, but must not be used as durable stream identity.
- Project-scoped stream APIs should carry **ProjectId**, not parallel slug and ID fields.
- **Stream Runtime** lives in OS today; reusable callers should program
  against the public itx contract in `apps/os/src/types.ts`.
- OS uses **StreamCollection** and **Stream** for public stream access; the
  standalone Events app that once owned streams has been deleted.
- A project **StreamCollection** is scoped to one **ProjectId**.
- A **Stream** path is absolute within its ProjectId; nested handles are
  created with `stream.at(path)`.
- In the current OS secrets slice, every **Secret** belongs to exactly one **ProjectId**.
- A **Secret** may have **Secret Metadata** in addition to **Secret Material**.
- `getSecret(path)` is an egress placeholder string. It is not a public
  secret-read API and does not return raw **Secret Material**.
- **OAuth Client Configuration** belongs in **App Config** because workers and local/Docker runtimes need it when handling OAuth callbacks and webhooks.
- A **Connection** may yield a project-wide **Secret** that runtime capabilities can read.
- In the current OS secrets slice, every **Connection** is project-level; user-level and organization-level Connections are out of scope.
- A **Provider Claim** binds one **Webhook Provider Identifier** to exactly one **ProjectId**.
- Organizations (in the Iterate Auth Worker, which replaced Clerk) do not scope **Provider Claims**; claims bind to a **ProjectId** directly.
- A **Webhook Provider Identifier** must not resolve to more than one **ProjectId**.
- A **Slack Team Claim** is the lookup record for routing inbound Slack webhooks to the claimed ProjectId.
- Google Connections are project-level in the current OS secrets slice.
- Navigating to or reading a project stream may initialize that stream; a separate create command is not required for ordinary stream discovery.
- In OS, **Processor Subscriptions** deliver events to processors hosted inside the relevant domain Durable Object through `createStreamProcessorHost`; domain Durable Objects remain command and capability owners and inject runtime dependencies.
- Processor contracts and implementations live with their OS domains unless a
  reusable runtime boundary is explicitly extracted later.
- **App Config** is available inside deployed app code.
- **Deployment Config** is available to deploy scripts only.
- Cloudflare API credentials, worker names, resource IDs, hostnames, and
  generated binding layout belong in **Deployment Config**, not **App Config**.
- A **Trigger** runs its Schedule's **Action** at least once; Actions must be idempotent per Trigger (derive append idempotency keys from the Trigger's executionId).
- A **Trigger** always runs the newest Action for its key: code is resolved from reduced state at execution time, so a re-set between request and execution (or before a crash-replay) runs the updated code, and a cancelled Schedule's in-flight Triggers complete as skipped.
- An itx script **Action** runs with project-root itx authority, so append access to a **Scheduler** stream is a privileged, arbitrary-code surface — same trust domain as an agent stream.
- itx script Actions are invoked as `fn(itx, schedule, trigger)`.
- A Schedule that missed occurrences (Scheduler downtime) Triggers once when the Scheduler recovers, not once per missed occurrence; the next occurrence is computed from now.

## Example dialogue

> **Dev:** "Should the AI binding be part of the stream processor contract?"
> **Domain expert:** "No — the domain Durable Object injects the AI binding as one of the processor implementation's Runtime dependencies."

> **Dev:** "Codemode depends on Agent — is that a Runtime dependency?"
> **Domain expert:** "No — Agent is a Processor dependency when Codemode imports Agent's public contract and reducer. Codemode's code executor is a Runtime dependency."

> **Dev:** "Is Standard processor behavior a composed processor?"
> **Domain expert:** "No — it is a plain bag of repeated state, reducer, event, and hook pieces. If it later needs independent state or ordering, it should become a real processor."

> **Dev:** "Can I use the project slug in a Durable Object name?"
> **Domain expert:** "No — use **ProjectId** for durable identity. **ProjectSlug** is routing language."

> **Dev:** "Should a Cloudflare worker name or Durable Object binding layout live in App Config?"
> **Domain expert:** "No — that is **Deployment Config**. Running app code receives typed bindings; deploy scripts generate the binding layout from envs.ts."

## Flagged ambiguities

- "host", "runtime", "adapter", and "runner" were all used for the component that runs processors against streams — resolved: use **StreamProcessorHost** for production OS hosting; standalone **StreamProcessorRunner** exists only in stream-engine test support/example contexts.
- "dependencies" was used for both public processor contracts and backend services — resolved: use **Processor dependencies** for public contracts/catalogs and **Runtime dependencies** for backend services.
- "well-behaved processor defaults" sounded moralizing and vague — resolved: use **Standard processor behavior** for the shared self-registration pieces.
- "project" identity was mixed between slugs and IDs — resolved: use **ProjectId** for durable identity and **ProjectSlug** for routing labels.
- Durable stream implementation was treated as app-owned or shared depending on
  the migration phase — resolved for today's code: the runtime lives under OS,
  and the public contract is `StreamCollection` / `Stream` in `types.ts`.
- OS stream access was coupled to the Events contract — resolved: expose
  **StreamCollection** and **Stream** over itx directly.
- Processor subscriptions were described as WebSocket callbacks or domain Durable Object `afterAppend` callbacks — resolved: use **Processor Subscriptions** delivered to hosted stream processors.
- "app config" mixed runtime-readable values with deployment-only values — resolved: use **App Config** for app-readable runtime configuration and **Deployment Config** for deploy-script-only inputs.
- "stream API" and "streams API" were both used for OS's project stream surface — resolved: use **StreamCollection** for the catalog and **Stream** for one path-addressed handle.
- "getSecret" was used both as a raw credential read and as a placeholder for later egress substitution — resolved for the current OS secrets slice: `getSecret(path)` is a placeholder consumed by egress; public secret APIs never return material.
- "Slack OAuth client" could mean the OAuth app config, a workspace connection, or a token — resolved: provider OAuth app settings are **OAuth Client Configuration** in **App Config**.
- "Slack connection" could mean the OAuth app, workspace claim, or token — resolved: the Slack workspace grant is a **Slack Team Claim**, an instance of **Provider Claim**, and its token is a project-wide **Secret**.
- "Google connection" was initially considered user-scoped because OS1 works that way — resolved for the current OS secrets slice: Google Connections are project-level, and user-level Secrets are out of scope.
