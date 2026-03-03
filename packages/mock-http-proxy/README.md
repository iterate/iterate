# @iterate-com/mock-http-proxy

MSW-backed egress test harness for Node services.

Use it to:

- run a local HTTP/WebSocket egress endpoint (`useMockHttpServer`)
- optionally force outbound traffic through a MITM proxy (`useMitmProxy`)
- record HAR (including websocket frames)
- replay HAR traffic deterministically (`fromTrafficWithWebSocket`)

Goal: record real internet traffic once, then replay it in deterministic tests without calling third-party APIs.

## What You Get

- HTTP + WebSocket interception via MSW server adapter
- optional MITM proxy layer for transparent interception from clients that only support proxy env/flags
- HAR recording with websocket extension fields (`_resourceType`, `_webSocketMessages`)
- HAR replay from `@mswjs/source/traffic` + websocket session replay

Main implementation:

- [`src/server/mock-http-server-fixture.ts`](./src/server/mock-http-server-fixture.ts)
- [`src/har/har-recorder.ts`](./src/har/har-recorder.ts)
- [`src/replay/from-traffic-with-websocket.ts`](./src/replay/from-traffic-with-websocket.ts)

## Core API

From [`src/index.ts`](./src/index.ts):

- `useMockHttpServer`
- `useMitmProxy`
- `useTemporaryDirectory`
- `fromTrafficWithWebSocket`
- `createProxyRequestTransform`
- `createProxyWebSocketUrlTransform`
- `HarRecorder`

### `useMockHttpServer` defaults

- default `onUnhandledRequest`: `"error"`
- runtime handler registration: `server.use(...)`
- fixture fields: `url`, `host`, `port`, `close()`, `getHar()`, `writeHar()`

### `useMitmProxy` option

```ts
await useMitmProxy({ proxyTargetUrl: egress.url });
```

`envForNode()` returns proxy + CA env vars (`HTTP_PROXY`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, etc).

## Record Real Traffic Then Replay

```ts
import { readFile } from "node:fs/promises";
import {
  fromTrafficWithWebSocket,
  useMockHttpServer,
  type HarWithExtensions,
} from "@iterate-com/mock-http-proxy";

// replay from previously recorded HAR
const har = JSON.parse(await readFile("./traffic.har", "utf8")) as HarWithExtensions;

await using egress = await useMockHttpServer({
  onUnhandledRequest: "error",
});

egress.use(...fromTrafficWithWebSocket(har));
```

## Example: curl OpenAI Responses API Through MITM And Record HAR

```ts
import { x } from "tinyexec";
import { useMitmProxy, useMockHttpServer } from "@iterate-com/mock-http-proxy";

await using egress = await useMockHttpServer({
  recorder: { harPath: "./openai-responses-recorded.har" },
  onUnhandledRequest: "bypass", // allow real upstream requests
});

await using mitm = await useMitmProxy({
  proxyTargetUrl: egress.url,
});

const mitmEnv = mitm.envForNode();

await x(
  "curl",
  [
    "--silent",
    "--show-error",
    "--fail",
    "--proxy",
    mitm.url,
    "--proxy-cacert",
    mitmEnv.NODE_EXTRA_CA_CERTS,
    "https://api.openai.com/v1/responses",
    "-H",
    `Authorization: Bearer ${process.env.OPENAI_API_KEY}`,
    "-H",
    "Content-Type: application/json",
    "-d",
    JSON.stringify({
      model: "gpt-5.2",
      input: "Say hello in one short sentence.",
    }),
  ],
  { throwOnError: true, nodeOptions: { stdio: "inherit" } },
);

await egress.writeHar(); // writes ./openai-responses-recorded.har
```

## Example: curl OpenAI Responses API Through MITM With Mocked Response

```ts
import { x } from "tinyexec";
import { http, HttpResponse } from "msw";
import { useMitmProxy, useMockHttpServer } from "@iterate-com/mock-http-proxy";

await using egress = await useMockHttpServer({
  recorder: { harPath: "./openai-responses-mocked.har", includeHandledRequests: true },
  onUnhandledRequest: "error",
});

egress.use(
  http.post("https://api.openai.com/v1/responses", () => {
    return HttpResponse.json({
      id: "resp_mock_123",
      object: "response",
      output_text: "hello from mock",
    });
  }),
);

await using mitm = await useMitmProxy({
  proxyTargetUrl: egress.url,
});

const mitmEnv = mitm.envForNode();

await x(
  "curl",
  [
    "--silent",
    "--show-error",
    "--fail",
    "--proxy",
    mitm.url,
    "--proxy-cacert",
    mitmEnv.NODE_EXTRA_CA_CERTS,
    "https://api.openai.com/v1/responses",
    "-H",
    "Authorization: Bearer sk-test-mocked",
    "-H",
    "Content-Type: application/json",
    "-d",
    JSON.stringify({ model: "gpt-5.2", input: "ignored by mock" }),
  ],
  { throwOnError: true, nodeOptions: { stdio: "inherit" } },
);

await egress.writeHar(); // writes ./openai-responses-mocked.har
```

## Validate Locally

- Unit/integration (no internet):
  - `pnpm --filter @iterate-com/mock-http-proxy test`
- Internet e2e (Doppler creds required):
  - `pnpm --filter @iterate-com/mock-http-proxy test:e2e`
