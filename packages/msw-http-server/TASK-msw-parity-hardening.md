---
state: todo
priority: p1
size: l
dependsOn: []
---

# Task: Make `@iterate-com/msw-http-server` closer to MSW-native semantics

## Goal

Make the native HTTP server adapter feel MSW-idiomatic while keeping real socket/server behavior.

Concretely:

- keep API + lifecycle behavior as close as possible to `setupServer` expectations;
- harden transport correctness (abort, streaming errors, multi-value headers);
- reduce accidental coupling to MSW internals where feasible;
- codify all parity claims with tests.

## Current package files

- Implementation: `packages/msw-http-server/src/create-native-msw-server.ts`
- API export: `packages/msw-http-server/src/index.ts`
- Tests:
  - `packages/msw-http-server/tests/create-native-msw-server.test.ts`
  - `packages/msw-http-server/tests/handle-request-e2e.test.ts`
  - `packages/msw-http-server/tests/transport-e2e.test.ts`

## Why this task exists (local code references)

### 1) Multi-value response headers (`Set-Cookie`) are overwritten

Current code sets headers one-by-one:

- `create-native-msw-server.ts:214-216`

Using `res.setHeader(key, value)` repeatedly overwrites prior values for the same key. This is a correctness bug for `set-cookie`.

### 2) Stream error path can break response handling after headers already sent

Current flow:

- stream loop writes chunks: `create-native-msw-server.ts:218-224`
- outer `catch` writes `500`: `create-native-msw-server.ts:309-312`

If body streaming fails after first chunk, writing a new status/header in catch is invalid and can throw `ERR_HTTP_HEADERS_SENT`.

### 3) Request abort is not wired into Fetch `Request.signal`

Current request conversion:

- `create-native-msw-server.ts:181-208`

`new Request(...)` is built without `signal`, so handlers cannot observe client disconnect abort.

### 4) Convenience lifecycle API has `once`/`off` mismatch

Current listener wiring:

- `once`: `create-native-msw-server.ts:375-383`
- `off`: `create-native-msw-server.ts:386-390`

`once` wraps listener, `off` removes original function, so lifecycle listener remains and still fires.

### 5) Lifecycle event detection is incomplete

Current check:

- `create-native-msw-server.ts:230-232`

`event.includes(":")` misses valid MSW lifecycle event `unhandledException`.

### 6) Adapter relies on MSW private fields

Current private coupling:

- handler kind checks via `__kind`: `create-native-msw-server.ts:33-39`, `250-254`
- internal emitter cast access: `create-native-msw-server.ts:262-274`

This is upgrade-risky if internals change.

## Upstream references to align with

MSW core and node behavior references:

- `handleRequest` implementation:
  - https://github.com/mswjs/msw/blob/main/src/core/utils/handleRequest.ts
- `handleRequest` tests:
  - https://github.com/mswjs/msw/blob/main/src/core/utils/handleRequest.test.ts
- Lifecycle events node tests:
  - https://github.com/mswjs/msw/blob/main/test/node/msw-api/setup-server/life-cycle-events/on.node.test.ts
- Fall-through semantics:
  - https://github.com/mswjs/msw/blob/main/test/node/msw-api/setup-server/scenarios/fall-through.node.test.ts
- Passthrough semantics:
  - https://github.com/mswjs/msw/blob/main/test/node/msw-api/req/passthrough.node.test.ts
- Unhandled request strategies:
  - https://github.com/mswjs/msw/blob/main/test/node/msw-api/setup-server/scenarios/on-unhandled-request/default.node.test.ts
  - https://github.com/mswjs/msw/blob/main/test/node/msw-api/setup-server/scenarios/on-unhandled-request/error.node.test.ts
  - https://github.com/mswjs/msw/blob/main/test/node/msw-api/setup-server/scenarios/on-unhandled-request/callback.node.test.ts
- Prior art for node middleware shape:
  - https://github.com/mswjs/http-middleware/blob/main/src/middleware.ts

Node transport references:

- HTTP server/header behavior:
  - https://nodejs.org/api/http.html
- Stream/backpressure/error behavior:
  - https://nodejs.org/api/stream.html
- Fetch/Request behavior in Node:
  - https://nodejs.org/api/globals.html#class-request

## Implementation plan (detailed)

### Phase A: Lock in failing tests first

Add a new file: `packages/msw-http-server/tests/parity-regressions.test.ts`

Purpose: prove current behavior gaps before code changes.

#### Failing test A1: preserves multiple `Set-Cookie` headers

Expected today: fails because only last cookie survives.

```ts
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { http } from "msw";
import { createNativeMswServer, type NativeMswServer } from "../src/index.ts";

const activeServers = new Set<NativeMswServer>();

async function listen(server: NativeMswServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  activeServers.add(server);
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const server of activeServers) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    activeServers.delete(server);
  }
});

test("preserves multiple set-cookie response headers", async () => {
  const server = createNativeMswServer(
    http.get("/cookies", () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("ok", { headers });
    }),
  );

  const port = await listen(server);

  const result = await new Promise<{ status: number; setCookie: string[] | undefined }>(
    (resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/cookies", method: "GET" },
        (res) => {
          resolve({
            status: res.statusCode ?? 0,
            setCookie: res.headers["set-cookie"],
          });
        },
      );
      req.on("error", reject);
      req.end();
    },
  );

  expect(result.status).toBe(200);
  expect(result.setCookie).toEqual(["a=1; Path=/", "b=2; Path=/"]);
});
```

#### Failing test A2: `server.off` removes listener previously added via `server.once`

Expected today: fails because wrapped listener is not removed.

