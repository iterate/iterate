# Event naming

Events are **facts**. An event records that something already happened, never that something should happen.

## Events are facts, not commands

An event must always be past tense — a statement of what occurred. Commands (imperative instructions to do something) belong to a different concept entirely.

| Bad (command)        | Good (fact)                                                       |
| -------------------- | ----------------------------------------------------------------- |
| `verify-readiness`   | `https://events.iterate.com/os/machine/readiness-check-requested` |
| `archive`            | `https://events.iterate.com/os/machine/archive-requested`         |
| `send-welcome-email` | `https://events.iterate.com/os/user/signed-up`                    |
| `deploy`             | `https://events.iterate.com/os/deployment/initiated`              |

The distinction matters because:

- **Facts are idempotent to record.** "User signed up" is true regardless of how many times you write it down. "Send welcome email" implies an action that shouldn't repeat.
- **Facts decouple.** The event producer doesn't decide what happens next. The `user/signed-up` event can trigger a welcome email, a Slack notification, and an analytics capture — without the producer knowing about any of them.
- **Facts compose.** Multiple consumers can independently react to the same event. Commands create 1:1 coupling.

### What about "request" events?

Sometimes you genuinely need to request that something happen asynchronously. This is still a fact — the fact that a request was made:

```
.../os/machine/archive-requested    ← fact: someone asked for archival
.../os/machine/archived             ← fact: archival completed
```

The `-requested` suffix is the bridge between events and commands. Use it when the event's purpose is to trigger a specific side effect, but name it as the fact that the request exists. Naming it this way makes it clear that we don't know whether the request was satisfied yet.

## Event type URIs

Every event type is a URL under `https://events.iterate.com`. The URL is the canonical identifier — it should resolve to documentation describing the event's purpose, schema, and example payloads.

### First-party events

```
https://events.iterate.com/os/machine/activated
https://events.iterate.com/os/machine/archive-requested
https://events.iterate.com/codemode/tool-registered
https://events.iterate.com/codemode/prompt-added
```

The path structure is `/{app}/{entity}/{past-tense-verb}`.

### Third-party events

External vendor events (GitHub webhooks, Slack events, Stripe webhooks) also live under `events.iterate.com`, namespaced by vendor. The path structure mirrors first-party events: `/{vendor}/{entity}/{past-tense-verb}`.

> **Note on namespace collisions:** Third-party vendors share the top-level namespace with first-party apps (e.g. `/github/...` alongside `/os/...`). This is intentional — we control which vendors we integrate with, so collisions are unlikely. If this becomes a concern, we could introduce an `/external/` prefix, but for now the flat structure keeps paths short and readable.

```
https://events.iterate.com/github/pull-request/opened
https://events.iterate.com/github/push/received
https://events.iterate.com/github/issue/commented
https://events.iterate.com/slack/message/posted
https://events.iterate.com/stripe/invoice/paid
https://events.iterate.com/stripe/subscription/cancelled
```

The webhook handler that receives an external event is responsible for:

1. **Emitting a raw `webhook-received` event** — preserves the original payload for replay and debugging
2. **Emitting a specific typed event** — normalized to our schema for consumers to react to

A GitHub webhook arriving with `X-GitHub-Event: pull_request` and `action: opened` should produce both:

```
https://events.iterate.com/github/webhook-received     ← raw payload, for audit/replay
https://events.iterate.com/github/pull-request/opened  ← normalized, for consumers
```

### The two-tier approach

**Raw webhook events** (e.g. `github/webhook-received`, `slack/webhook-received`, `stripe/webhook-received`):

- Store the original payload as-is from the third party
- Useful for debugging, replay, and auditing
- Consumers should generally NOT subscribe to these — they're infrastructure events
- One per vendor, not per webhook type

**Specific typed events** (e.g. `github/pull-request/opened`, `slack/message/posted`):

- Normalized to our schema with only the fields we care about
- Domain consumers subscribe to these
- Enable proper routing and filtering without parsing payloads
- Make logs and traces self-describing

This separation keeps the raw audit trail while ensuring domain consumers work with clean, typed events.

> **Note on cardinality:** Event types are explicitly defined in our codebase, not auto-generated from vendor payloads. Raw `webhook-received` events (one per vendor) keep cardinality low and avoid type explosion from arbitrary third-party action strings. Specific typed events are added only when domain logic requires them — each one is a conscious decision, not an automatic transcription of vendor data.

### Normalizing vendor event names

This keeps every event type in the system under a single domain we control. The page at each URL can link out to the vendor's own documentation (GitHub's webhook docs, Slack's event API reference, etc.) and document any mapping or normalization we apply to the vendor's payload.

