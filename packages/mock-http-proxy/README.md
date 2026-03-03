# @iterate-com/mock-http-proxy

Private workspace package for outbound HTTP/WebSocket egress mocking, passthrough proxying, and HAR record/replay.

## Package layout

- `src/server/`
  - `mock-http-server-fixture.ts`: main fixture (`useMockHttpServer`, `useMitmProxy`, `useTemporaryDirectory`)
  - `msw-server-adapter.ts`: HTTP + websocket bridge to MSW handlers
  - `proxy-request-transform.ts`: `Forwarded`-header URL rewrite helpers
- `src/har/`
  - `har-recorder.ts`: recorder API (`HarRecorder`)
  - `har-journal.ts`, `har-serialize.ts`: HAR assembly internals
  - `har-extensions.ts`: HAR extension types (websocket messages/resource type)
- `src/replay/`
  - `from-traffic-with-websocket.ts`: replay handlers from HAR (`@mswjs/source/traffic` + websocket replay)
- `src/integration/`
  - real-network and replay integration tests
  - `http-client-scripts/` and `fixtures/` used by those tests

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

## Test suites

Representative suites:

- adapter API + parity: [`src/server/msw-server-adapter.api.test.ts`](./src/server/msw-server-adapter.api.test.ts), [`src/server/msw-server-adapter.http-parity.test.ts`](./src/server/msw-server-adapter.http-parity.test.ts), [`src/server/msw-server-adapter.transport.test.ts`](./src/server/msw-server-adapter.transport.test.ts)
- recorder/unit: [`src/har/har-recorder.test.ts`](./src/har/har-recorder.test.ts)
- replay/unit: [`src/replay/from-traffic-with-websocket.test.ts`](./src/replay/from-traffic-with-websocket.test.ts)
- integration/replay + real egress:
  - [`src/integration/recording-shapes.integration.test.ts`](./src/integration/recording-shapes.integration.test.ts)
  - [`src/integration/har-replay.integration.test.ts`](./src/integration/har-replay.integration.test.ts)
  - [`src/integration/real-egress.integration.test.ts`](./src/integration/real-egress.integration.test.ts)

## Commands

All tests run through Doppler `dev` env.

- unit/core suites:
  - `pnpm --filter @iterate-com/mock-http-proxy test`
- integration (recording + replay):
  - `pnpm --filter @iterate-com/mock-http-proxy test:integration`
- external real-egress only (OpenAI/Slack/curl):
  - `pnpm --filter @iterate-com/mock-http-proxy test:external`
- everything:
  - `pnpm --filter @iterate-com/mock-http-proxy test:all`
