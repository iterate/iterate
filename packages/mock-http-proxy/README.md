# @iterate-com/mock-http-proxy

Minimal egress proxy for tests. Pass-through only. Records HAR for HTTP/SSE/WebSocket traffic.

## Goals

- Deterministically test Iterate deployments as distributed systems where the external interface is internet HTTP traffic.
- Avoid hitting real third-party APIs in end-to-end tests.
- Capture outbound traffic into HAR so you can inspect/debug/import runs.

## Assumption

This proxy expects traffic to be decrypted before it reaches this process.

- `CONNECT` tunneling is rejected in v1.
- In this scenario, TLS termination/decryption is handled by something else upstream.

## Usage

```ts
import { MockEgressProxy } from "@iterate-com/mock-http-proxy";

await using proxy = await MockEgressProxy.start({
  harRecordingPath: "/tmp/mock-http-proxy/traffic.har",
  port: 0,
  rewriteRequest: ({ url, headers }) => {
    const host = headers.host ?? "";
    if (!host.endsWith(".localhost:8080")) return;
    const originalHost = host.replace(/\.localhost:\d+$/, "");
    return {
      url,
      headers: {
        "x-iterate-original-host": originalHost,
        "x-iterate-original-proto": "https",
      },
    };
  },
});

// Point your SUT at proxy.url, then run test traffic.
```

Set target URL per request using `x-iterate-target-url`.

## HAR in Chrome

Recommended: use native Chrome/Edge DevTools directly.

When tests start, copy the first printed command and run it:

```bash
open /tmp/mock-http-proxy-har-...
```

Then in Chrome:

1. Press `Cmd+T`.
2. Open DevTools `Network` tab.
3. Drag the HAR file you want from that folder into the Network waterfall.

## Realistic test commands

OpenAI websocket-mode style app through proxy (test assumption: force plain `http:` traffic):

```bash
HTTP_PROXY=http://127.0.0.1:{port} OPENAI_API_KEY=dummy_api_key node tsx chatbot.ts
```

Example plain HTTP call for local test-only recording:

```bash
curl -i -x http://127.0.0.1:{port} http://api.openai.com/v1/models
```

Slack web API call through proxy (same test-only plain `http:` assumption):

```bash
HTTP_PROXY=http://127.0.0.1:{port} SLACK_BOT_TOKEN=xoxb-xxx node tsx slack-auth-test.ts
```

## Real HTTPS SDK test (OpenAI + Slack)

This package includes `tests/real-https-sdk-proxy.test.ts`, which:

- starts a local `http-mitm-proxy` instance as `HTTPS_PROXY`
- MITMs outbound TLS and rewrites to `MockEgressProxy` with:
  - `x-original-host`, `x-original-protocol`, `x-original-scheme`
  - `x-iterate-original-host`, `x-iterate-original-proto`
- runs tiny child TypeScript scripts via `tsx`:
  - `tests/fixtures/slack-vanilla.ts`
  - `tests/fixtures/openai-websocket-vanilla.ts`
- executes real `@slack/web-api` HTTP + OpenAI websocket-mode traffic
- records both flows in HAR via `MockEgressProxy`

Run with Doppler so the keys are injected:

```bash
doppler run --config dev -- pnpm --filter @iterate-com/mock-http-proxy test:real-https
```

Required env vars:

- `SLACK_BOT_TOKEN`
- `OPENAI_API_KEY`
- optional: `OPENAI_REALTIME_MODEL` (default: `gpt-realtime`)

## Future direction

- Replay/serve responses from saved HAR archives.
- Evolve into fuller third-party simulation.
