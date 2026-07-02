# Event naming

Events are **facts**. An event records that something already happened, never
that something should happen.

## Terminology

An **event** is the whole object, payload included:

```typescript
{
  type: "events.iterate.com/os/machine/archive-requested",
  payload: { machineId: "m123", reason: "user-requested" },
}
```

An **event type** is the `type` property on the event: the URI string that
identifies what kind of fact this is.

## Events are facts, not commands

An event must always be past tense: a statement of what occurred. Commands
(imperative instructions to do something) belong to a different concept.

| Bad (command)        | Good (fact)                                               |
| -------------------- | --------------------------------------------------------- |
| `verify-readiness`   | `events.iterate.com/os/machine/readiness-check-requested` |
| `archive`            | `events.iterate.com/os/machine/archive-requested`         |
| `send-welcome-email` | `events.iterate.com/os/user/signed-up`                    |
| `deploy`             | `events.iterate.com/os/deployment/initiated`              |

The distinction matters because:

- **Facts are idempotent to record.** "User signed up" remains true regardless
  of how many times you write it down. "Send welcome email" implies an action
  that should not repeat.
- **Facts decouple.** The event producer does not decide what happens next. A
  `user/signed-up` event can trigger a welcome email, Slack notification, and
  analytics capture without the producer knowing about any of them.
- **Facts compose.** Multiple consumers can independently react to the same
  event. Commands create 1:1 coupling.

### What about request events?

Sometimes you genuinely need to request that something happen asynchronously.
This is still a fact: the fact that a request was made.

```text
.../os/machine/archive-requested    -> fact: someone asked for archival
.../os/machine/archived             -> fact: archival completed
```

The `-requested` suffix is the bridge between events and commands. Use it when
the event's purpose is to trigger a specific side effect, but name it as the
fact that the request exists. Naming it this way makes it clear that we do not
know whether the request was satisfied yet.

## Event type URIs

Every event type is a scheme-less path under `events.iterate.com`. The
convention in code is the bare string, for example
`"events.iterate.com/agent/input-added"`, not a full `https://` URL. The path
is the canonical identifier; prefixed with `https://`, it should resolve to
documentation describing the event's purpose, schema, and example payloads.

### First-party events

```text
events.iterate.com/os/machine/activated
events.iterate.com/os/machine/archive-requested
events.iterate.com/codemode/tool-registered
events.iterate.com/codemode/prompt-added
```

The path structure is `/{app}/{entity}/{past-tense-verb}`.

### Third-party events

External vendor events (GitHub webhooks, Slack events, Stripe webhooks) also
live under `events.iterate.com`, namespaced by vendor. The path structure
mirrors first-party events: `/{vendor}/{entity}/{past-tense-verb}`.

Third-party vendors share the top-level namespace with first-party apps, for
example `/github/...` alongside `/os/...`. This is intentional: we control
which vendors we integrate with, so collisions are unlikely. If this becomes a
concern, we can introduce an `/external/` prefix later.

```text
events.iterate.com/github/pull-request/opened
events.iterate.com/github/push/received
events.iterate.com/github/issue/commented
events.iterate.com/slack/message/posted
events.iterate.com/stripe/invoice/paid
events.iterate.com/stripe/subscription/cancelled
```

The webhook handler that receives an external event is responsible for:

1. Emitting a raw `webhook-received` event that preserves the original payload
   for replay and debugging.
2. Emitting a specific typed event, normalized to our schema, when domain
   consumers need it.

A GitHub webhook arriving with `X-GitHub-Event: pull_request` and
`action: opened` should produce both:

```text
events.iterate.com/github/webhook-received     -> raw payload, for audit/replay
events.iterate.com/github/pull-request/opened  -> normalized, for consumers
```

### The two-tier approach

Raw webhook events, for example `github/webhook-received`,
`slack/webhook-received`, and `stripe/webhook-received`:

- Store the original payload as-is from the third party.
- Support debugging, replay, and auditing.
- Are infrastructure events; domain consumers should generally not subscribe to
  them directly.
- Are one per vendor, not one per webhook type.

Specific typed events, for example `github/pull-request/opened`,
`slack/message/posted`, and `stripe/invoice/paid`:

- Normalize to our schema with the fields domain logic cares about.
- Are the events domain consumers subscribe to.
- Enable routing and filtering without parsing vendor payloads everywhere.
- Make logs and traces self-describing.

This separation keeps the raw audit trail while ensuring domain consumers work
with clean, typed events.

Event types are explicitly defined in our codebase, not auto-generated from
vendor payloads. Raw `webhook-received` events keep cardinality low and avoid
type explosion from arbitrary third-party action strings. Specific typed events
are added only when domain logic requires them.

### Normalizing vendor event names

Every event type in our system lives under a single domain we control. The page
at each URL can link out to the vendor's own documentation and document any
mapping or normalization we apply.

