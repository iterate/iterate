---
state: draft
priority: high
size: large
tags: [os, observability, posthog, logging, errors, session-replay]
---

# Gold-path PostHog observability for OS and itx

Research captured 2026-07-13 while separating the PostHog product design from
the first Cloudflare/capnweb distributed-tracing proof of concept.

This task deliberately does **not** decide that logs belong only in Cloudflare.
PostHog should at minimum own product-facing exception investigation, identity,
sessions, and replay, and selected structured logs may also belong in PostHog.
The implementation should establish the useful PostHog investigation experience
without duplicating every Cloudflare invocation record or turning console output
into an unbounded event stream.

## Desired investigation experience

For an unexpected browser or Worker failure, an operator should be able to:

1. open one grouped PostHog issue with a useful, symbolicated stack;
2. see the user, project, release, environment, logical itx call, and transport
   connection involved;
3. open the browser session replay when there was a browser session;
4. find the corresponding structured logs and Cloudflare trace using shared
   correlation fields;
5. distinguish one underlying failure from the browser observing a server
   failure; and
6. avoid leaking scripts, prompts, request bodies, secrets, tokens, email
   addresses, or sensitive URL query parameters into any telemetry sink.

## Current repository state

- OS currently depends on `posthog-js` 1.360.x. Current npm research found
  newer releases and recommends upgrading to at least 1.380 before relying on
  fetch tracing headers.
- `packages/shared/src/posthog/posthog.ts` implements the existing first-party
  proxy through the OS worker.
- `packages/shared/src/evlog/with-evlog.ts` emits one accumulated request-wide
  event and already preserves stable `appName` and `app.slug` fields for log
  queries/dashboards. Successful PostHog proxy asset traffic is filtered.
- The api/itx lane is not currently wrapped by `withEvlog`; the dashboard app
  lane is.
- The browser keeps one long-lived capnweb WebSocket per itx context. A PostHog
  session can rotate while that socket remains alive, so socket-handshake
  metadata is insufficient.
- PR #1206, "Add request-wide OS logging and PostHog error capture", previously
  provided request-wide async-local accumulation, structured errors, `waitUntil`
  handling, PostHog output, and strong outside-in integration tests. The current
  evlog is a smaller descendant, but its PostHog sink is absent.

## Correlation contract

Each logical itx call should carry a small observability envelope independent
of business arguments:

```ts
type ItxObservabilityContext = {
  connectionId: string;
  itxCallId: string;
  parentItxCallId?: string;
  posthogDistinctId?: string;
  posthogSessionId?: string;
  projectId?: string;
  environment: string;
  release: string;
};
```

The client must read the current PostHog identity/session when each call is
sent, not once when the WebSocket connects. `projectId`, authorization, and
other trusted tenant fields must be derived or verified on the server; client
telemetry metadata is correlation input, not authority.

Use the same `itxCallId`, `connectionId`, release, environment, and project ID
in PostHog exceptions/logs and Cloudflare structured events. Cloudflare does
not expose its native trace/span IDs to Worker application code, so do not
invent a field that pretends to be Cloudflare's trace ID. Shared-field search
is the initial bridge; a future exporter can provide a deeper link.

## Browser gold path

- Upgrade `posthog-js` and add `@posthog/react` if it is not already available.
- Initialize with a pinned `defaults` date so SDK upgrades cannot silently
  change collection behavior.
- Keep automatic unhandled exception and unhandled-rejection capture enabled.
- Install a root `PostHogErrorBoundary` for terminal React render failures.
- For a genuinely handled terminal client failure, call
  `posthog.captureException(error, properties)`. Do not construct `$exception`
  events manually.
- Keep console-error autocapture disabled. Explicit operational logs should use
  an intentional logger/sink rather than scraping incidental console output.
- Use `posthog.addExceptionStep(...)` for a few bounded, safe breadcrumbs before
  high-risk operations. These are attached to a later exception rather than
  emitted as separate product events.
