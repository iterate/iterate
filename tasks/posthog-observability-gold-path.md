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
low-cardinality without losing searchability. Never put arguments or results
in either. Multiple calls over one socket produce N small call events, not one
large session event.

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
- [ ] Logging failure cannot alter the product outcome.
- [ ] Secrets, bodies, scripts, prompts, arguments/results, auth headers, and
      query parameters are absent from logs, exceptions, and replay.

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