```ts
test("server.off removes lifecycle once listener", async () => {
  const listener = vi.fn();
  const server = createNativeMswServer(http.get("/x", () => new Response("ok")));
  const { baseUrl } = await listen(server);

  server.once("request:match", listener);
  server.off("request:match", listener);

  const res = await fetch(`${baseUrl}/x`);
  expect(res.status).toBe(200);
  expect(listener).not.toHaveBeenCalled();
});
```

#### Failing test A3: convenience `server.on("unhandledException")` receives MSW event

Expected today: fails because `isLifecycleEventName` only matches names containing `:`.

```ts
test("forwards unhandledException lifecycle event via server.on", async () => {
  const server = createNativeMswServer(
    http.get("/boom", () => {
      throw new Error("resolver failed");
    }),
  );
  const { baseUrl } = await listen(server);

  const unhandledExceptionSpy = vi.fn();
  server.on("unhandledException", unhandledExceptionSpy);

  const response = await fetch(`${baseUrl}/boom`);
  expect(response.status).toBe(500);
  expect(unhandledExceptionSpy).toHaveBeenCalledTimes(1);
});
```

#### Failing test A4: aborting client request aborts handler `request.signal`

Expected today: fails because request signal is never wired to incoming socket abort.

```ts
test("propagates client abort to request.signal", async () => {
  let sawAbort = false;

  const server = createNativeMswServer(
    http.post("/slow", async ({ request }) => {
      await new Promise<void>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve();
          },
          { once: true },
        );

        setTimeout(resolve, 200);
      });

      return new Response("ok");
    }),
  );

  const port = await listen(server);

  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/slow",
        method: "POST",
        headers: { "content-type": "text/plain" },
      },
      () => {},
    );

    req.on("error", () => resolve());
    req.write("hello");
    req.end();

    setTimeout(() => {
      req.destroy(new Error("abort-client-request"));
      resolve();
    }, 10);
  });

  await new Promise((r) => setTimeout(r, 20));
  expect(sawAbort).toBe(true);
});
```

#### Failing test A5: stream failure after initial chunk does not crash server

Expected today: likely fails/flaky due headers-sent error path.

```ts
test("stream errors after first chunk do not break subsequent requests", async () => {
  let sentFirstChunk = false;

  const server = createNativeMswServer(
    http.get("/unstable", () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("first\\n"));
          sentFirstChunk = true;
          queueMicrotask(() => controller.error(new Error("stream exploded")));
        },
      });
      return new Response(stream, { status: 200 });
    }),
    http.get("/health", () => new Response("ok", { status: 200 })),
  );

  const { baseUrl } = await listen(server);

  await fetch(`${baseUrl}/unstable`).catch(() => undefined);
  expect(sentFirstChunk).toBe(true);

  const health = await fetch(`${baseUrl}/health`);
  expect(health.status).toBe(200);
  await expect(health.text()).resolves.toBe("ok");
});
```

### Phase B: Implement transport/lifecycle fixes

#### B1. Response header serialization

In `sendWebResponse` (`create-native-msw-server.ts`):

- preserve `set-cookie` as array using `mswRes.headers.getSetCookie()`;
- for other duplicate headers, append or accumulate rather than overwrite.

Acceptance:

- A1 passes.

#### B2. Robust streaming bridge

In `sendWebResponse`:

- guard for `res.destroyed` / `res.writableEnded`;
- handle `reader.read()` errors without rewriting headers if already sent;
- respect backpressure (`res.write()` false => await `drain`);
- cancel reader on `res.close`/`res.error`.

Acceptance:

- A5 passes reliably.

#### B3. Propagate client abort into `Request.signal`

In `incomingToWebRequest` and call site:

- create `AbortController` per incoming request;
- bind `req.on("aborted")` and `req.on("close")` to `controller.abort()`;
- pass `signal` into `new Request(...)`.

Acceptance:

- A4 passes.

#### B4. Lifecycle convenience API correctness

In server wrapper (`on`/`once`/`off`/`removeAllListeners`):

- replace `isLifecycleEventName` heuristic with explicit lifecycle event-name set from `LifeCycleEventsMap` keys;
- track wrapped once listeners in map so `off` can remove wrapper;
- ensure `removeAllListeners(event)` clears both node + lifecycle wrappers for that event.

Acceptance:

- A2 and A3 pass.

### Phase C: De-risk private MSW internals (incremental)

Current use of `__kind` and `msw.emitter` is fragile.

Short-term:

- isolate private access in tiny helper fns with comments + runtime invariant checks;
- add one test that fails loudly if expected private shape changes.

Longer-term:

- adopt architecture closer to `@mswjs/http-middleware` (own emitter + explicit `handleRequest` wiring), reducing dependence on private `setupServer` internals.

Acceptance:

- behavior unchanged;
- private-surface usage is centralized and documented.

## Optional parity follow-ups (not blocking this task)

- Add characterization test for `onUnhandledRequest: "error"` and callback-throw paths.
- Add requestId correlation assertions across `request:*` and `response:*` events.
- Decide/document passthrough semantics explicitly:
  - keep 404 contract as intentional adapter behavior, or
  - add configurable `onPassthrough(req, res)` hook for fallback/proxy.

## Validation checklist

Run:

```bash
pnpm --filter @iterate-com/msw-http-server test
pnpm --filter @iterate-com/msw-http-server typecheck
```

Expected end state:

- all new parity-regression tests pass;
- no existing tests regressed;
- behavior differences vs `setupServer` are explicitly documented in README or package doc.

## Definition of done

- [ ] Added `tests/parity-regressions.test.ts` with A1-A5 tests.
- [ ] Confirmed tests fail on current baseline.
- [ ] Implemented B1-B4.
- [ ] Confirmed A1-A5 now pass.
- [ ] Added brief docs note about intentional non-parity areas (if any remain).
