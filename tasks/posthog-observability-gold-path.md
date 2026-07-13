---
state: draft
priority: high
size: large
---

# Gold-path OS observability and PostHog integration

Research and implementation notes from 2026-07-13. This task is the durable
home for the PostHog design while the first proof lands through Cloudflare
Workers Observability and the Cap'n Web fork.

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
- explicit exit sinks for Cloudflare logs and PostHog;
- independent causal operations for `waitUntil`, outbox work, and other child
  work; and
- outside-in tests proving successful, expected, thrown, custom, and background
  outcomes are logged/captured exactly once.

Do not wholesale cherry-pick #1206. Improve these details while porting it:

- link children with `parentId`/`causationId`; never clone the full parent log;
- pass sinks explicitly and inherit them into child operations rather than
  mutating process-global exit-handler arrays;
- do not restore JSONata keep filters or sampling: emit every operation for now;
- bound message/error counts and serialized sizes instead of allowing an event
  to grow forever;
- do not restore Node filesystem buffers or development temp-log files;
- do not copy Hono/oRPC-specific boundaries into the current architecture;
- do not hand-build PostHog `$exception` payloads or manually parse stacks; and
- do not record URLs with query strings, bodies, headers, email addresses,
  scripts, prompts, capability arguments/results, tokens, or secrets.

## Current proof status

- Draft `iterate/iterate#1914` plus minimal `iterate/capnweb#3` proves one
  semantic custom span and one structured completion event per logical ITX call
  over a long-running WebSocket.
- Draft `iterate/iterate#1926` proves semantic alarm spans without inventing
  request parentage across the time boundary.
- Draft `iterate/iterate#1928` proves stateless, stateful, fetch-native, and
  loopback dynamic-worker spans. Cloudflare starts a separate trace at the
  `ctx.exports` boundary, so the proof reports both trace IDs honestly.
- Draft `iterate/iterate#1930` used the current evlog wrapper. It is superseded
  by the #1206 correction and should not be the logging foundation.
- The replacement first slice starts one revived wide-log operation at the
  outer OS `worker.fetch`, covering dashboard, API, webhook, project-fetch,
  HTTP-batch, and WebSocket-handshake lanes with one clean structured
  Cloudflare log line per request.

## ITX lifecycle

An ITX WebSocket is a long-running transport, not one logical application
operation. Its HTTP request log ends when the handshake response is returned.
Never retain one ever-growing log or span for the life of the socket.

Each logical call gets its own bounded operation and custom span:

```text
HTTP WebSocket handshake operation
  connectionId

ITX call operation + `itx <semantic method>` span
  connectionId
  callId
  serverSessionId
  trusted projectId, when known
  semantic target/method name
  outcome and duration
  parent operation id, when causally available
```

The span display name and log display name should be the same bounded semantic
name, for example `itx project.files.read`; never put arguments or results in a
span name. Multiple calls over one socket produce N small call events, not one
large session event.

The Cap'n Web fork should be minimal. The server-side `onCall(info, invoke)`
hook and promise-pipeline propagation are sufficient to wrap every call. A
smaller follow-up should test whether the client metadata/wire-format changes
in draft fork PR #3 can be deleted in favor of server-minted connection and
call IDs. Browser/PostHog identity may still need a small per-call metadata
envelope if a socket can outlive the current PostHog session; that decision
must not be conflated with trace IDs.

Cloudflare does not expose its native trace/span IDs to ordinary Worker code.
Do not invent fake IDs. Emitting the structured event while the custom span is
active gives Cloudflare the native association; shared application IDs provide
cross-product search.

## Cloudflare log contract

The target is one structured object per completed operation:

```ts
{
  schema: "iterate.wide-log.v1",
  log: { id, kind, parentId?, start, end, durationMs },
  service,
  deployment: { environment, workerName, version },
  outcome,
  http?: { requestId, method, path, status, cfRay, traceparent },
  ingress?: { lane, transport, projectId?, appSlug? },
  itx?: { connectionId, callId, displayName, targetKind, method },
  messages?,
  errors?,
  dropped?
}
```

The Cloudflare sink receives the object as one console argument, using error
severity only for an exception or server-error outcome. Sink failures produce
one terse diagnostic and never change the product result. All operations are
retained for now; hard bounds, classification, and safe fields are the volume
and privacy guardrails.

## PostHog investigation experience

For an unexpected browser or Worker failure an operator should be able to:

1. open one grouped, symbolicated PostHog issue;
2. see the user, trusted project, release, environment, logical ITX call, and
   transport connection;
3. open the relevant browser session replay;
4. find the corresponding Cloudflare log/trace through shared IDs; and
5. distinguish the underlying Worker failure from the browser observing it.

### Worker exception ownership

- Use the supported edge/workerd export of `posthog-node`.
- The outer HTTP or logical-ITX operation owns unexpected terminal error
  capture exactly once. Inner code may enrich and rethrow but should not send.
- Pass the original `Error` to `captureExceptionImmediate`; the wide log keeps a
  safe serialized copy while its runtime scope retains original error identity.
- Attach safe properties: error/log ID, deployment/release, operation name,
  connection/call IDs, trusted project group, and current distinct/session ID
  when available.
- Schedule delivery with `ExecutionContext.waitUntil`, zero retries, and a short
  edge timeout. PostHog failure cannot fail the request/RPC.
- Expected 4xx, validation, cancellation, deliberate WebSocket close, and normal
  reconnect are outcomes rather than exceptions.
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

After HTTP and ITX calls, use the same primitive for:

- `waitUntil` children;
- queue batches and individual retryable work;
- inbound email delivery;
- Durable Object alarms (new roots with scheduled-alarm correlation, not fake
  HTTP ancestry);
- stream-processor wake/catch-up operations;
- dynamic-worker calls and fetches; and
- outbox/reconciler work.

## Acceptance criteria

- [ ] Every OS fetch lane emits one bounded Cloudflare wide log; no sampling.
- [ ] N calls over one WebSocket emit N bounded semantic call logs/spans.
- [ ] Child logs contain parent IDs, never cloned parent payloads.
- [ ] A thrown Worker/ITX error is rethrown unchanged and captured once.
- [ ] A minified browser error is symbolicated and linked to identity, project,
      release, and replay.
- [ ] A server error observed in the browser retains replay without creating a
      second exception issue.
- [ ] Expected 4xx/cancel/close/reconnect outcomes create no PostHog issue.
- [ ] Sink timeout/failure cannot alter the product outcome.
- [ ] Secrets, bodies, scripts, prompts, arguments/results, auth headers, and
      query parameters are absent from logs, exceptions, and replay.

## Primary references

- Misha's PR #1206: https://github.com/iterate/iterate/pull/1206
- Current tracing POC: https://github.com/iterate/iterate/pull/1914
- Minimal Cap'n Web fork: https://github.com/iterate/capnweb/pull/3
- PostHog exception capture: https://posthog.com/docs/error-tracking/capture
- PostHog React tracking: https://posthog.com/docs/error-tracking/installation/react
- PostHog Node/Worker tracking: https://posthog.com/docs/error-tracking/installation/node
- PostHog source maps: https://posthog.com/docs/error-tracking/upload-source-maps/web
- PostHog replay privacy:
  https://posthog.com/docs/session-replay/privacy
- PostHog logs and replay: https://posthog.com/docs/logs/link-session-replay
