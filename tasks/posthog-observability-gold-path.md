---
state: draft
priority: high
size: large
---

# Gold-path OS observability and PostHog integration

Research and implementation notes from 2026-07-13. This task is the durable
home for the PostHog design while the first proof lands through Cloudflare
Workers Observability and the existing local Cap'n Web package patch.

## Important correction: revive Misha's logger, not evlog

Misha's PR #1206 (`mmkal`, "Add request-wide OS logging and PostHog error
capture") did not add an evlog integration. It explicitly **replaced** the OS
evlog path with an app-local operation-wide logging pipeline under
`apps/os/backend/logging`.

It merged on 2026-05-11 and disappeared one week later only because PR #1341
deleted the entire OS1 app during the OS2 cutover. There is no evidence that
the design itself was rejected or superseded. The current
`packages/shared/src/evlog` arrived later with OS2 and is a separate,
HTTP-oriented implementation.

The parts of #1206 worth reviving are:

- a generic `AsyncLocalStorage` scope for any logical operation, not just HTTP;
- one accumulated structured event emitted when the operation exits;
- structured messages, errors, cause chains, and custom error fields;
- separate ownership for Cloudflare logs and PostHog delivery;
- independent causal operations for `waitUntil`, outbox work, and other child
  work; and
- outside-in tests proving successful, expected, thrown, custom, and background
  outcomes are logged/captured exactly once.

Do not wholesale cherry-pick #1206. Improve these details while porting it:

- link children with `parentId`/`causationId`; never clone the full parent log;
- emit directly to Cloudflare today; add PostHog only when its delivery and
  privacy contract is implemented rather than building a speculative sink API;
- do not restore JSONata keep filters or sampling: emit every operation for now;
- bound message/error counts and serialized sizes instead of allowing an event
  to grow forever;
- do not restore Node filesystem buffers or development temp-log files;
- do not copy Hono/oRPC-specific boundaries into the current architecture;
- do not hand-build PostHog `$exception` payloads or manually parse stacks; and
- do not record URLs with query strings, bodies, headers, email addresses,
  scripts, prompts, capability arguments/results, tokens, or secrets.

## Current proof status

- `iterate/iterate#1933` is the single OS proof. It revives Misha's
  operation logger, adds one bounded log and semantic custom span per logical
  ITX call, and includes the alarm and dynamic-worker tracing proofs that were
  previously split across drafts #1914, #1926, and #1928.
- The existing `patches/capnweb@0.8.0.patch` carries the small server-side
  `onCall(info, invoke)` hook. It survives promise pipelining while the client
  API and wire protocol remain unchanged, so the proof has no separate fork PR.
  The hook is intentionally private to the Workers ESM runtime OS executes;
  the package does not advertise a cross-runtime API it does not implement.
- Closed draft `iterate/iterate#1930` used the current evlog wrapper. It is
  superseded by the #1206 correction and is not the logging foundation.
- The outer OS `worker.fetch` operation covers dashboard, API, webhook,
  project-fetch, HTTP-batch, and WebSocket-handshake lanes with one clean
  structured Cloudflare log line per request.

## ITX lifecycle

An ITX WebSocket is a long-running transport, not one logical application
operation. Its HTTP request log ends when the handshake response is returned.
Cloudflare's automatic request trace nevertheless remains the root for the
life of the socket: custom spans cannot start independent roots or choose a
manual parent. Never retain one ever-growing application log for the socket.

Each logical call gets its own bounded operation and custom span:

```text
HTTP WebSocket handshake operation
  sessionId

ITX call operation + `itx <semantic method>` span
  sessionId
  callId
  semantic target/method name
  outcome and duration
  parent operation id, when causally available
```

The span display name is a bounded semantic name such as
`itx Projects.get`. The structured log uses the stable message `itx_rpc` and
stores the semantic name in `itx.method`, which keeps Cloudflare grouping
low-cardinality without losing searchability. A name is used only when the
method exists as a data property on the target's prototype; dynamic/arbitrary
property keys collapse to `call`. Never put arguments or results in either.
Multiple calls over one socket produce N small call events, not one large
session event.

