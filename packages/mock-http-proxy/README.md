# @iterate-com/mock-http-proxy

Internal test utilities for outbound HTTP/WebSocket egress mocking + HAR record/replay.

## Status

This package is private to this monorepo.

## Exports

- `useMockHttpServer()` / `useMitmProxy()` / `useTemporaryDirectory()`
- `fromTrafficWithWebSocket()`
- `createProxyRequestTransform()` / `createProxyWebSocketUrlTransform()`
- `HarRecorder`
- HAR extension types from `har-type.ts`

## Minimal usage

```ts
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";

await using server = await useMockHttpServer({
  recorder: { harPath: "/tmp/egress.har" },
  onUnhandledRequest: "bypass",
});

// Point your app's outbound proxy to server.url.
```

## Replay from HAR

```ts
import { fromTrafficWithWebSocket, useMockHttpServer } from "@iterate-com/mock-http-proxy";

const handlers = fromTrafficWithWebSocket(harArchive);
await using server = await useMockHttpServer({
  handlers,
  recorder: { harPath: "/tmp/replay-output.har" },
  onUnhandledRequest: "error",
});
```

## Real-network scenario tests

Run with Doppler secrets:

```bash
doppler run --config dev -- pnpm --filter @iterate-com/mock-http-proxy test:real-https
```

This executes `src/api-i-want/api-i-want.test.ts`.
