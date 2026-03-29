import http from "node:http";
import { once } from "node:events";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { expect, test } from "vitest";
import * as YAML from "yaml";
import type { AppRouter } from "./orpc/root.ts";

test("captures a trpc procedure error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `trpc-${crypto.randomUUID()}`;
  await expect(
    integration.client.testing.throwTrpcError({ message: `[test_trpc_error] ${marker}` }),
  ).rejects.toBeTruthy();

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
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
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
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
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
                filename: <repo>/.../node_modules/.vite/...
                function: dispatch
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: dispatch
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: dispatch
                lineno: <line-number>
                colno: <column-number>
                in_app: false
      $environment: <environment>
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
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
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
                filename: <repo>/.../node_modules/.vite/...
                function: dispatch
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: NoopContextManager2.with
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
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
                filename: <repo>/.../node_modules/.vite/...
                function: dispatch
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
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
      $environment: <environment>
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
  await integration.client.testing.throwWaitUntilError({
    message: `[test_wait_until_error] ${marker}`,
  });

  const captured = await integration.capture.waitForRequest({
    predicate: (body) =>
      body.properties?.request?.waitUntil === true && JSON.stringify(body).includes(marker),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "/api/orpc/testing/throwWaitUntilError#waitUntil",
      method: "POST",
      waitUntil: true,
      parentRequestId: expect.any(String),
    },
  });
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
    api_key: <api-key>
    event: $exception
    distinct_id: anonymous
    properties:
      $exception_list:
        - type: Error
          value: "[test_wait_until_error] wait-until-<marker>"
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
      $environment: <environment>
      $lib: os-logging
      request:
        id: <request-id>
        method: POST
        path: /api/orpc/testing/throwWaitUntilError#waitUntil
        status: 500
        duration: <duration-ms>
        waitUntil: true
        parentRequestId: <request-id>
        url: <origin>/api/orpc/testing/throwWaitUntilError
      user:
        id: anonymous
        email: unknown
    timestamp: <timestamp>
  `);
});

test("captures the raw request log for a trpc procedure error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `trpc-${crypto.randomUUID()}`;
  await expect(
    integration.client.testing.throwTrpcError({ message: `[test_trpc_error_log] ${marker}` }),
  ).rejects.toBeTruthy();

  const captured = await integration.logs.waitForLog({
    predicate: (log: any) => log.request?.id === integration.lastRequestId(),
  });

  expect(captured).toMatchObject({
    request: {
      id: integration.lastRequestId(),
      path: "/api/orpc/testing/throwTrpcError",
      method: "POST",
      status: 500,
    },
  });
  expect(normalize(captured, { marker })).toMatchInlineSnapshot(`
    meta:
      id: <log-id>
      start: <timestamp>
      end: <timestamp>
      durationMs: <duration-ms>
    service: os
    environment: <environment>
    request:
      path: /api/orpc/testing/throwTrpcError
      status: 500
      method: POST
      id: <request-id>
      url: <origin>/api/orpc/testing/throwTrpcError
      hostname: local.iterate.com
      traceparent: null
      cfRay: <cf-ray>
      timezone: Asia/Singapore
    user:
      id: anonymous
      email: unknown
    egress:
      https://eu.i.posthog.com: <origin>
    name: Error
    message: "[test_trpc_error_log] trpc-<marker>"
    stack: >-
      Error: [test_trpc_error_log] trpc-<marker>
          at Object.handler (<repo>/apps/os/backend/orpc/routers/testing.ts:<line-number>:<column-number>)
          at <repo>/.../node_modules/.vite/...:<line-number>:<column-number>
          at runWithSpan (<repo>/.../node_modules/.vite/...:<line-number>:<column-number>)
          at next (<repo>/.../node_modules/.vite/...:<line-number>:<column-number>)
          at next (<repo>/.../node_modules/.vite/...:<line-number>:<column-number>)
          at <repo>/.../node_modules/.vite/...:<line-number>:<column-number>
          at next (<repo>/.../node_modules/.vite/...:<line-number>:<column-number>)
          at <repo>/.../node_modules/.vite/...:<line-number>:<column-number>
          at <repo>/.../node_modules/.vite/...:<line-number>:<column-number>
          at <repo>/.../node_modules/.vite/...:<line-number>:<column-number>
    errors:
      - name: NonErrorThrowable
        message: "oRPC Error unknown <origin>/api/orpc/testing/throwTrpcError:
          [test_trpc_error_log] trpc-<marker>"
        stack: >-
          Error: oRPC Error unknown <origin>/api/orpc/testing/throwTrpcError:
          [test_trpc_error_log] trpc-<marker>
              at toParsedError (<repo>/apps/os/backend/logging/logger.ts:<line-number>:<column-number>)
              at Object.error (<repo>/apps/os/backend/logging/logger.ts:<line-number>:<column-number>)
              at <repo>/apps/os/backend/worker.ts:<line-number>:<column-number>
              at <repo>/.../node_modules/.vite/...:<line-number>:<column-number>
              at <repo>/.../node_modules/.vite/...:<line-number>:<column-number>
              at <repo>/.../node_modules/.vite/...:<line-number>:<column-number>
              at <repo>/apps/os/backend/worker.ts:<line-number>:<column-number>
              at dispatch (<repo>/.../node_modules/.vite/...:<line-number>:<column-number>)
              at dispatch (<repo>/.../node_modules/.vite/...:<line-number>:<column-number>)
              at dispatch (<repo>/.../node_modules/.vite/...:<line-number>:<column-number>)
    messages:
      - "[ERROR] 0s: oRPC Error unknown <origin>/api/orpc/testing/throwTrpcError:
        [test_trpc_error_log] trpc-<marker>"
  `);
});

test("captures the raw waitUntil child log", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `wait-until-${crypto.randomUUID()}`;
  await integration.client.testing.throwWaitUntilError({
    message: `[test_wait_until_log] ${marker}`,
  });

  const captured = await integration.logs.waitForLog({
    predicate: (log: any) =>
      log.request?.waitUntil === true &&
      log.request.parentRequestId === integration.lastRequestId(),
  });

  expect(captured).toMatchObject({
    request: {
      path: "/api/orpc/testing/throwWaitUntilError#waitUntil",
      method: "POST",
      waitUntil: true,
      parentRequestId: integration.lastRequestId(),
    },
  });
  expect(normalize(captured, { marker })).toMatchInlineSnapshot(`
    meta:
      id: <log-id>
      start: <timestamp>
      end: <timestamp>
      durationMs: <duration-ms>
    parent:
      meta:
        id: <log-id>
        start: <timestamp>
      service: os
      environment: <environment>
      request:
        path: /api/orpc/testing/throwWaitUntilError
        status: -1
        method: POST
        id: <request-id>
        url: <origin>/api/orpc/testing/throwWaitUntilError
        hostname: local.iterate.com
        traceparent: null
        cfRay: <cf-ray>
        timezone: Asia/Singapore
      user:
        id: anonymous
        email: unknown
      egress:
        https://eu.i.posthog.com: <origin>
    service: os
    environment: <environment>
    request:
      id: <request-id>
      method: POST
      path: /api/orpc/testing/throwWaitUntilError#waitUntil
      status: 500
      waitUntil: true
      parentRequestId: <request-id>
    egress:
      https://eu.i.posthog.com: <origin>
    user:
      id: anonymous
      email: unknown
    errors:
      - name: Error
        message: "[test_wait_until_log] wait-until-<marker>"
        stack: |-
          Error: [test_wait_until_log] wait-until-<marker>
              at <repo>/apps/os/backend/orpc/routers/testing.ts:<line-number>:<column-number>
      - name: Error
        message: "[test_wait_until_log] wait-until-<marker>"
        stack: |-
          Error: [test_wait_until_log] wait-until-<marker>
              at <repo>/apps/os/backend/orpc/routers/testing.ts:<line-number>:<column-number>
    messages:
      - "[ERROR] 0s: Error: [test_wait_until_log] wait-until-<marker>"
      - "[INFO] 0s: PostHog log exception dispatch requestId=<uuid>:waitUntil:<uuid>
        path=/api/orpc/testing/throwWaitUntilError#waitUntil errorCount=1"
      - "[INFO] 0s: PostHog log exception sent requestId=<uuid>:waitUntil:<uuid>"
      - "[ERROR] 0s: [test_wait_until_log] wait-until-<marker>"
  `);
});

test("does not capture PostHog for successful outbox consumer flow", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `outbox-success-${crypto.randomUUID()}`;
  await integration.client.testing.emitSuccessfulOutboxEvent({ message: marker });
  await expect
    .poll(
      () =>
        integration.capture.requests.some((request) =>
          JSON.stringify(request.body).includes(marker),
        ),
      { timeout: 1_000 },
    )
    .toBe(false);
  expect(normalize(integration.capture.requests)).toMatchInlineSnapshot(`
    []
  `);
});

test("captures an outbox consumer error", async () => {
  await using integration = await createPostHogIntegration();
  const marker = `outbox-fail-${crypto.randomUUID()}`;
  await integration.client.testing.emitFailingOutboxEvent({ message: marker });

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes(marker),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "/api/orpc/testing/emitFailingOutboxEvent",
      method: "POST",
    },
  });
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
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
      $environment: <environment>
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
  await integration.client.testing.insertMalformedOutboxJob({ marker });

  const captured = await integration.capture.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes("invalid message"),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "outbox/invalid-consumer-job",
      method: "OUTBOX",
    },
  });
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
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
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
      $environment: <environment>
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
  await integration.client.testing.insertMissingConsumerOutboxJob({ marker });

  const captured = await integration.capture.waitForRequest({
    predicate: (body) =>
      body.properties?.request?.method === "OUTBOX" &&
      JSON.stringify(body).includes("no consumer found"),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: expect.stringContaining("outbox/missing-consumer-"),
      method: "OUTBOX",
    },
  });
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
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
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <line-number>
                colno: <column-number>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <line-number>
                colno: <column-number>
                in_app: false
      $environment: <environment>
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
  client: RouterClient<AppRouter>;
  lastRequestId(): string;
  capture: {
    requests: CapturedPostHogRequest[];
    waitForRequest(params: {
      timeoutMs?: number;
      predicate?: (body: any) => boolean;
    }): Promise<CapturedPostHogRequest>;
  };
  logs: {
    waitForLog(params: { timeoutMs?: number; predicate?: (body: any) => boolean }): Promise<any>;
  };
  callEndpoint(params: { path: string }): Promise<Response>;
  [Symbol.asyncDispose](): Promise<void>;
};

async function createPostHogIntegration(): Promise<PostHogIntegrationContext> {
  const requests: CapturedPostHogRequest[] = [];
  let lastRequestId: string | null = null;
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
  await fetchWithManualRedirect("/api/orpc/testing/clearBufferedLogs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: {} }),
  });

  return {
    client: createORPCClient(
      new RPCLink({
        url: new URL("/api/orpc", integrationBaseUrl).toString(),
        headers: {
          "x-replace-posthog-egress": captureOrigin,
        },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          lastRequestId = response.headers.get("x-iterate-request-id");
          return response;
        },
      }),
    ) as RouterClient<AppRouter>,
    lastRequestId() {
      if (!lastRequestId) {
        throw new Error("No x-iterate-request-id has been captured yet.");
      }
      return lastRequestId;
    },
    capture: {
      requests,
      async waitForRequest(params: { timeoutMs?: number; predicate?: (body: any) => boolean }) {
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
    logs: {
      async waitForLog(params: { timeoutMs?: number; predicate?: (body: any) => boolean }) {
        const timeoutMs = params.timeoutMs ?? 5_000;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
          const response = await fetchWithManualRedirect("/api/orpc/testing/getBufferedLogs", {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ json: {} }),
          });
          const body = (await response.json()) as { json: { logs: Record<string, unknown>[] } };
          const logs = body.json.logs;
          const match = logs.find((log) => (params.predicate ? params.predicate(log) : true));
          if (match) return match;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        throw new Error(`Timed out waiting for buffered log event.`);
      },
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

function normalize(value: unknown, params: { marker?: string } = {}): string {
  const yaml = YAML.stringify(normalizeSnapshotValue(value));
  const withMarker = params.marker ? yaml.replaceAll(params.marker, "<marker>") : yaml;

  return withMarker
    .replaceAll(process.cwd(), "<repo>")
    .replaceAll(/https?:\/\/[^/\s]+/g, "<origin>")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<timestamp>")
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replaceAll(/\boutbox:[^:\s]+:\d+\b/g, "outbox:<consumer>:<job-id>")
    .replaceAll(/\bmissing-consumer-[^"' ):\n]+\b/g, "missing-consumer-<marker>")
    .replace(/<repo>\/[^ :)\n"]+(?::\d+:\d+)?/g, (match) => normalizeRepoPath(match));
}

function normalizeRepoPath(value: string): string {
  const [, path, line, column] = value.match(/^(<repo>\/[^ :)\n"]+?)(?::(\d+):(\d+))?$/) ?? [];
  if (!path) return value;

  const nodeModulesIndex = path.indexOf("/node_modules/");
  const normalizedPath =
    nodeModulesIndex >= 0
      ? `<repo>/.../node_modules/${path.slice(nodeModulesIndex + "/node_modules/".length).split("/")[0] ?? "unknown"}/...`
      : path;

  if (!line || !column) return normalizedPath;
  return `${normalizedPath}:<line-number>:<column-number>`;
}

function normalizeSnapshotValue(value: unknown, path: string[] = []): unknown {
  const key = path[path.length - 1];

  if (key === "api_key") return "<api-key>";
  if (key === "timestamp") return "<timestamp>";
  if (key === "start") return "<timestamp>";
  if (key === "end") return "<timestamp>";
  if (key === "lineno") return "<line-number>";
  if (key === "colno") return "<column-number>";
  if (key === "duration") return "<duration-ms>";
  if (key === "durationMs") return "<duration-ms>";
  if (key === "jobId") return "<job-id>";
  if (key === "id" && path.at(-2) === "request") return "<request-id>";
  if (key === "id" && path.at(-2) === "meta") return "<log-id>";
  if (key === "parentRequestId") return "<request-id>";
  if (key === "cfRay") return "<cf-ray>";
  if (key === "$environment" || key === "environment") return "<environment>";

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

  return value.replaceAll(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<uuid>",
  );
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
