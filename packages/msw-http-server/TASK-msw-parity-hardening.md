---
state: in_progress
priority: p1
size: l
dependsOn: []
---

# Task: MSW Parity Hardening (v2)

## Why this file was refreshed

Previous version described earlier architecture. Current code has already shipped several fixes (lifecycle correctness, less private-MSW coupling, bypass semantics, ws bridge extraction). This task now focuses on what is still missing.

## Current code shape

Implementation:

- `packages/msw-http-server/src/create-native-msw-server.ts` (~732 LOC)
- `packages/msw-http-server/src/http-utils.ts` (~16 LOC)
- `packages/msw-http-server/src/websocket-upstream-bridge.ts` (~146 LOC)

Tests:

- `packages/msw-http-server/tests/create-native-msw-server.test.ts` (~105 LOC)
- `packages/msw-http-server/tests/handle-request-e2e.test.ts` (~506 LOC)
- `packages/msw-http-server/tests/transport-e2e.test.ts` (~489 LOC)

## Broad strokes design (today)

### HTTP request path

1. Convert incoming Node request to Fetch `Request`.
2. Optional transform (`transformRequest`) rewrites URL/headers.
3. Call MSW `handleRequest` with current request handlers.
4. If mocked:
   - emit `response:mocked`
   - call `onMockedResponse`
   - forward response to Node `res`.
5. If unhandled:
   - optional advanced override `onUnhandledHttpRequest`
   - otherwise bypass to real upstream via fetch
   - emit `response:bypass`
   - call `onPassthroughResponse`
   - forward passthrough response.

### WebSocket upgrade path

1. Build ws URL from incoming socket + optional transform.
2. Match MSW ws handlers.
3. If no match:
   - resolve unhandled action (`bypass` or `error`)
   - on bypass, bridge client <-> upstream websocket
   - on error, reject upgrade.

### Lifecycle/events model

- Adapter exposes setupServer-like methods (`use`, `resetHandlers`, `listHandlers`, `events`, etc).
- Lifecycle events are proxied through an adapter-owned emitter for known names:
  - `request:start`
  - `request:match`
  - `request:unhandled`
  - `request:end`
  - `response:mocked`
  - `response:bypass`
  - `unhandledException`
- Non-lifecycle names still go to native Node server events.

## What is done already

### Done 1: header overwrite bug addressed

Response headers are grouped before calling `res.setHeader`, so duplicate header names no longer overwrite by default.

### Done 2: lifecycle once/off mismatch fixed

`once` wrappers are tracked and `off` correctly removes wrapped listeners.

### Done 3: lifecycle detection fixed

No longer uses `event.includes(":")`; explicit event-name list includes `unhandledException`.

### Done 4: private MSW coupling reduced

- Handler type detection uses `instanceof RequestHandler/WebSocketHandler`.
- Adapter no longer reads private `msw.emitter`.
- Adapter now uses its own lifecycle emitter with `handleRequest`.

### Done 5: unhandled semantics updated

- Unhandled HTTP and ws bypass to real upstream by default strategy.
- Self-loop guards for bypass paths.
- Added `onPassthroughResponse` callback for recording/instrumentation.

## Remaining gaps (this is the real work now)

## Gap A: request abort propagation to handler signal (high)

Current `new Request(...)` has no abort signal wiring from Node request lifecycle.

Impact:

- Long handlers may continue work after client disconnect.
- `request.signal` listeners in handlers may never fire on client abort.

Design:

- Create `AbortController` per incoming HTTP request.
- Abort controller on:
  - `req.aborted`
  - `req.close` where socket closed before normal completion
  - defensive `req.error`.
- Pass `signal` into `new Request(...)`.
- Ensure listeners are detached when request handling completes.

## Gap B: response body streaming robustness (high)

Current stream forwarding is a simple read/write loop.

Missing behavior:

- backpressure (`res.write(...) === false` then wait `drain`)
- early destination close/error handling
- reader cancellation on destination termination
- explicit behavior for read errors after headers/chunks sent

Design:

