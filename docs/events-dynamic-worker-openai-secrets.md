# `apps/events` Dynamic Workers With `getIterateSecret(...)`

This document shows the full working flow for a dynamic worker processor that:

1. is authored as a normal `apps/events` processor
2. is bundled into a `dynamic-worker/configured` event
3. uses `getIterateSecret(...)` directly as the OpenAI API key
4. fetches through `DynamicWorkerEgressGateway`
5. resolves secrets from the `apps/events` secret store at runtime
6. appends the OpenAI response back into the stream

## Working example processor

The committed example lives at [simple-openai-loop.processor.ts](/Users/jonastemplestein/.superset/worktrees/iterate/discovered-ghost/apps/events/scripts/examples/simple-openai-loop.processor.ts).

The important part is the client construction:

```ts
const openai = new OpenAI({
  apiKey: "getIterateSecret({secretKey: 'dynamic_worker_openai_api_key'})",
  dangerouslyAllowBrowser: true,
});
```

This is no longer a placeholder. The dynamic worker emits the OpenAI request normally, and the outbound gateway rewrites any header value containing `getIterateSecret(...)` before the request leaves the worker.

## How secret resolution works

`DynamicWorkerEgressGateway` now receives:

- an optional explicit injected header pair
- a runtime snapshot of all `apps/events` secrets by `name`

When a dynamic worker does `fetch(...)`, the gateway:

1. copies the outbound request headers
2. applies any configured injected header
3. scans **all** outbound header values for `getIterateSecret(...)`
4. replaces each match with the real secret value from the `apps/events` secret store
5. logs a redacted audit line with header names and secret keys, never secret values
6. forwards the request

In v1 this substitution is **headers only** for `apps/events` dynamic workers.

## Building a configured event

You can bundle a current-shape processor into a dynamic-worker event with the `apps/events` CLI script:

```bash
pnpm --dir apps/events cli dynamic-worker-configured-event \
  --entry-file ./scripts/examples/simple-openai-loop.processor.ts \
  --slug simple-openai-loop \
  --outbound-gateway true
```

That command emits a `https://events.iterate.com/events/stream/dynamic-worker/configured` event payload with:

- the bundled processor in `payload.script`
- `payload.outboundGateway.entrypoint = "DynamicWorkerEgressGateway"`

No injected header props are needed when the processor itself uses `getIterateSecret(...)`.

## End-to-end proof flow

The committed proof runner is [prove-dynamic-openai-loop.ts](/Users/jonastemplestein/.superset/worktrees/iterate/discovered-ghost/apps/events/scripts/prove-dynamic-openai-loop.ts).

It does the full lifecycle against a real `apps/events` deployment:

1. customizes the example processor to use a unique temporary secret name
2. bundles it into a `dynamic-worker/configured` event
3. stores the bundled processor source as an `apps/events` secret
4. stores the real OpenAI API key as another `apps/events` secret
5. appends the configured event to a temporary stream
6. appends `llm-input-added` with `What is 50 - 8? Reply with only the number.`
7. waits up to 10 seconds for `llm-output-added`
8. asserts the response contains `42`
9. cleans up both secrets and the temporary stream

## Local proof

Start a local worker:

```bash
pnpm --dir apps/events dev
```

Then run the proof with a real OpenAI key from Doppler:

```bash
doppler run --project ai-engineer-workshop -- \
  env EVENTS_BASE_URL=http://localhost:5174 \
  pnpm --dir apps/events exec tsx ./scripts/prove-dynamic-openai-loop.ts
```

Expected shape of the output:

```json
{
  "ok": true,
  "elapsedMs": 4563,
  "eventTypes": [
    "https://events.iterate.com/events/stream/initialized",
    "https://events.iterate.com/events/stream/dynamic-worker/configured",
    "llm-input-added",
    "llm-output-added"
  ],
  "llmOutputPreview": "42"
}
```

## Preview proof

Deploy or refresh a preview slot for this PR:

```bash
doppler run --project os --config prd -- \
  pnpm preview deploy --app events --pull-request-number 1242
```

Then run the preview-targeted Vitest proof:

```bash
doppler run --project ai-engineer-workshop -- \
  env EVENTS_BASE_URL=https://events-preview-<slot>.iterate.workers.dev \
  pnpm --dir apps/events exec vitest run e2e/vitest/dynamic-worker-openai-preview.e2e.test.ts
```

That test:

1. builds the processor bundle
2. appends the configured event to the deployed preview worker
3. sends a math prompt
4. asserts that `llm-output-added` arrives within 10 seconds
5. asserts the response contains `42`

## Related files

- [dynamic-worker-egress-gateway.ts](/Users/jonastemplestein/.superset/worktrees/iterate/discovered-ghost/apps/events/src/dynamic-worker-egress-gateway.ts)
- [iterate-secret-references.ts](/Users/jonastemplestein/.superset/worktrees/iterate/discovered-ghost/apps/events/src/lib/iterate-secret-references.ts)
- [dynamic-openai-proof.ts](/Users/jonastemplestein/.superset/worktrees/iterate/discovered-ghost/apps/events/scripts/lib/dynamic-openai-proof.ts)
- [dynamic-worker-openai-preview.e2e.test.ts](/Users/jonastemplestein/.superset/worktrees/iterate/discovered-ghost/apps/events/e2e/vitest/dynamic-worker-openai-preview.e2e.test.ts)
