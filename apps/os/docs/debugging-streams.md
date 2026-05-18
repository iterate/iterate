# Debugging Streams

Use this when UI smokes are too indirect and you need to control the exact event
sequence on a project stream.

## Local Writer Into Preview Streams

Pick a preview project ID and write directly to its Events namespace. The
namespace host is `proj__<project-id-with-underscores>.events.iterate-preview-2.com`.

```bash
PROJECT_ID='os_01kr1jm1fwen8a789v0vffb2ty'
NAMESPACE="proj__${PROJECT_ID//-/_}"
STREAM='/agents/local-debug'
BASE_URL="https://${NAMESPACE}.events.iterate-preview-2.com/api/streams${STREAM}"

curl -fsS "$BASE_URL?beforeOffset=end" | tail -40
```

Append one event at a time so you can control offsets and timing:

```bash
curl -fsS -X POST "$BASE_URL" \
  -H 'content-type: application/json' \
  -d '{
    "type": "events.iterate.com/agent/system-prompt-updated",
    "idempotencyKey": "debug-system-prompt-v1",
    "payload": {
      "systemPrompt": "Reply with a fenced JavaScript async function and use ctx.chat.sendMessage({ message })."
    }
  }'
```

Then send user input:

```bash
curl -fsS -X POST "$BASE_URL" \
  -H 'content-type: application/json' \
  -d '{
    "type": "events.iterate.com/agent-chat/user-message-added",
    "payload": {
      "channel": "web",
      "content": "Say hello via ctx.chat.sendMessage."
    }
  }'
```

Use `sleep` between appends to isolate ordering bugs:

```bash
sleep 2
curl -fsS -X POST "$BASE_URL" \
  -H 'content-type: application/json' \
  -d '{
    "type": "events.iterate.com/agent/input-added",
    "payload": {
      "content": "late non-triggering context",
      "llmRequestPolicy": { "behaviour": "dont-trigger-request" }
    }
  }'
```

## Attach Or Remove Processors

To isolate runner behavior, write to a stream before any OS UI interaction has
created the `AgentDurableObject`, then manually wake the agent through OS2:

```bash
curl -fsS \
  "https://os.iterate-preview-2.com/api/projects/${PROJECT_ID}/agents/runtime-state${STREAM}"
```

After wake, inspect the stream and runtime state:

```bash
curl -fsS "$BASE_URL?beforeOffset=end" | tail -120

curl -fsS \
  "https://os.iterate-preview-2.com/api/projects/${PROJECT_ID}/agents/runtime-state${STREAM}" \
  | jq .
```

This is useful for confirming whether the failure is in:

- stream append ordering,
- subscriber delivery ordering,
- processor catch-up,
- processor side effects,
- or a specific provider such as `openai-ws`.

## Provider Comparison

Use two fresh sibling agent streams under the same project and prompt:

```bash
OPENAI_STREAM='/agents/debug-openai'
CLOUDFLARE_STREAM='/agents/debug-cloudflare'
```

For OpenAI WebSocket, append:

```bash
curl -fsS -X POST "https://${NAMESPACE}.events.iterate-preview-2.com/api/streams${OPENAI_STREAM}" \
  -H 'content-type: application/json' \
  -d '{
    "type": "events.iterate.com/openai-ws/config-updated",
    "payload": { "model": "gpt-5.5" }
  }'
```

For Cloudflare AI / AI Gateway, append:

```bash
curl -fsS -X POST "https://${NAMESPACE}.events.iterate-preview-2.com/api/streams${CLOUDFLARE_STREAM}" \
  -H 'content-type: application/json' \
  -d '{
    "type": "events.iterate.com/agent/llm-config-updated",
    "payload": {
      "model": "@cf/meta/llama-3.1-8b-instruct",
      "runOpts": { "gateway": { "id": "default" } },
      "debounceMs": 1000
    }
  }'
```

Then send the same `agent-chat/user-message-added` to both streams and compare
the time between:

- `events.iterate.com/agent/output-added`
- `events.iterate.com/codemode/script-execution-requested`

If OpenAI is slow and Cloudflare is not, look for hot-stream transcript fan-out:
`events.iterate.com/openai-ws/websocket-message-received` events between the LLM
request and output. Those raw events should remain in the stream, but runners
that do not consume them should not do meaningful work for each one.

## Subscription Transport Experiment

If raw-event fan-out is still expensive after no-op processor skips are in
place, compare the current per-event callable RPC delivery against a WebSocket
fetch delivery into the same `AgentDurableObject`.

The experiment should keep everything else constant:

- same project,
- same stream path,
- same provider,
- same prompt,
- same number of raw provider transcript events.

Shape to try:

```bash
# Terminal 1: connect a future AgentDurableObject stream-subscription WebSocket.
curl -i -N \
  -H 'upgrade: websocket' \
  "https://os.iterate-preview-2.com/api/projects/${PROJECT_ID}/agents/runtime-state${STREAM}?transport=websocket-subscription"

# Terminal 2: append controlled events into the stream as above.
curl -fsS -X POST "$BASE_URL" \
  -H 'content-type: application/json' \
  -d '{
    "type": "events.iterate.com/agent-chat/user-message-added",
    "payload": {
      "channel": "web",
      "content": "Trigger the same codemode reply."
    }
  }'
```

Compare:

- stream offset append time from the local append log,
- first delivery time recorded in `AgentDurableObject` runtime state,
- total `afterAppend` span duration in Cloudflare traces,
- time from `agent/llm-request-completed` to
  `codemode/script-execution-requested`.

This is only useful if it changes delivery transport without changing processor
semantics. Raw events still need to be written into the stream.

## Cloudflare Traces

For preview trace work, query the `os-preview-2` script in the iterate dev/stg
Cloudflare account. Useful filters:

- `cloudflare.script_name = os-preview-2`
- timeframe around the stream event timestamps
- `traceId` from trace summary into `view: "events"`

The most useful span keys so far are:

- `jsrpc.method`
- `cloudflare.durable_object.kv.query.keys`
- `durationMS`

In the `/agents/yoooo` investigation, traces showed many `afterAppend` RPCs and
KV reads/writes for raw OpenAI WebSocket transcript events before codemode
execution began.