Do not fabricate URLs on domains we do not own, such as
`https://github.com/webhooks/push`. Do not use the vendor's raw event strings
as type identifiers. Every event in our system is an `events.iterate.com` URI.

### Why URIs?

- **Globally unique.** No collisions between apps or vendors.
- **Self-documenting.** Navigate to the URL in a browser and get the schema and
  example payloads.
- **Familiar.** This draws on patterns from
  [CloudEvents](https://github.com/cloudevents/spec),
  [FHIR/HL7](https://build.fhir.org/terminologies-systems.html), and
  [EventSourcingDB](https://docs.eventsourcingdb.io/fundamentals/event-types/).

We prefer forward URLs over reverse-DNS because they are human-readable and can
resolve. `events.iterate.com/os/machine/activated` beats
`com.iterate.os.machine-activated`.

### Ergonomics in code

Full URIs are verbose at callsites. We may eventually provide a typed helper,
something like:

```typescript
import { events } from "../events.ts";

bus.publish(events.os.machine.archiveRequested({ machineId: "m123" }));
// Publishes event with type "events.iterate.com/os/machine/archive-requested"
```

This is not a priority right now. For now, use the full
`events.iterate.com/...` string as the event type. A helper can be added later
without changing the wire format.

## Streams and processors

In OS, events are handled by stream processors. Each domain under
`apps/os/src/domains/**` owns:

- A `*-processor-contract.ts` file for event schemas and the pure reducer.
- A `*-processor-implementation.ts` file for side effects.
- A Durable Object that hosts those processors with `createStreamProcessorHost`.

The Stream Durable Object owns the journal. Domain Durable Objects host
processors against public `Stream` capabilities, not raw stream internals.
State is a fold of the journal, and the checkpoint is a disposable cache. See
[Domain objects and stream processors](domain-objects-and-stream-processors.md)
and [`apps/os/src/README.md`](../apps/os/src/README.md).

Other contexts may consume events too: SSE listeners, webhook subscribers,
browser stream views, e2e tests, and local processors in unit tests. They should
still treat event types as facts and respect the same naming rules.

### Consumer naming

Consumers are named for the **side effect they perform**, not the event they
react to.

| Bad (echoes event)       | Good (describes effect)        |
| ------------------------ | ------------------------------ |
| `handleMachineActivated` | `archiveStaleDetachedMachines` |
| `onToolRegistered`       | `syncToolManifestToRegistry`   |
| `handleUserSignedUp`     | `sendWelcomeEmail`             |
| `processMachineArchive`  | `deleteProviderSandbox`        |

Why: a single event can have many consumers. `handleMachineActivated` tells you
nothing about which handler it is. `archiveStaleDetachedMachines` tells you
exactly what the consumer does.

## Casing conventions

| Context               | Convention | Example                                           |
| --------------------- | ---------- | ------------------------------------------------- |
| Event type (URI path) | kebab-case | `events.iterate.com/os/machine/archive-requested` |
| Consumer name         | camelCase  | `deleteProviderSandbox`                           |
| Event payload keys    | camelCase  | `{ machineId, projectId }`                        |

Kebab-case for event names because they are URL path segments. Consumer names
and payload keys are camelCase because they are JavaScript identifiers.

Third-party vendor events use different conventions. Normalize to our
`/{entity}/{verb}` path convention with kebab-case segments at the ingestion
boundary:

| Vendor format                | Our event type                                  |
| ---------------------------- | ----------------------------------------------- |
| GitHub `pull_request.opened` | `events.iterate.com/github/pull-request/opened` |
| GitHub `push`                | `events.iterate.com/github/push/received`       |
| Stripe `invoice.paid`        | `events.iterate.com/stripe/invoice/paid`        |
| Slack `message`              | `events.iterate.com/slack/message/posted`       |

The vendor's event name maps to `{entity}/{verb}`. When the vendor name is
already past-tense or a bare noun, like GitHub's `push`, use `received` as the
verb.

## Versioning

Do not version event types. Version event schemas.

Event types represent domain facts. "A machine was activated" does not have
versions. The shape of the data attached to that fact can evolve. Use schema
versioning, such as a `schemaVersion` field in the payload, rather than minting
new URLs.

If a domain concept changes so fundamentally that the old event type no longer
applies, that is a new event type, not a new version:

```text
.../os/machine/activated       -> original
.../os/machine/warm-started    -> different concept, not "activated v2"
```

## Summary

1. Events are past-tense facts: `machine/activated`, not `machine/activate`.
2. Every event type is a URI: `events.iterate.com/{app}/{entity}/{verb}`.
3. Third-party webhooks emit raw `webhook-received` events for audit/replay,
   then specific typed events only when domain consumers need them.
4. Consumer names describe the side effect: `deleteProviderSandbox`, not
   `handleMachineArchived`.
5. Kebab-case for event URIs, camelCase for consumers and payloads.
6. Do not version event types; version schemas.
