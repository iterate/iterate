# `apps/events` OpenAI Proofs: Dynamic Workers and Deployed Processor Runtimes

This document records the two OpenAI execution paths that are working in this
branch and how to prove them:

1. a dynamic worker bundled from source and configured by
   `stream/dynamic-worker/configured`
2. a deployed Hono app on Cloudflare Workers receiving pushed events over
   `websocket` or `webhook` subscriptions

Both paths use the normal workshop `defineProcessor()` contract.

## Dynamic worker: bundled from source with `getIterateSecret(...)`

The committed example processor lives at
[apps/events/scripts/examples/simple-openai-loop.processor.ts](../apps/events/scripts/examples/simple-openai-loop.processor.ts).

It uses a real OpenAI client with a secret placeholder in the API key:

```ts
const openai = new OpenAI({
  apiKey: "getIterateSecret({secretKey: 'dynamic_worker_openai_api_key'})",
  dangerouslyAllowBrowser: true,
});
```

At runtime, the `DynamicWorkerEgressGateway` rewrites that placeholder from the
`apps/events` secret store before the outbound OpenAI request leaves the worker.

### Build a configured event from source

```bash
pnpm --dir apps/events cli dynamic-worker-configured-event \
  --entry-file ./scripts/examples/simple-openai-loop.processor.ts \
  --slug simple-openai-loop \
  --outbound-gateway true
```

That emits a
`https://events.iterate.com/events/stream/dynamic-worker/configured` event with
the bundled script in `payload.script`.

### Proof script

The reusable proof runner is
[apps/events/scripts/prove-dynamic-openai-loop.ts](../apps/events/scripts/prove-dynamic-openai-loop.ts).
It does the full loop:

1. copies the example processor
2. rewrites the secret key name to a unique temporary secret
3. bundles the processor from source
4. stores the real OpenAI API key in the `apps/events` secret store
5. appends `stream/dynamic-worker/configured`
6. appends `agent-input-added`
7. waits for `agent-output-added`
8. asserts the answer contains `42`
9. cleans up the temporary secret and stream

### Local proof

Start local `apps/events`:

```bash
pnpm --dir apps/events dev
```

Then run:

```bash
doppler run --project ai-engineer-workshop -- \
  env EVENTS_BASE_URL=http://127.0.0.1:5173 \
  pnpm --dir apps/events exec tsx ./scripts/prove-dynamic-openai-loop.ts
```

The successful output from this branch included:

```json
{
  "ok": true,
  "eventTypes": [
    "https://events.iterate.com/events/stream/initialized",
    "https://events.iterate.com/events/stream/dynamic-worker/configured",
    "agent-input-added",
    "agent-output-added"
  ],
  "agentOutputPreview": "42"
}
```

### Preview proof

Use the PR preview URL:

```bash
doppler run --project ai-engineer-workshop -- \
  env EVENTS_BASE_URL=https://events-preview-1.iterate.workers.dev \
      OPENAI_API_KEY="$OPENAI_API_KEY" \
  pnpm --dir apps/events test:e2e:openai-preview
```

The underlying test is
[apps/events/e2e/vitest/dynamic-worker-openai-preview.e2e.test.ts](../apps/events/e2e/vitest/dynamic-worker-openai-preview.e2e.test.ts).

## Deployed processor runtime: pushed events over websocket or webhook

The worker example lives in
[ai-engineer-workshop/examples/deployed-processor](../ai-engineer-workshop/examples/deployed-processor).

Key files:

- [src/worker.ts](../ai-engineer-workshop/examples/deployed-processor/src/worker.ts)
- [src/hono-processor-runtime.ts](../ai-engineer-workshop/examples/deployed-processor/src/hono-processor-runtime.ts)
- [src/openai-agent-processor.ts](../ai-engineer-workshop/examples/deployed-processor/src/openai-agent-processor.ts)
- [src/ping-pong-processor.ts](../ai-engineer-workshop/examples/deployed-processor/src/ping-pong-processor.ts)

This runtime uses the same shared workshop processor shape as the other
examples. The Hono app only provides:

- `GET /` for human-readable usage text and concrete subscription events
- `GET /after-event-handler` for websocket delivery
- `POST /after-event-handler` for webhook delivery

Streams opt in by appending
`https://events.iterate.com/events/stream/subscription/configured`.

The callback URL may also include `projectSlug=...` when the target events
service is multi-project. Local `apps/events` and preview proofs in this branch
used `projectSlug=test`.

### Local proof

Start both local services:

```bash
pnpm --dir apps/events dev
pnpm --dir ai-engineer-workshop/examples/deployed-processor dev
```

The reusable proof runner is
[apps/events/scripts/prove-pushed-processor.ts](../apps/events/scripts/prove-pushed-processor.ts).
It appends the subscription event, appends one source event, waits for the
derived output, prints the resulting event types, and destroys the stream.

Ping over websocket:

```bash
pnpm --dir apps/events exec tsx ./scripts/prove-pushed-processor.ts
```

Ping over webhook:

```bash
SUBSCRIBER_TYPE=webhook \
  pnpm --dir apps/events exec tsx ./scripts/prove-pushed-processor.ts
```

OpenAI over websocket:

```bash
PROCESSOR_KIND=openai-agent \
  pnpm --dir apps/events exec tsx ./scripts/prove-pushed-processor.ts
```

OpenAI over webhook:

```bash
PROCESSOR_KIND=openai-agent SUBSCRIBER_TYPE=webhook \
  pnpm --dir apps/events exec tsx ./scripts/prove-pushed-processor.ts
```

