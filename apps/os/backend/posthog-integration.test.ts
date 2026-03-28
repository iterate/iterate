import http from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import * as YAML from "yaml";

expect.addSnapshotSerializer({
  test: () => true,
  print: (val) => {
    return YAML.stringify(normalizeSnapshotValue(val));
  },
});

function normalizeSnapshotValue(value: unknown, path: string[] = []): unknown {
  const key = path[path.length - 1];

  if (key === "api_key") return "<api-key>";
  if (key === "timestamp") return "<timestamp>";
  if (key === "lineno") return "<line-number>";
  if (key === "colno") return "<column-number>";
  if (key === "duration") return "<duration-ms>";
  if (key === "jobId") return "<job-id>";
  if (key === "id" && path.at(-2) === "request") return "<request-id>";

  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeSnapshotValue(entry, [...path, String(index)]));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        normalizeSnapshotValue(entryValue, [...path, entryKey]),
      ]),
    );
  }

  if (typeof value !== "string") return value;

  return value
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replaceAll(/(?<=\btrpc-)<uuid>/g, "<marker>")
    .replaceAll(/(?<=\bhono-)<uuid>/g, "<marker>")
    .replaceAll(/(?<=\boutbox-fail-)<uuid>/g, "<marker>")
    .replaceAll(/(?<=\boutbox-success-)<uuid>/g, "<marker>")
    .replaceAll(/(?<=\bmalformed-)<uuid>/g, "<marker>")
    .replaceAll(/(?<=\bmissing-consumer-)<uuid>/g, "<marker>")
    .replaceAll(/https?:\/\/[^/\s]+/g, "<origin>")
    .replaceAll("/Users/mmkal/src/iterate", "<repo>")
    .replaceAll(/\boutbox:[^:\s]+:\d+\b/g, "outbox:<consumer>:<job-id>")
    .replaceAll(/\bmissing-consumer-[^"' ]+\b/g, "missing-consumer-<marker>");
}

test("captures a trpc procedure error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `trpc-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/throwTrpcError",
    input: { message: `[test_trpc_error] ${marker}` },
  });

  expect(response.ok).toBe(false);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes(marker),
  });

  expect(captured.body.event).toBe("$exception");
  expect(captured.body.properties).toMatchObject({
    request: {
      path: "/api/orpc/testing/throwTrpcError",
      method: "POST",
    },
  });
  expect(captured.body).toMatchInlineSnapshot(`
    api_key: <api-key>
    event: $exception
    distinct_id: anonymous
    properties:
      $exception_list:
        - type: NonErrorThrowable
          value: "oRPC Error unknown <origin>/api/orpc/testing/throwTrpcError:
            [test_trpc_error] trpc-<marker>"
          mechanism:
            handled: true
            synthetic: false
          stacktrace:
            type: raw
            frames:
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/logging/logger.ts
                function: toParsedError
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/logging/logger.ts
                function: Object.error
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/worker.ts
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-PFM44RO3.js
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/@orpc_server_fetch.js
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/@orpc_server_fetch.js
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/worker.ts
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/hono.js
                function: dispatch
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/hono.js
                function: dispatch
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/hono.js
                function: dispatch
                lineno: <line-number>
                colno: <column-number>
                in_app: false
      $environment: dev-misha
      $lib: os-logging
      request:
        id: <request-id>
        method: POST
        path: /api/orpc/testing/throwTrpcError
        status: 500
        duration: <duration-ms>
        waitUntil: false
        url: <origin>/api/orpc/testing/throwTrpcError
      user:
        id: anonymous
        email: unknown
    timestamp: <timestamp>
  `);
});