- After authentication, call `identify(stableUserId)` and
  `group("project", stableProjectId)`. Reset on logout/identity transitions.
- On SDK versions supporting it, restrict `tracing_headers` to exact owned HTTP
  hostnames. This injects PostHog identity/session headers into fetch/XHR but
  does not cover WebSockets; itx still needs the per-call envelope.
- Treat validation failures, expected authorization failures, cancellation,
  intentional socket closes, and ordinary reconnects as outcomes rather than
  exceptions.
- Unexpected WebSocket termination may be captured with an explicit `Error`
  carrying the close code, phase, retry count, and connection ID. Suppress code
  1000 and deliberate shutdowns.

## Worker gold path

- Use the current `posthog-node` Worker/workerd edge export rather than a
  process-global Node autocapture integration.
- Capture unexpected terminal errors exactly once at the outer HTTP request or
  logical itx-call boundary. Inner code may enrich and rethrow, but must not
  capture an error that the boundary will capture again.
- Pass the original `Error` to `captureExceptionImmediate()` with:
  `distinctId`, `$session_id`, `$groups: { project: projectId }`, release,
  environment, operation/method, `itxCallId`, `connectionId`, safe request/CF
  metadata, and a stable application error ID.
- Schedule the immediate send with `ExecutionContext.waitUntil()`. PostHog
  failure must never fail the product call.
- Bound network timeouts/retries for the edge runtime; the SDK's ordinary Node
  retry defaults are too generous for an observability side effect.
- Validate Worker stack symbolication end to end. The edge build does not have
  Node filesystem source-context support.

## Server failures and browser replay

A Worker exception cannot directly trigger the browser SDK's exception-based
session-replay retention. The server should return a stable `errorId` for an
unexpected itx failure. The browser then emits a **non-exception** marker such
as `itx_server_error_observed`, sharing `errorId` and `itxCallId`, or explicitly
starts replay capture according to the chosen retention policy.

The Worker remains the sole owner of the `$exception`; the browser marker says
that the affected session observed it. This prevents two PostHog issues for one
underlying failure while retaining the replay buffer.

Recommended replay policy:

- low baseline recording plus 100% exception/session-trigger retention;
- mask all inputs and text initially, then selectively unmask reviewed UI;
- scrub URL queries and network metadata with
  `maskCapturedNetworkRequestFn`;
- never record bodies, authorization headers, secrets, scripts, prompts, or
  capability arguments; and
- verify that the pre-trigger buffer is present for server failures observed by
  the client.

## Logs in PostHog: decision to make

Selected logs should be available in PostHog when they materially improve the
issue + replay investigation. Candidate designs, in preferred evaluation order:

1. **PostHog Logs through OTLP.** Evaluate Cloudflare's native OTLP export or a
   small application OTLP sink into PostHog Logs. PostHog currently documents
   OTLP log ingestion for JavaScript/Node; Cloudflare's destination support
   should be verified against the actual account and PostHog region. Confirm
   whether filtering can restrict export to the intentional `os.evlog.v1`
   application events rather than all platform invocations.
2. **One direct structured log per completed operation.** Reuse the same
   accumulated wide event sent to Cloudflare, but send only errors, degraded
   outcomes, or slow/high-value calls to PostHog Logs. Delivery must be
   `waitUntil`-backed and failure-independent.
3. **Exception enrichment only.** Attach bounded breadcrumbs and final operation
   fields to exceptions, without a standalone PostHog log stream. This is the
   lowest-volume fallback but may be insufficient for investigating anomalous
   successful behavior.

Do not send every `console.log`, every Cap'n Web frame, or raw business inputs.
Do not encode logs as arbitrary product analytics events merely to make them
searchable. Decide retention, volume/cost budgets, and filtering before enabling
a second copy of every successful operation.

Questions the spike must answer:

- Can native Cloudflare OTLP export send only the desired application logs to
  PostHog, and can a PostHog log link directly to session replay?