This branch was verified locally for all four combinations:

- ping/pong over `websocket`
- ping/pong over `webhook`
- OpenAI over `websocket`
- OpenAI over `webhook`

Observed local OpenAI streams ended with:

```json
[
  "https://events.iterate.com/events/stream/initialized",
  "https://events.iterate.com/events/stream/subscription/configured",
  "user-message",
  "openai-response-output",
  "assistant-message"
]
```

and the assistant payload contained `"42"`.

### Deploy the worker

```bash
pnpm exec wrangler deploy
```

The current deployment URL used for validation was:

```text
https://ai-engineer-workshop-deployed-processor.iterate.workers.dev
```

### Proving the deployed worker against real `events.iterate.com`

There is one important nuance today:

- the public `events.iterate.com` service does not yet run this branch’s
  `external-subscriber` builtin processor

That means public
`stream/subscription/configured` events are stored, but they do not fan out
automatically yet. So the production proof for this branch uses the deployed
worker’s real callback endpoints directly against real public stream events.

That validation still proves the two important things:

1. the deployed Hono runtime accepts real callback traffic over both transports
2. the processor logic appends back into real `events.iterate.com` streams

This branch re-proved all four direct callback combinations against the deployed
worker:

- ping over `webhook`
- ping over `websocket`
- OpenAI over `webhook`
- OpenAI over `websocket`

Observed deployed OpenAI event types:

```json
[
  "https://events.iterate.com/events/stream/initialized",
  "user-message",
  "openai-response-output",
  "assistant-message"
]
```

and the assistant payload again contained `"42"`.

### Preview validation for `apps/events`

The preview URL in PR #1254 was:

```text
https://events-preview-1.iterate.workers.dev
```

These preview-targeted validations passed in this branch:

```bash
doppler run --project ai-engineer-workshop -- \
  env EVENTS_BASE_URL=https://events-preview-1.iterate.workers.dev \
  pnpm --dir apps/events exec tsx ./scripts/prove-dynamic-openai-loop.ts

doppler run --project ai-engineer-workshop -- bash -lc '
  export EVENTS_BASE_URL=https://events-preview-1.iterate.workers.dev
  pnpm --dir apps/events test:e2e:openai-preview
'

EVENTS_BASE_URL=https://events-preview-1.iterate.workers.dev \
  pnpm --dir apps/events test:e2e:preview
```

### Why the deployed worker does not fully prove against the preview URL

The remaining gap is specifically:

- preview `apps/events` on `workers.dev`
- calling into the already deployed Hono processor worker on `workers.dev`

The deployed processor worker does receive the callback request, but then fails
when it tries to fetch the preview events service as its upstream.

Observed deployed worker log excerpt:

```json
{
  "status": 404,
  "message": "Not Found",
  "data": {
    "body": "error code: 1042"
  }
}
```

That failure showed up both when:

- the preview `external-subscriber` builtin tried to fan out to the deployed
  worker, and
- the deployed worker callback endpoint was invoked directly with
  `baseUrl=https://events-preview-1.iterate.workers.dev`

So the current limitation is not the processor runtime itself. The limitation
is that this deployed worker cannot use the PR preview `workers.dev` URL as its
upstream events service.

Practically, the proof matrix for this branch is therefore:

- local `apps/events` -> local deployed-processor worker: fully proven
- deployed processor worker -> public `events.iterate.com`: fully proven
- local scripts + preview URL for `apps/events`: fully proven
- deployed processor worker -> preview `workers.dev` URL: currently blocked by
  Cloudflare `error code: 1042`

## Full validation matrix run on this branch

These all passed during the final hardening pass:

- `pnpm --dir apps/events-contract typecheck`
- `pnpm --dir apps/events-contract test`
- `pnpm --dir apps/events test`
- `pnpm --dir apps/events build`
- `pnpm --dir ai-engineer-workshop typecheck`
- `pnpm --dir ai-engineer-workshop/examples/deployed-processor typecheck`
- `pnpm --dir ai-engineer-workshop/examples/deployed-processor build`
- `doppler run --project ai-engineer-workshop -- env EVENTS_BASE_URL=http://127.0.0.1:5173 pnpm --dir apps/events exec tsx ./scripts/prove-dynamic-openai-loop.ts`
- `doppler run --project ai-engineer-workshop -- env EVENTS_BASE_URL=https://events-preview-1.iterate.workers.dev pnpm --dir apps/events exec tsx ./scripts/prove-dynamic-openai-loop.ts`
- local pushed-processor proof for ping/websocket
- local pushed-processor proof for ping/webhook
- local pushed-processor proof for OpenAI/websocket
- local pushed-processor proof for OpenAI/webhook
- deployed worker direct callback proof against real `events.iterate.com` for ping/webhook
- deployed worker direct callback proof against real `events.iterate.com` for ping/websocket
- deployed worker direct callback proof against real `events.iterate.com` for OpenAI/webhook
- deployed worker direct callback proof against real `events.iterate.com` for OpenAI/websocket
- `doppler run --project ai-engineer-workshop -- bash -lc 'export EVENTS_BASE_URL=https://events-preview-1.iterate.workers.dev; pnpm --dir apps/events test:e2e:openai-preview'`
- `EVENTS_BASE_URL=https://events-preview-1.iterate.workers.dev pnpm --dir apps/events test:e2e:preview`
- preview -> deployed-worker pushed-processor proofs were attempted for both
  `websocket` and `webhook`, and both failed with Cloudflare `error code: 1042`
  when the deployed worker tried to fetch the preview `workers.dev` upstream