test("captures a hono endpoint error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `hono-${crypto.randomUUID()}`;
  const response = await integration.callEndpoint({
    path: `/api/testing/throw-hono-error?marker=${marker}`,
  });

  expect(response.ok).toBe(false);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes(marker),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "/api/testing/throw-hono-error",
      method: "GET",
    },
  });
  expect(captured.body).toMatchInlineSnapshot(`
    api_key: <api-key>
    event: $exception
    distinct_id: anonymous
    properties:
      $exception_list:
        - type: Error
          value: "[test_hono_error] hono-<marker>"
          mechanism:
            handled: true
            synthetic: false
          stacktrace:
            type: raw
            frames:
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/worker.ts
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/hono.js
                function: dispatch
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/hono.js
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-EFPPX6X2.js
                function: NoopContextManager2.with
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-EFPPX6X2.js
                function: ContextAPI2.with
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/utils/otel-init.ts
                function: withExtractedTraceContext
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/worker.ts
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/hono.js
                function: dispatch
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/hono.js
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/worker.ts
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: true
      $environment: dev-misha
      $lib: os-logging
      request:
        id: <request-id>
        method: GET
        path: /api/testing/throw-hono-error
        status: 500
        duration: <duration-ms>
        waitUntil: false
        url: <origin>/api/testing/throw-hono-error?marker=hono-<marker>
      user:
        id: anonymous
        email: unknown
    timestamp: <timestamp>
  `);
});

test("captures a waitUntil error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `wait-until-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/throwWaitUntilError",
    input: { message: `[test_wait_until_error] ${marker}` },
  });

  expect(response.ok).toBe(true);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) =>
      body.properties &&
      typeof body.properties === "object" &&
      "request" in body.properties &&
      typeof body.properties.request === "object" &&
      body.properties.request !== null &&
      "waitUntil" in body.properties.request &&
      body.properties.request.waitUntil === true &&
      JSON.stringify(body).includes(marker),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "/api/orpc/testing/throwWaitUntilError#waitUntil",
      method: "POST",
      waitUntil: true,
      parentRequestId: expect.any(String),
    },
  });
  expect(captured.body).toMatchInlineSnapshot(`
    api_key: <api-key>
    event: $exception
    distinct_id: anonymous
    properties:
      $exception_list:
        - type: Error
          value: "[test_wait_until_error] wait-until-<uuid>"
          mechanism:
            handled: true
            synthetic: false
          stacktrace:
            type: raw
            frames:
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: true
      $environment: dev-misha
      $lib: os-logging
      request:
        id: <request-id>
        method: POST
        path: /api/orpc/testing/throwWaitUntilError#waitUntil
        status: 500
        duration: <duration-ms>
        waitUntil: true
        parentRequestId: <uuid>
        url: <origin>/api/orpc/testing/throwWaitUntilError
      user:
        id: anonymous
        email: unknown
    timestamp: <timestamp>
  `);
});

test("does not capture PostHog for successful outbox consumer flow", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `outbox-success-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/emitSuccessfulOutboxEvent",
    input: { message: marker },
  });

  expect(response.ok).toBe(true);
  await expect
    .poll(
      () =>
        integration.capture.requests.some((request) =>
          JSON.stringify(request.body).includes(marker),
        ),
      { timeout: 1_000 },
    )
    .toBe(false);
  expect(integration.capture.requests).toMatchInlineSnapshot(`[]`);
});

test("captures an outbox consumer error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `outbox-fail-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/emitFailingOutboxEvent",
    input: { message: marker },
  });

  expect(response.ok).toBe(true);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes(marker),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "/api/orpc/testing/emitFailingOutboxEvent",
      method: "POST",
    },
  });
  expect(captured.body).toMatchInlineSnapshot(`
    api_key: <api-key>
    event: $exception
    distinct_id: system:outbox
    properties:
      $exception_list:
        - type: Error
          value: "[test_outbox_consumer_error] outbox-fail-<marker>"
          mechanism:
            handled: true
            synthetic: false
          stacktrace:
            type: raw
            frames:
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/consumers.ts
                function: Object.handler
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: Object.handler
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: runHandler
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/outbox-logging.ts
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/logging/logger.ts
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/logging/logger.ts
                function: Object.run
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/outbox-logging.ts
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: processQueue
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: Object.handler
                lineno: <line-number>
                colno: <column-number>
                in_app: true
      $environment: dev-misha
      $lib: os-logging
      request:
        id: <request-id>
        method: POST
        path: /api/orpc/testing/emitFailingOutboxEvent
        status: -1
        duration: <duration-ms>
        waitUntil: false
        url: <origin>/api/orpc/testing/emitFailingOutboxEvent
      user:
        id: system:outbox
        email: outbox@system
    timestamp: <timestamp>
  `);
});