We don't fabricate URLs on domains we don't own (e.g. `https://github.com/webhooks/push` — that URL doesn't exist). And we don't use the vendor's raw event strings as type identifiers. Every event in our system is an `events.iterate.com` URL. The documentation page at each URL can link to the vendor's own docs for the underlying webhook.

### Why URIs?

- **Globally unique** — no collisions between apps or vendors.
- **Self-documenting** — navigate to the URL in a browser, get the schema and example payloads.
- **Familiar** — this draws on patterns from [CloudEvents](https://github.com/cloudevents/spec) (namespaced `type` attribute), [FHIR/HL7](https://build.fhir.org/terminologies-systems.html) (URIs as code system identifiers, with a [philosophy that URIs should ideally resolve to docs](https://infocentral.infoway-inforoute.ca/en/forum/266-fhir-implementations/3392-fhir-local-uri-naming-conventions)), and [EventSourcingDB](https://docs.eventsourcingdb.io/fundamentals/event-types/) (forward-domain namespaces).

We prefer forward URLs over reverse-DNS because they're human-readable and actually resolvable. `https://events.iterate.com/os/machine/activated` beats `com.iterate.os.machine-activated`.

### Ergonomics in code

Full URLs are verbose at callsites. We may eventually provide a typed helper, something like:

```typescript
import { events } from "../events.ts";

bus.publish(events.os.machine.archiveRequested({ machineId: "m123" }));
// → publishes event with type "https://events.iterate.com/os/machine/archive-requested"
```

This is not a priority right now. For now, use the full URL string as the event type. A helper can be added later without changing the wire format.

### Migration from current format

The codebase currently uses colon-separated short strings (`machine:activated`, `machine:verify-readiness`) as event types. These should be migrated to full URLs when next touching the relevant code. No urgency — the mapping is straightforward.

## Consumer naming

Consumers are named for the **side effect they perform**, not the event they react to.

| Bad (echoes event)       | Good (describes effect)        |
| ------------------------ | ------------------------------ |
| `handleMachineActivated` | `archiveStaleDetachedMachines` |
| `onToolRegistered`       | `syncToolManifestToRegistry`   |
| `handleUserSignedUp`     | `sendWelcomeEmail`             |
| `processMachineArchive`  | `deleteProviderSandbox`        |

Why: a single event can have many consumers. `handleMachineActivated` tells you nothing — which of the five handlers is this? `archiveStaleDetachedMachines` tells you exactly what this consumer does, and makes it obvious when a consumer's responsibility has grown too large.

## Casing conventions

| Context               | Convention | Example                                                   |
| --------------------- | ---------- | --------------------------------------------------------- |
| Event type (URL path) | kebab-case | `https://events.iterate.com/os/machine/archive-requested` |
| Consumer name         | camelCase  | `deleteProviderSandbox`                                   |
| Event payload keys    | camelCase  | `{ machineId, projectId }`                                |

Kebab-case for event names because they're URL path segments. CamelCase in a URL looks wrong (`/machineActivated`). Consumer names and payload keys are camelCase because they're JavaScript identifiers.

Third-party vendor events use different conventions (GitHub uses `snake_case` with dot-separated actions, Stripe uses dot-separated hierarchies). We normalize to our `/{entity}/{verb}` path convention with kebab-case segments at the ingestion boundary:

| Vendor format                | Our event type                                          |
| ---------------------------- | ------------------------------------------------------- |
| GitHub `pull_request.opened` | `https://events.iterate.com/github/pull-request/opened` |
| GitHub `push`                | `https://events.iterate.com/github/push/received`       |
| Stripe `invoice.paid`        | `https://events.iterate.com/stripe/invoice/paid`        |
| Slack `message` (Events API) | `https://events.iterate.com/slack/message/posted`       |

The vendor's event name maps to `{entity}/{verb}`. When the vendor name is already past-tense or a bare noun (like GitHub's `push`), use `received` as the verb.

## Versioning

Don't version event types. Version event schemas.

Event types represent domain facts — "a machine was activated" doesn't have versions. The _shape of the data_ attached to that fact can evolve. Use schema versioning (e.g. a `schemaVersion` field in the payload, or a schema registry) rather than minting new URLs.

If a domain concept changes so fundamentally that the old event type no longer applies, that's a new event type, not a new version:

```
.../os/machine/activated       ← original
.../os/machine/warm-started    ← different concept, not "activated v2"
```

## Summary

1. Events are past-tense facts: `machine/activated`, not `machine/activate`
2. Every event type is a URL: `https://events.iterate.com/{app}/{entity}/{verb}`
3. Third-party webhooks emit two events: raw `webhook-received` (for audit/replay) AND specific typed events (for consumers)
4. Consumer names describe the side effect: `deleteProviderSandbox`, not `handleMachineArchived`
5. Kebab-case for event URLs, camelCase for consumers and payloads
6. Don't version event types — version schemas