- Introduce helper: `pipeWebResponseBodyToNode(res, body, context)`.
- Use `await once(res, "drain")` when backpressured.
- Stop writes if `res.destroyed` or `res.writableEnded`.
- On `res.close`/`res.error`, cancel reader.
- On read error:
  - if headers not sent, return controlled 502/500
  - if already sent, destroy socket and stop.

## Gap C: explicit set-cookie regression lock (medium)

Even though header grouping is in place, parity needs a hard test for `set-cookie` array behavior.

Design:

- Add test that returns two `Set-Cookie` values from an MSW handler.
- Assert Node client sees `res.headers["set-cookie"]` as two items.

## Gap D: parity-focused regression test file (medium)

Current tests are broad e2e. Need focused parity tests to catch edge regressions quickly.

Create:

- `packages/msw-http-server/tests/parity-regressions.test.ts`

Target cases:

1. multi-value `set-cookie` survives
2. `off` removes lifecycle `once`
3. `unhandledException` forwarded through adapter `on`
4. client abort triggers handler `request.signal`
5. stream error after partial write does not poison subsequent requests.

## Gap E: docs for intentional non-parity choices (low-medium)

Need explicit note on differences from `setupServer` expectations where intentional.

Candidates to document:

- unhandled bypass uses real upstream network
- self-loop protection behavior for HTTP/ws bypass
- optional advanced hooks (`onUnhandledHttpRequest`, `onUnhandledWebSocketUpgrade`, `onPassthroughResponse`).

## Implementation plan (v2)

### Phase 0: parity test harness first

- Add `parity-regressions.test.ts` with failing tests for Gap A/B/C.
- Keep tests isolated, no external network.

### Phase 1: abort plumbing

- Add abort controller wiring to request construction.
- Thread signal into `new Request`.
- Add cleanup semantics.

### Phase 2: stream pipe hardening

- Extract body pipe helper.
- Implement backpressure + cancellation + failure semantics.
- Preserve existing behavior for successful paths.

### Phase 3: header parity lock

- Add explicit set-cookie test.
- If needed, use `Headers.getSetCookie()` when available to guarantee exact cookie list semantics.

### Phase 4: docs

- Short README/task note for non-parity behaviors.

## Estimated LOC (remaining work)

These are realistic ranges, not optimistic minimums.

### Implementation LOC

- Abort propagation plumbing: `+30` to `+55`
- Stream pipe hardening helper + call-site integration: `+90` to `+160`
- Minor header parity adjustments (if needed): `+10` to `+25`
- Cleanup/refactor glue: `+20` to `+45`

Estimated implementation total: `+150` to `+285` LOC

### Test LOC

- New `parity-regressions.test.ts` scaffold + helpers: `+50` to `+90`
- A/B/C cases and assertions: `+140` to `+260`
- Small updates to existing tests for behavior shifts: `+20` to `+60`

Estimated test total: `+210` to `+410` LOC

### Documentation LOC

- Task/README parity notes: `+25` to `+70`

### Combined estimate

Net added LOC likely: `+385` to `+765`

Large variance driver is stream-failure test quality and how defensive the pipe helper becomes.

## Risk notes

- Highest risk: stream-hardening changes can subtly alter connection close behavior in existing transport tests.
- Medium risk: abort wiring can fire too aggressively if close semantics are not filtered.
- Low risk: set-cookie lock test should be straightforward.

## Validation checklist

Run at minimum:

- `pnpm --filter @iterate-com/msw-http-server typecheck`
- `pnpm --filter @iterate-com/msw-http-server test`

Recommended focused repeats after stream/abort work:

- `pnpm --filter @iterate-com/msw-http-server exec vitest run tests/transport-e2e.test.ts`
- `pnpm --filter @iterate-com/msw-http-server exec vitest run tests/parity-regressions.test.ts`

## Definition of done (v2)

- [ ] Added `tests/parity-regressions.test.ts` with abort + stream + set-cookie + lifecycle cases.
- [ ] Abort propagation wired into `Request.signal`.
- [ ] Response streaming path hardened for backpressure/close/error.
- [ ] Explicit `Set-Cookie` regression test passing.
- [ ] Existing suite still green.
- [ ] Non-parity behavior documented briefly.