test("captures a malformed outbox job error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `malformed-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/insertMalformedOutboxJob",
    input: { marker },
  });

  expect(response.ok).toBe(true);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes("invalid message"),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "outbox/invalid-consumer-job",
      method: "OUTBOX",
    },
  });
  expect(captured.body).toMatchInlineSnapshot(`
    api_key: <api-key>
    event: $exception
    distinct_id: system:outbox
    properties:
      $exception_list:
        - type: OutboxDLQ:invalid-consumer-job
          value: >-
            Error: [outbox] invalid message: ✖ Invalid input: expected string,
            received undefined
              → at message.event_name
            ✖ Invalid input: expected string, received undefined
              → at message.consumer_name
            ✖ Invalid input: expected number, received undefined
              → at message.event_id
            ✖ Invalid input: expected object, received undefined
              → at message.event_payload
            ✖ Invalid input: expected array, received undefined
              → at message.processing_results
            ✖ Invalid input: expected string, received undefined
              → at message.environment
          mechanism:
            handled: true
            synthetic: false
          stacktrace:
            type: raw
            frames:
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/outbox-logging.ts
                function: sendDLQToPostHog
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: emit
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: processQueue
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: Object.handler
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-ONVKXQNY.js
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-ONVKXQNY.js
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-ONVKXQNY.js
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-ONVKXQNY.js
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-ONVKXQNY.js
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/@orpc_server_fetch.js
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
      $environment: dev-misha
      $lib: outbox-dlq
      request:
        id: <request-id>
        method: OUTBOX
        path: outbox/invalid-consumer-job
        status: 500
        duration: <duration-ms>
        waitUntil: false
      user:
        id: system:outbox
        email: outbox@system
      outbox:
        consumerName: invalid-consumer-job
        jobId: <job-id>
        attempt: 1
        eventName: invalid-message
        eventId: -1
        causation: null
        processingResults: []
        status: failed
    timestamp: <timestamp>
  `);
});

test("captures a missing consumer error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `missing-consumer-${crypto.randomUUID()}`;
  const response = await integration.callProcedure({
    name: "testing/insertMissingConsumerOutboxJob",
    input: { marker },
  });

  expect(response.ok).toBe(true);

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes("no consumer found"),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: expect.stringContaining("outbox/missing-consumer-"),
      method: "OUTBOX",
    },
  });
  expect(captured.body).toMatchInlineSnapshot(`
    api_key: <api-key>
    event: $exception
    distinct_id: system:outbox
    properties:
      $exception_list:
        - type: OutboxDLQ:missing-consumer-<marker>>
          value: "Error: [outbox] no consumer found for
            event=testing:missing-consumer:missing-consumer-<marker>>
            consumer=missing-consumer-<marker>>"
          mechanism:
            handled: true
            synthetic: false
          stacktrace:
            type: raw
            frames:
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/outbox-logging.ts
                function: sendDLQToPostHog
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: emit
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: archiveFailedJob
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: processQueue
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: Object.handler
                lineno: <line-number>
                colno: <column-number>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-ONVKXQNY.js
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-ONVKXQNY.js
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-ONVKXQNY.js
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-ONVKXQNY.js
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/node_modules/.vite/deps_ssr/chunk-ONVKXQNY.js
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
      $environment: dev-misha
      $lib: outbox-dlq
      request:
        id: <request-id>
        method: OUTBOX
        path: outbox/missing-consumer-<marker>>
        status: 500
        duration: <duration-ms>
        waitUntil: false
      user:
        id: system:outbox
        email: outbox@system
      outbox:
        consumerName: missing-consumer-<marker>>
        jobId: <job-id>
        attempt: 1
        eventName: testing:missing-consumer:missing-consumer-<marker>>
        eventId: 999999
        causation: null
        processingResults:
          - "#1 error: Error: [outbox] no consumer found for
            event=testing:missing-consumer:missing-consumer-<marker>>
            consumer=missing-consumer-<marker>>. retry: false. reason: Error marked
            non-retryable."
        status: failed
    timestamp: <timestamp>
  `);
});

