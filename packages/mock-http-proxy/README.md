# @iterate-com/mock-http-proxy

Private workspace package for outbound HTTP/WebSocket egress mocking, passthrough proxying, and HAR record/replay.

## Package layout

- `src/server/`
  - `mock-http-server-fixture.ts`: main fixture (`useMockHttpServer`, `useMitmProxy`, `useTemporaryDirectory`)
  - `msw-server-adapter.ts`: HTTP + websocket bridge to MSW handlers
  - `proxy-request-transform.ts`: `x-forwarded-host`/`x-forwarded-proto` URL rewrite helpers
- `src/har/`
  - `har-recorder.ts`: recorder API (`HarRecorder`)
  - `har-journal.ts`, `har-serialize.ts`: HAR assembly internals
  - `har-extensions.ts`: HAR extension types (websocket messages/resource type)
- `src/replay/`
  - `from-traffic-with-websocket.ts`: replay handlers from HAR (`@mswjs/source/traffic` + websocket replay)
- `src/integration/`
  - non-internet higher-level tests + fixtures/scripts
- `e2e-tests/`
  - internet-hitting tests (requires Doppler env)

## Public exports

From [`src/index.ts`](./src/index.ts):

- `useMockHttpServer`
- `useMitmProxy`
- `useTemporaryDirectory`
- `fromTrafficWithWebSocket`
- `createProxyRequestTransform`
- `createProxyWebSocketUrlTransform`
- `HarRecorder`
- HAR extension types

## `useMockHttpServer` fixture contract

Source: [`src/server/mock-http-server-fixture.ts`](./src/server/mock-http-server-fixture.ts)

Defaults and behavior:

- default `onUnhandledRequest` is `"error"`
- register handlers at runtime via `.use(...)`
- no constructor `handlers`
- no `proxyUrl()`

Fixture API surface:

- SetupServerApi subset: `use`, `resetHandlers`, `restoreHandlers`, `listHandlers`, `events`
- Fixture fields: `url`, `host`, `port`, `close()`, `getHar()`, `writeHar()`

## Test types

We only use two categories:

1. Unit tests (no internet, no Doppler required)

- `pnpm --filter @iterate-com/mock-http-proxy test`
- Includes server/har/replay tests and local non-internet integration tests.

2. E2E tests (internet + secrets required)

- `pnpm --filter @iterate-com/mock-http-proxy test:e2e`
- Runs [`e2e-tests/real-egress.e2e.test.ts`](./e2e-tests/real-egress.e2e.test.ts) via `doppler run --config dev`.

Representative suites:

- unit/server parity: [`src/server/msw-server-adapter.http-parity.test.ts`](./src/server/msw-server-adapter.http-parity.test.ts)
- unit/recorder: [`src/har/har-recorder.test.ts`](./src/har/har-recorder.test.ts)
- unit/replay: [`src/replay/from-traffic-with-websocket.test.ts`](./src/replay/from-traffic-with-websocket.test.ts)
- unit/non-internet integration: [`src/integration/recording-shapes.integration.test.ts`](./src/integration/recording-shapes.integration.test.ts), [`src/integration/har-replay.integration.test.ts`](./src/integration/har-replay.integration.test.ts)
- e2e/internet: [`e2e-tests/real-egress.e2e.test.ts`](./e2e-tests/real-egress.e2e.test.ts)
