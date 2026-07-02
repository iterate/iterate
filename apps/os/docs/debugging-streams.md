# Debugging Streams

Use this when UI smokes are too indirect and you need to control the exact event
sequence on a project stream. Current stream access for OS projects goes through
itx handles.

## Read A Project Stream

```bash
doppler run --project os --config preview_2 -- pnpm --dir apps/os cli itx run \
  --context <prj_id> \
  -e 'return await itx.streams.get("/agents/local-debug").getEvents({ limit: 100 })'
```

## Append Controlled Events

Append one event at a time so you can control offsets and timing:

```bash
doppler run --project os --config preview_2 -- pnpm --dir apps/os cli itx run \
  --context <prj_id> \
  -e 'return await itx.streams.get("/agents/local-debug").append({ type: "events.iterate.com/agents/user-message-received", payload: { content: "Say hello via itx.chat.sendMessage.", origin: "web" } })'
```

Then wait for the agent response:

```bash
doppler run --project os --config preview_2 -- pnpm --dir apps/os cli itx run \
  --context <prj_id> \
  -e 'return await itx.streams.get("/agents/local-debug").waitForEvent({ afterOffset: 0, timeoutMs: 180000, eventTypes: ["events.iterate.com/agents/web-message-sent"] })'
```

## Inspect Runtime State

For agent streams, use the agent's processor surface:

```bash
doppler run --project os --config preview_2 -- pnpm --dir apps/os cli itx run \
  --context <prj_id> \
  --eval 'return await itx.agents.get("/agents/local-debug").processor.getRuntimeState()'
```

This is useful for confirming whether a failure is in stream append ordering,
subscriber delivery, processor catch-up, provider execution, or the final itx
script that sends the user-visible response.

## Provider Comparison

Use two fresh sibling agent streams under the same project and send the same
message through `pnpm cli itx agent-smoke` or
`itx.agents.get(path).sendMessage(message)`. Compare the stream events around:

- `events.iterate.com/openai-ws/llm-request-started`
- `events.iterate.com/openai-ws/llm-request-completed`
- `events.iterate.com/itx/script-execution-requested`
- `events.iterate.com/itx/script-execution-completed`
- `events.iterate.com/agents/web-message-sent`

If raw provider transcript events dominate the stream before script execution
starts, inspect Cloudflare traces for stream subscriber delivery and processor
runtime spans.

## Cloudflare Traces

For preview trace work, query the preview OS workers in the iterate dev/preview
Cloudflare account. Useful filters:

- `cloudflare.script_name = os-preview-N`
- timeframe around the stream event timestamps
- `traceId` from trace summary into `view: "events"`

The most useful span keys so far are:

- `jsrpc.method`
- `cloudflare.durable_object.kv.query.keys`
- `durationMS`