type CapturedPostHogRequest = {
  path: string;
  body: Record<string, unknown>;
};

type PostHogIntegrationContext = {
  capture: {
    requests: CapturedPostHogRequest[];
    waitForRequest(params: {
      timeoutMs?: number;
      predicate?: (body: Record<string, unknown>) => boolean;
    }): Promise<CapturedPostHogRequest>;
  };
  callProcedure(params: { name: string; input?: unknown }): Promise<Response>;
  callEndpoint(params: { path: string }): Promise<Response>;
  [Symbol.asyncDispose](): Promise<void>;
};

async function createPostHogIntegration(): Promise<PostHogIntegrationContext> {
  const requests: CapturedPostHogRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    requests.push({
      path: req.url ?? "/",
      body: JSON.parse(rawBody) as Record<string, unknown>,
    });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind capture server");
  }
  const captureOrigin = `http://127.0.0.1:${address.port}`;

  await fetchWithManualRedirect("/api/orpc/testing/purgeOutboxQueue", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-replace-posthog-egress": captureOrigin,
    },
    body: JSON.stringify({ json: {} }),
  });

  return {
    capture: {
      requests,
      async waitForRequest(params: {
        timeoutMs?: number;
        predicate?: (body: Record<string, unknown>) => boolean;
      }) {
        const timeoutMs = params.timeoutMs ?? 5_000;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
          const match = requests.find((request) =>
            params.predicate ? params.predicate(request.body) : true,
          );
          if (match) return match;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        throw new Error(
          `Timed out waiting for captured PostHog request. Saw ${requests.length} requests.`,
        );
      },
    },
    async callProcedure(params: { name: string; input?: unknown }): Promise<Response> {
      return await fetchWithManualRedirect(`/api/orpc/${params.name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-replace-posthog-egress": captureOrigin,
        },
        body: JSON.stringify({ json: params.input ?? {} }),
      });
    },
    async callEndpoint(params: { path: string }): Promise<Response> {
      return await fetchWithManualRedirect(params.path, {
        headers: {
          "x-replace-posthog-egress": captureOrigin,
        },
      });
    },
    async [Symbol.asyncDispose](): Promise<void> {
      server.close();
      await once(server, "close");
    },
  };
}

const integrationBaseUrl = process.env.APP_URL || "http://local.iterate.com:5173";

async function fetchWithManualRedirect(input: string | URL, init: RequestInit): Promise<Response> {
  let url = new URL(input, integrationBaseUrl);
  let redirectsRemaining = 5;

  while (true) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: "manual",
      });
    } catch (error) {
      const details =
        error instanceof Error && error.message ? ` Original error: ${error.message}` : "";
      throw new Error(
        `Failed to reach the dev server at ${url.toString()}. Make sure \`pnpm dev\` is running.${details}`,
      );
    }

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const redirectLocation = response.headers.get("location");
    if (!redirectLocation || redirectsRemaining <= 0) {
      return response;
    }

    url = new URL(redirectLocation, url);
    redirectsRemaining -= 1;
  }
}