The Cap'n Web package patch is deliberately minimal. The server-side
`onCall(info, invoke)` hook and promise-pipeline propagation touch only the
Workers ESM runtime. It sends no client metadata and changes no wire tuple; OS
mints the session ID and uses the wide-log operation ID as the call ID. The
current hook covers ordinary and promise-pipelined calls; Cap'n Web `map()` is
a separate protocol operation and is not claimed as part of this hook.
Browser/PostHog identity may eventually justify a separate, narrow correlation
protocol if a socket can outlive the current PostHog session. That decision
must not be conflated with Cloudflare trace IDs.

Cloudflare does not expose its native trace/span IDs to ordinary Worker code.
Do not invent fake IDs. Emitting the structured event while the custom span is
active gives Cloudflare the native association; shared application IDs provide
cross-product search.

### Historical `stubStub` assessment

Misha's late-2025 `stubStub` work ([#465](https://github.com/iterate/iterate/pull/465),
[#475](https://github.com/iterate/iterate/pull/475),
[#602](https://github.com/iterate/iterate/pull/602), and
[#603](https://github.com/iterate/iterate/pull/603); later extracted as
[`mmkal/workert#1`](https://github.com/mmkal/workert/pull/1)) proxied Worker RPC
through a generic `callMethod` operation. It carried logger tags across the
boundary and later combined remote and caller stacks. Its apparent accumulated
log replay was test-only, not the production design.

Do not restore that wrapper. Current Cloudflare tracing propagates across
Workers RPC and Durable Objects, while the Cap'n Web `onCall` hook supplies the
missing logical boundary for ITX. `stubStub` would hide the native RPC method,
turn remote throws into successful result envelopes, add reflective dispatch,
and require both ends to keep using its private protocol. The remaining useful
idea is stack continuity: prove one deliberate Worker-to-DO failure in preview,
then add an error-only boundary helper only if the caller-facing stack is
materially inadequate. Successful calls must stay on native RPC.

The production grill after #1933 supplied that proof. A deliberate missing
Scheduler trigger preserved the semantic `itx Scheduler.trigger` span, native
Durable Object subrequest, error outcome attribute, and error-level wide log,
but the CLI received only Cap'n Web's generic local evaluator stack. The narrow
follow-on is correlation rather than stack export: normalize a thrown target
value to a fresh RPC-safe Error carrying the existing ITX call/log ID as an
authoritative enumerable property. Cap'n Web already transports Error
properties, so the caller can find the exact log and trace without a
successful-call proxy, a generic `callMethod`, or arbitrary server stack
disclosure. The fresh boundary also prevents frozen or pre-tagged errors from
omitting or spoofing the correlation ID; no compatibility contract requires
arbitrary throwable properties to survive. PostHog remains the intended owner
of grouped, source-mapped exception stacks.

## Cloudflare log contract

The target is one structured object per completed operation:

```ts
{
  schema: "iterate.wide-log.v1",
  message, // stable kind: http_request or itx_rpc
  log: { id, kind, parentId?, start, end, durationMs },
  outcome,
  ingress?: { lane, transport, projectId?, appSlug? },
  itx?: { sessionId, callId, method, rpcSystem, transport },
  auth?,
  mcpAuth?,
  messages?,
  error?: { name, cause? },
  dropped?
}
```

The logger writes the object directly as one console argument, using error
severity only for an exception or server-error outcome. Finalization and
console failures are swallowed so diagnostics cannot change the product
result. The schema is an application allowlist rather than an arbitrary record;
raw error messages, URL queries, headers, bodies, arguments, and results have no
field. Native Cloudflare request metadata remains the source of truth for HTTP
method, URL, and status; the application event records only its derived outcome
instead of duplicating a possibly sensitive path. Error names are normalized to
`Error` or `NonErrorThrowable`, because an arbitrary throwable can control its
own `name`. Each event is capped at 4 KiB.

Cloudflare's separate limit is 256 KiB of total console data per request. A
single indefinitely long WebSocket can therefore never promise unlimited
native log history, even with 100% configured sampling. The compact per-call
shape maximizes the useful window; a hard requirement for unbounded sessions
would need reconnect/rotation or an out-of-band exporter.

## PostHog investigation experience

For an unexpected browser or Worker failure an operator should be able to:

1. open one grouped, symbolicated PostHog issue;
2. see the user, trusted project, release, environment, logical ITX call, and
   transport connection;
3. open the relevant browser session replay;
4. find the corresponding Cloudflare log/trace through shared IDs; and
5. distinguish the underlying Worker failure from the browser observing it.

## First-party stream event feed

The analytics-event gold path is an automatically appended, ordinary durable
subscription on every new project stream. It is not a project setting,
user-provided integration, or optional connection:

```text
new project stream
  -> commit stream/created
  -> commit ordinary project-worker subscription
  -> commit ordinary PostHog subscription
  -> normal durable stream cursor
  -> itx.integrations.posthog.processEventBatch
  -> PostHog EU public batch capture
```

The conventional subscription key is `iterate-platform-posthog`. It delivers
from offset zero, explicitly includes ephemeral rows, parks rather than
poison-skipping, and uses the fixed expression
`["integrations", "posthog", "processEventBatch"]`. This is normal stream
configuration: its key is not protected, and the subscription may be replaced
or removed through the normal lifecycle. `includeEphemeral` is a generic
push/webhook option rather than a private platform power.
`itx.integrations.posthog` is a fixed first-party receiver with deployment
credentials; projects do not configure their own PostHog connection.
The subscription itself remains ordinary. The host does, however, mint a
`stream-delivery` purpose while the delivery spine evaluates its expression;
the loopback converts that purpose to a private auth-context identity brand,
and the receiver rejects every unbranded context. No public credential or
caller-chosen principal string can reproduce it. This is a receiver trust
boundary, not protected subscription configuration: projects may still
replace or remove the fact.

Fresh project streams append both platform subscriptions during their ordinary
first-boot birth sequence, before the first user event can land. Neither the
project-worker subscription nor the PostHog subscription receives a special
protection mechanism. There is deliberately no legacy scan, wake-time shim, or
operator-configurable backfill. Streams created before this invariant exists
are outside the rollout boundary; every stream created afterwards in an OS
deployment with its required PostHog credential starts with the ordinary feed.
There is no recovery import or restoration lane. The shared streams example app
has neither the OS credential nor the receiver and therefore does not acquire
this OS-only subscription.

“All events” means one PostHog occurrence for every committed row still owned
by the stream, without a type selector, sampling, success/error filter,
ephemeral exclusion, or payload allowlist. Its event name is `stream:append`.
The complete committed event is sent under `properties.stream_event`,
including payload, metadata, source/cross-post provenance, idempotency key,
ephemerality, offset, commit time, type, and raw path. It remains byte-for-byte
intact through 100 KiB of encoded JSON. Above that explicit boundary, a pure,
deterministic JSON compactor chops the largest useful nested value and marks
the lost tail; `stream_event_truncated` and
`stream_event_original_json_bytes` make the loss queryable. This is size
bounding, not an event-field allowlist: small siblings and all separately
indexed coordinates remain, and no event is dropped. The raw stream path is
also indexed separately as `stream_path`. Event producers own the obligation
not to append secrets that must not reach our first-party analytics project.
PostHog asynchronous ingestion warnings remain an operational signal rather
than a reason to silently filter or sample events.

Each occurrence also contains indexed coordinates:

- deployment worker name and immutable project id;
- the raw stream path, an opaque stable stream id, and source offset;
- original commit time, ephemerality, and stream high-water mark;
- the exact event type, including custom project event types; and
- a stable UUID derived from an unambiguous JSON tuple of deployment, project,
  stream path, offset, and commit time, so at-least-once retries submit the
  same identity without path delimiter collisions or conflating a stream
  recreated after preview data erasure. PostHog's ingestion-side UUID
  deduplication is best-effort, not an exactly-once guarantee.

Every occurrence carries PostHog's first-class `$groups: { project: <id> }`.
The group key is the immutable project id, following PostHog's requirement that
group keys be unique identifiers rather than display names. An authentic
root `project/created` birth certificate emits the one `$groupidentify`, with
both the immutable ID and the creation-time slug (also used as PostHog's
display `name`), so operators can find one project group by either identifier
without creating parallel entities. Ordinary `stream/created` rows deliberately
do not emit redundant ID-only group updates: the authentic root birth
certificate owns the complete group record. Projects born before this rollout
remain outside this first-class group-creation path; there is no partial
compatibility record, lookup, or backfill.
Project slugs are mutable; synchronizing a later rename needs an authoritative
directory event and is not falsely claimed by this birth-only feed. The event
must be first-hand,
durable, unannotated, on `/`, and carry the `project-created:<id>` idempotency
key; lookalike or cross-posted events cannot write label properties. No
directory lookup, mutable alias, or per-batch group update exists. The regular
stream occurrence still contains the complete project birth payload.

PostHog only links identified events to groups, so every event uses one stable
synthetic operational identity per deployment/project. This creates no
identity per stream or end user, while isolating PostHog's per-distinct-id
limiter: one unusually busy project cannot stall every project's durable feed.
The `$groups` property, not this synthetic identity, remains the project model.
Exact retries reuse the occurrence UUID. PostHog may deduplicate repeated UUIDs
asynchronously, so neither the feed nor this document claims exactly-once
storage. GeoIP remains disabled.

The receiver calls PostHog's supported EU `/batch/` endpoint directly rather
than introducing a buffered SDK with a second retry queue. It submits every
row in the delivered batch, and the stream cursor advances only after the
public endpoint returns HTTP success. HTTP and network failures reject the
delivery. There is one eight-second network timeout and no inner retry; the
stream spine is the single retry owner. Failures back off, then append a
durable `subscription-parked` fact after the bounded attempt limit. Operators
recover explicitly with resume/cursor-set; configuration is never silently
replaced.

The wire shape follows the batch endpoint rather than the single-event capture
example: `distinct_id` is inside each event's `properties`. This matters
because a malformed event can receive HTTP success and still be discarded by
PostHog's asynchronous ingestion pipeline.

That acknowledgement is deliberately described as **HTTP acceptance**, not
proof of final indexing. PostHog validates and ingests public capture requests
asynchronously; a 2xx can precede an ingestion warning, quota decision, or
drop, and its UUID deduplication is not an exactly-once contract. The source
stream is therefore the durable truth. Preview proves representative events
arrive and checks the ingestion-warning surface, while ongoing operation must
monitor PostHog ingestion warnings and compare source submissions with indexed
events. This PR does not claim an impossible synchronous end-to-end guarantee.

The capture request and custom `posthog.capture_stream_events` span expose only
bounded project coordinates, an opaque stream id, delivery id, attempt, and
event count.
Preview acceptance proof must show: a fresh stream, durable and ephemeral
custom events in the live PostHog feed under the same
project group, stable occurrence UUIDs across a forced transport retry, no
observed ingestion warning for the proof events, and the matching Cloudflare
custom span. No sampling is permitted.

### Worker exception ownership

- Use the supported edge/workerd export of `posthog-node`.
- The outer HTTP or logical-ITX operation owns unexpected terminal error
  capture exactly once. Inner code may enrich and rethrow but should not send.
- Pass the original `Error` to `captureExceptionImmediate`; the wide log keeps
  only its safe structural copy. PostHog capture must happen at the terminal
  catch while the original object is still available.
- Attach safe properties: error/log ID, deployment/release, operation name,
  connection/call IDs, trusted project group, and current distinct/session ID
  when available.
- Schedule delivery with `ExecutionContext.waitUntil`, zero retries, and a short
  edge timeout. PostHog failure cannot fail the request/RPC.
- Expected 4xx, validation, cancellation, deliberate WebSocket close, and normal
  reconnect are outcomes rather than exceptions.
- Generic thrown values remain unexpected errors. Treating a failure as
  expected requires a trusted typed domain classification at the operation
  boundary; never infer it from attacker-controlled messages, names, or status
  text. That classifier is follow-on work rather than a compatibility shim in
  the logger.
- Use automatic grouping first. Add a fingerprint only for a demonstrated
  grouping defect; never include request/user/project/call IDs in one.

### Browser ownership

The repo already initializes `posthog-js` with automatic exception capture and
TanStack already owns a root route error component. The missing gold path is:

- cache and pin PostHog initialization behavior across SDK upgrades;
- identify/reset on real authentication transitions;
- set a trusted project group;
- make the existing root route error component the single render-error owner
  rather than installing a second React boundary;
- explicitly capture genuinely handled terminal client failures;
- add only bounded, reviewed breadcrumbs around high-risk operations;
- classify intentional socket closes/reconnects as non-errors;
- scrub URL queries and captured network metadata; and
- upload browser source maps to PostHog with the immutable deployed release.

A Worker exception cannot itself trigger browser exception-based replay
retention. Return/propagate a stable safe `errorId`; the browser should emit a
non-exception `itx_server_error_observed` marker (or explicitly trigger replay
retention) with the same error/call IDs. The Worker remains sole owner of the
exception so one failure does not become two issues.

Session replay should begin privacy-first: mask inputs/text, scrub URLs and
network metadata, and never capture bodies, authorization, secrets, scripts,
prompts, or capability values. Verify that the pre-trigger replay buffer is
retained for a server error observed by the client.

## Logs in PostHog

Some accumulated logs may belong in PostHog because issue + replay + correlated
log investigation is useful. This does **not** mean sending every incidental
`console.log` as a product event.

Evaluate in this order:

1. PostHog Logs through a supported OTLP path, if Cloudflare can export only the
   intentional application-wide events and preserve searchable correlation.
2. A direct PostHog log sink for the same bounded final operation record,
   delivered through `waitUntil` and independent of product success.
3. Exception enrichment only, if separate log retention is not worthwhile.

Before enabling a second full copy, verify retention/cost, redaction ownership,
session-replay links, project grouping, and searchable call/error IDs. Do not
encode operational logs as arbitrary product analytics events.

## Source maps and releases

- Generate production browser and Worker source maps.
- Inject/upload browser source maps to PostHog before deployment with an
  immutable release, ideally the deployed git SHA/version.
- Enable Cloudflare source-map upload separately; the products need separate
  uploads.
- Use the same release in deployment fields, PostHog events, and Cloudflare
  structured logs.
- Acceptance-test minified browser and Worker throws and verify displayed
  source file, line, and release in both products.

## Follow-on operation adapters

The Cloudflare proof also covers dynamic-worker calls/fetches and semantic
alarm actions. Possible later operation adapters are:

- `waitUntil` children;
- queue batches and individual retryable work;
- inbound email delivery;
- stream-processor wake/catch-up operations;
- outbox/reconciler work.

## Production grill follow-ups (2026-07-13)

- The current Workers Observability API returns custom spans from `otel` and
  structured console events from `cloudflare-workers`; agents must search all
  datasets before declaring either side missing.
- Forty-six of 52 `alarm scheduler trigger due` spans in a roughly 21-minute
  sample requested no schedules. That wrapper also captured asynchronously
  launched work inconsistently, so the follow-on deletes it and lets the native
  alarm be the origin.
- `scheduler action invocation` now means exactly the dynamic-worker call and
  records execution ID plus `succeeded` / `failed`. Completion-event append is
  deliberately outside that span; a failed append still needs an execution-ID
  operation log before it becomes an easy production diagnosis.
- `alarm processor keepalive` still emits a zero-duration `not_due` span on a
  shared scheduler alarm. Consider suppressing that no-op only if a controlled
  trace proves the meaningful revival path remains obvious.
- A ten-minute production window contained 151 failed
  `UnauthenticatedOs.authenticate` spans. Establish whether these are expected
  credential denials; if so, classify them as an expected outcome rather than
  an operational error before building alerts or dashboards.

## Acceptance criteria

- [ ] Every OS fetch lane emits one bounded Cloudflare wide log; no sampling.
- [ ] N calls over one WebSocket emit N bounded semantic call logs/spans.
- [ ] Child logs contain parent IDs, never cloned parent payloads.
- [ ] A thrown ITX target value becomes one RPC-safe Error with an authoritative
      `itxCallId`; telemetry captures it once without arguments or server stack.
- [ ] A minified browser error is symbolicated and linked to identity, project,
      release, and replay.
- [ ] A server error observed in the browser retains replay without creating a
      second exception issue.
- [ ] Expected 4xx/cancel/close/reconnect outcomes create no PostHog issue.
- [ ] Logging failure cannot alter the product outcome.
- [ ] Secrets, bodies, scripts, prompts, arguments/results, auth headers, and
      query parameters are absent from logs, exceptions, and replay.
- [ ] Every fresh project stream receives the ordinary PostHog subscription
      during its birth sequence; there is no legacy scan, backfill, or
      compatibility path.
- [ ] A normal project script cannot call the first-party receiver directly;
      only the host-minted delivery purpose can resolve it, without protecting
      the subscription's key or lifecycle.
- [ ] Every durable and ephemeral row is submitted as one project-grouped
      occurrence; no type, success/error, or sampling selector exists.
- [ ] Only public-batch HTTP acceptance gates the durable cursor; transport
      failures eventually park, and the proof checks PostHog's asynchronous
      ingestion-warning surface without claiming exactly-once indexing.
- [ ] Each `stream:append` request contains the complete committed event through
      100 KiB, including payload, metadata, provenance, idempotency key, and raw
      stream path. Larger JSON is visibly and deterministically chopped, with
      original byte size and truncation indexed; no event-field allowlist,
      sampling, or event drop exists.
- [ ] Preview proof includes the PostHog live feed and its matching Cloudflare
      capture span for a fresh stream's durable and ephemeral rows.

## Primary references

- Misha's PR #1206: https://github.com/iterate/iterate/pull/1206
- Consolidated OS proof: https://github.com/iterate/iterate/pull/1933
- Minimal Cap'n Web package patch: `patches/capnweb@0.8.0.patch`
- Cloudflare custom spans:
  https://developers.cloudflare.com/workers/observability/traces/custom-spans/
- Cloudflare automatic span attributes:
  https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/
- Cloudflare trace limitations:
  https://developers.cloudflare.com/workers/observability/traces/known-limitations/
- Cloudflare Workers log-size limit:
  https://developers.cloudflare.com/workers/platform/limits/#log-size
- Cloudflare Workers RPC and promise pipelining:
  https://developers.cloudflare.com/workers/runtime-apis/rpc/
- PostHog exception capture: https://posthog.com/docs/error-tracking/capture
- PostHog React tracking: https://posthog.com/docs/error-tracking/installation/react
- PostHog Node/Worker tracking: https://posthog.com/docs/error-tracking/installation/node
- PostHog source maps: https://posthog.com/docs/error-tracking/upload-source-maps/web
- PostHog replay privacy:
  https://posthog.com/docs/session-replay/privacy
- PostHog logs and replay: https://posthog.com/docs/logs/link-session-replay
- PostHog group analytics: https://posthog.com/docs/product-analytics/group-analytics
- PostHog Capture API: https://posthog.com/docs/api/capture