- Does PostHog preserve `itxCallId`, project group, release, and session ID as
  first-class searchable fields?
- Are errors and slow successful operations enough, or should particular
  security/agent/dynamic-worker outcomes always be retained?
- Which sink owns redaction so Cloudflare and PostHog cannot diverge?
- Should the existing first-party PostHog proxy move to a dedicated Worker so
  ingestion traffic does not pollute OS invocation observability?

## Source maps and releases

- Generate production source maps for browser and Worker bundles.
- Run `posthog-cli sourcemap inject` before deployment and upload immediately
  with an explicit immutable release, ideally the deployed git SHA.
- Use the same release value in browser initialization, Worker exception/log
  properties, Cloudflare structured events, and deployments.
- Also enable Cloudflare `upload_source_maps: true`; Cloudflare and PostHog need
  their own uploads.
- Add a production-like acceptance test with minified browser and Worker throws
  and verify the displayed source file, line, and release in each product.

## Grouping and noise policy

- Start with PostHog's automatic grouping. Add `$exception_fingerprint` only
  after observing a concrete grouping defect.
- Never put request, user, project, connection, or call IDs into a fingerprint.
- Normalize wrapped/cause-chain errors without destroying the original stack.
- Classify known control-flow errors before the capture boundary.
- Do not randomly sample unexpected exceptions. Reduce noise by correct
  classification and single ownership.
- Apply `before_send` as the final redaction and known-benign-event guard, not as
  the primary application error classifier.

## What to retain from PR #1206

- illegal logging outside a real async-local scope;
- one post-hoc accumulated event at operation exit;
- structured custom errors and cause chains;
- bounded messages/breadcrumbs collected during the operation;
- causal context for `waitUntil` work;
- independently failing stdout/PostHog sinks; and
- outside-in integration tests covering success, expected 4xx, thrown 5xx,
  custom errors, warnings/info, and rejected background work.

Avoid restoring full parent-log cloning, Hono/oRPC-specific integration,
JSONata runtime filtering, local temp buffers, or duplicate catch/capture/rethrow
behavior.

## Acceptance criteria

- [ ] A minified unhandled browser error appears once, symbolicated, linked to
      user, project, release, and replay.
- [ ] A handled terminal Worker HTTP error appears once and is searchable in
      both PostHog and Cloudflare by request/error ID.
- [ ] An itx error on a long-lived socket after PostHog session rotation uses
      the current call's session ID, creates one Worker exception, and retains
      the affected browser replay through a non-exception marker.
- [ ] The selected PostHog Logs path is tested with success, slow, degraded, and
      error wide events; the retention/filter policy and volume budget are
      documented.
- [ ] Intentional close, validation, cancellation, and reconnect scenarios do
      not create exception issues.
- [ ] Secrets, bodies, scripts, prompts, auth headers, and query parameters are
      absent from captured events, logs, and replay.
- [ ] PostHog delivery failure does not alter product outcomes.

## Primary references

- PR #1206: https://github.com/iterate/iterate/pull/1206
- Exception capture: https://posthog.com/docs/error-tracking/capture
- Exception grouping: https://posthog.com/docs/error-tracking/grouping-issues
- Browser configuration: https://posthog.com/docs/libraries/js/config
- React error tracking: https://posthog.com/docs/error-tracking/installation/react
- Node/Worker error tracking: https://posthog.com/docs/error-tracking/installation/node
- Source maps: https://posthog.com/docs/error-tracking/upload-source-maps/web
- Replay retention triggers:
  https://posthog.com/docs/session-replay/how-to-control-which-sessions-you-record
- Replay privacy: https://posthog.com/docs/session-replay/privacy
- JavaScript logs: https://posthog.com/docs/logs/installation/javascript
- Node logs: https://posthog.com/docs/logs/installation/nodejs
- Link logs to replay: https://posthog.com/docs/logs/link-session-replay
- Cloudflare proxy: https://posthog.com/docs/advanced/proxy/cloudflare
