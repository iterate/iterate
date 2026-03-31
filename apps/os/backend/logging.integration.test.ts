import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { expect, test } from "vitest";
import * as YAML from "yaml";
import type { AppRouter } from "./orpc/root.ts";

test("captures an orpc procedure error", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `orpc-${crypto.randomUUID()}`;
  await expect(
    fixture.client.testing.emitRequestFailure({
      mechanism: "throw",
      throwable: "error",
      marker,
    }),
  ).rejects.toBeTruthy();

  const captured = await fixture.posthog.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes(marker),
  });

  expect(captured.body.event).toBe("$exception");
  expect(captured.body.properties).toMatchObject({
    request: {
      path: "/api/orpc/testing/emitRequestFailure",
      method: "POST",
    },
  });
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
    "api_key: <api_key>
    event: $exception
    distinct_id: anonymous
    properties:
      $exception_list:
        - type: Error
          value: "[test_error] <marker>"
          mechanism:
            handled: true
            synthetic: false
          stacktrace:
            type: raw
            frames:
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: createTestingThrowable
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: runTestingFailureScenario
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: Object.handler
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: runWithSpan
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: false
      $environment: <$environment>
      $lib: os-logging
      request:
        id: <id>
        method: POST
        path: /api/orpc/testing/emitRequestFailure
        status: 500
        duration: <duration>
        waitUntil: false
        url: <origin>/api/orpc/testing/emitRequestFailure
      user:
        id: <id>
        email: unknown
    timestamp: <timestamp>"
  `);
});

test("captures a hono endpoint error", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `hono-${crypto.randomUUID()}`;
  const response = await fixture.callEndpoint({
    path: `/api/testing/throw-hono-error?marker=${marker}`,
  });

  expect(response.ok).toBe(false);

  const captured = await fixture.posthog.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes(marker),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "/api/testing/throw-hono-error",
      method: "GET",
    },
  });
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
    "api_key: <api_key>
    event: $exception
    distinct_id: anonymous
    properties:
      $exception_list:
        - type: Error
          value: "[test_hono_error] <marker>"
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
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: dispatch
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: NoopContextManager2.with
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: ContextAPI2.with
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/utils/otel-init.ts
                function: withExtractedTraceContext
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/worker.ts
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: dispatch
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/worker.ts
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: true
      $environment: <$environment>
      $lib: os-logging
      request:
        id: <id>
        method: GET
        path: /api/testing/throw-hono-error
        status: 500
        duration: <duration>
        waitUntil: false
        url: <origin>/api/testing/throw-hono-error?marker=<marker>
      user:
        id: <id>
        email: unknown
    timestamp: <timestamp>"
  `);
});

test("captures a waitUntil error", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `wait-until-${crypto.randomUUID()}`;
  await fixture.client.testing.emitWaitUntilFailure({
    mechanism: "throw",
    throwable: "error",
    marker,
  });

  const captured = await fixture.posthog.waitForRequest({
    predicate: (body) =>
      body.properties?.request?.waitUntil === true && JSON.stringify(body).includes(marker),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "/api/orpc/testing/emitWaitUntilFailure#waitUntil",
      method: "POST",
      waitUntil: true,
      parentRequestId: expect.any(String),
    },
  });
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
    "api_key: <api_key>
    event: $exception
    distinct_id: anonymous
    properties:
      $exception_list:
        - type: Error
          value: "[test_error] <marker>"
          mechanism:
            handled: true
            synthetic: false
          stacktrace:
            type: raw
            frames:
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: createTestingThrowable
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: runTestingFailureScenario
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: true
      $environment: <$environment>
      $lib: os-logging
      request:
        id: <id>
        method: POST
        path: /api/orpc/testing/emitWaitUntilFailure#waitUntil
        status: 500
        duration: <duration>
        waitUntil: true
        parentRequestId: <parent-request-id>
        url: <origin>/api/orpc/testing/emitWaitUntilFailure
      user:
        id: <id>
        email: unknown
    timestamp: <timestamp>"
  `);
});

test("captures the raw request log for an orpc procedure error", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `orpc-${crypto.randomUUID()}`;
  await expect(
    fixture.client.testing.emitRequestFailure({
      mechanism: "throw",
      throwable: "error",
      marker,
    }),
  ).rejects.toBeTruthy();

  const captured = await fixture.logs.waitForLog({
    predicate: (log: any) => log.request?.id === fixture.lastRequestId(),
  });

  expect(captured).toMatchObject({
    request: {
      id: fixture.lastRequestId(),
      path: "/api/orpc/testing/emitRequestFailure",
      method: "POST",
      status: 500,
    },
  });
  expect(normalize(captured, { marker })).toMatchInlineSnapshot(`
    "meta:
      id: <id>
      start: <start>
      end: <end>
      durationMs: <duration-ms>
    service: os
    environment: dev-misha
    request:
      path: /api/orpc/testing/emitRequestFailure
      status: 500
      method: POST
      id: <id>
      url: <origin>/api/orpc/testing/emitRequestFailure
      hostname: local.iterate.com
      traceparent: null
      cfRay: <cf-ray>
      timezone: <timezone>
    user:
      id: <id>
      email: unknown
    egress:
      <origin> <origin>
    errors:
      - name: Error
        message: "[test_error] <marker>"
        stack: >-
          Error: [test_error] <marker>
              at createTestingThrowable (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at runTestingFailureScenario (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at Object.handler (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at <repo>/.../node_modules/.vite/...
              at runWithSpan (<repo>/.../node_modules/.vite/...)
              at next (<repo>/.../node_modules/.vite/...)
              at next (<repo>/.../node_modules/.vite/...)
              at <repo>/.../node_modules/.vite/...
              at next (<repo>/.../node_modules/.vite/...)
              at <repo>/.../node_modules/.vite/...
    messages:
      - "[ERROR] <elapsed>s: Error: [test_error] <marker>""
  `);
});

test("captures detail for an inline logger.warn", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `warn-detail-${crypto.randomUUID()}`;
  await fixture.client.testing.emitRequestFailure({
    mechanism: "logger-warn",
    throwable: "error-with-detail",
    marker,
  });

  const captured = await fixture.logs.waitForLog({
    predicate: (log: any) => log.request?.id === fixture.lastRequestId(),
  });

  expect(captured).toMatchObject({
    request: {
      id: fixture.lastRequestId(),
      path: "/api/orpc/testing/emitRequestFailure",
      method: "POST",
      status: 200,
    },
  });
  expect(normalize(captured, { marker })).toMatchInlineSnapshot(`
    "meta:
      id: <id>
      start: <start>
      end: <end>
      durationMs: <duration-ms>
    service: os
    environment: dev-misha
    request:
      path: /api/orpc/testing/emitRequestFailure
      status: 200
      method: POST
      id: <id>
      url: <origin>/api/orpc/testing/emitRequestFailure
      hostname: local.iterate.com
      traceparent: null
      cfRay: <cf-ray>
      timezone: <timezone>
    user:
      id: <id>
      email: unknown
    egress:
      <origin> <origin>
    errors:
      - name: Error
        message: "[test_error_with_detail] <marker>"
        stack: >-
          Error: [test_error_with_detail] <marker>
              at createTestingThrowable (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at runTestingFailureScenario (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at Object.handler (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at <repo>/.../node_modules/.vite/...
              at runWithSpan (<repo>/.../node_modules/.vite/...)
              at next (<repo>/.../node_modules/.vite/...)
              at next (<repo>/.../node_modules/.vite/...)
              at <repo>/.../node_modules/.vite/...
              at next (<repo>/.../node_modules/.vite/...)
              at <repo>/.../node_modules/.vite/...
        detail:
          bar: 123
          marker: <marker>
    messages:
      - "[WARN] <elapsed>s: [test_error_with_detail] <marker>""
  `);
});

test("captures the raw waitUntil child log", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `wait-until-${crypto.randomUUID()}`;
  await fixture.client.testing.emitWaitUntilFailure({
    mechanism: "throw",
    throwable: "error",
    marker,
  });

  const captured = await fixture.logs.waitForLog({
    predicate: (log: any) =>
      log.request?.waitUntil === true && log.request.parentRequestId === fixture.lastRequestId(),
  });

  expect(captured).toMatchObject({
    request: {
      path: "/api/orpc/testing/emitWaitUntilFailure#waitUntil",
      method: "POST",
      waitUntil: true,
      parentRequestId: fixture.lastRequestId(),
    },
  });
  expect(normalize(captured, { marker })).toMatchInlineSnapshot(`
    "meta:
      id: <id>
      start: <start>
      end: <end>
      durationMs: <duration-ms>
    parent:
      meta:
        id: <id>
        start: <start>
      service: os
      environment: dev-misha
      request:
        path: /api/orpc/testing/emitWaitUntilFailure
        status: -1
        method: POST
        id: <id>
        url: <origin>/api/orpc/testing/emitWaitUntilFailure
        hostname: local.iterate.com
        traceparent: null
        cfRay: <cf-ray>
        timezone: <timezone>
      user:
        id: <id>
        email: unknown
      egress:
        <origin> <origin>
    service: os
    environment: dev-misha
    request:
      id: <id>
      method: POST
      path: /api/orpc/testing/emitWaitUntilFailure#waitUntil
      status: 500
      waitUntil: true
      parentRequestId: <parent-request-id>
    egress:
      <origin> <origin>
    user:
      id: <id>
      email: unknown
    errors:
      - name: Error
        message: "[test_error] <marker>"
        stack: >-
          Error: [test_error] <marker>
              at createTestingThrowable (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at runTestingFailureScenario (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at <repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>
      - name: Error
        message: "[test_error] <marker>"
        stack: >-
          Error: [test_error] <marker>
              at createTestingThrowable (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at runTestingFailureScenario (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at <repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>
    messages:
      - "[ERROR] <elapsed>s: Error: [test_error] <marker>"
      - "[INFO] <elapsed>s: PostHog log exception dispatch requestId=<uuid>:waitUntil:<uuid>
        path=/api/orpc/testing/emitWaitUntilFailure#waitUntil errorCount=1"
      - "[INFO] <elapsed>s: PostHog log exception sent requestId=<uuid>:waitUntil:<uuid>"
      - "[ERROR] <elapsed>s: [test_error] <marker>""
  `);
});

test("captures custom error properties in a waitUntil log", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `wait-until-custom-${crypto.randomUUID()}`;
  await fixture.client.testing.emitWaitUntilFailure({
    mechanism: "throw",
    throwable: "custom-error",
    marker,
  });

  const captured = await fixture.logs.waitForLog({
    predicate: (log: any) =>
      log.request?.waitUntil === true && log.request.parentRequestId === fixture.lastRequestId(),
  });

  expect(captured).toMatchObject({
    request: {
      path: "/api/orpc/testing/emitWaitUntilFailure#waitUntil",
      method: "POST",
      waitUntil: true,
      parentRequestId: fixture.lastRequestId(),
    },
  });
  expect(normalize(captured, { marker })).toMatchInlineSnapshot(`
    "meta:
      id: <id>
      start: <start>
      end: <end>
      durationMs: <duration-ms>
    parent:
      meta:
        id: <id>
        start: <start>
      service: os
      environment: dev-misha
      request:
        path: /api/orpc/testing/emitWaitUntilFailure
        status: -1
        method: POST
        id: <id>
        url: <origin>/api/orpc/testing/emitWaitUntilFailure
        hostname: local.iterate.com
        traceparent: null
        cfRay: <cf-ray>
        timezone: <timezone>
      user:
        id: <id>
        email: unknown
      egress:
        <origin> <origin>
    service: os
    environment: dev-misha
    request:
      id: <id>
      method: POST
      path: /api/orpc/testing/emitWaitUntilFailure#waitUntil
      status: 500
      waitUntil: true
      parentRequestId: <parent-request-id>
    egress:
      <origin> <origin>
    user:
      id: <id>
      email: unknown
    errors:
      - name: TestingCustomError
        message: "[test_custom_error] <marker>"
        stack: >-
          TestingCustomError: [test_custom_error] <marker>
              at createTestingThrowable (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at runTestingFailureScenario (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at <repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>
        exampleGroup: testing-example
        exampleField: <marker>
      - name: TestingCustomError
        message: "[test_custom_error] <marker>"
        stack: >-
          TestingCustomError: [test_custom_error] <marker>
              at createTestingThrowable (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at runTestingFailureScenario (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at <repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>
        exampleGroup: testing-example
        exampleField: <marker>
    messages:
      - "[ERROR] <elapsed>s: TestingCustomError: [test_custom_error] <marker>"
      - "[INFO] <elapsed>s: PostHog log exception dispatch requestId=<uuid>:waitUntil:<uuid>
        path=/api/orpc/testing/emitWaitUntilFailure#waitUntil errorCount=1"
      - "[INFO] <elapsed>s: PostHog log exception sent requestId=<uuid>:waitUntil:<uuid>"
      - "[ERROR] <elapsed>s: [test_custom_error] <marker>""
  `);
});

test("does not capture PostHog for successful outbox consumer flow", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `outbox-success-${crypto.randomUUID()}`;
  await fixture.client.testing.emitSuccessfulOutboxEvent({ message: marker });
  await expect
    .poll(
      () =>
        fixture.posthog.requests.some((request) => JSON.stringify(request.body).includes(marker)),
      { timeout: 1_000 },
    )
    .toBe(false);
  expect(normalize(fixture.posthog.requests)).toMatchInlineSnapshot(`"[]"`);
});

test("captures an outbox consumer error", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `outbox-fail-${crypto.randomUUID()}`;
  await fixture.client.testing.emitOutboxFailure({
    mechanism: "throw",
    throwable: "error",
    marker,
  });

  const captured = await fixture.posthog.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes(marker),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "outbox/testingFailureConsumer",
      method: "OUTBOX",
    },
  });
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
    "api_key: <api_key>
    event: $exception
    distinct_id: system:outbox
    properties:
      $exception_list:
        - type: Error
          value: "[test_error] <marker>"
          mechanism:
            handled: true
            synthetic: false
          stacktrace:
            type: raw
            frames:
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: createTestingThrowable
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: runTestingFailureScenario
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/consumers.ts
                function: Object.handler
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: Object.handler
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: runHandler
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/outbox-logging.ts
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/logging/logger.ts
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/logging/logger.ts
                function: Object.run
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/outbox-logging.ts
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: true
      $environment: <$environment>
      $lib: os-logging
      request:
        id: <id>
        method: OUTBOX
        path: outbox/testingFailureConsumer
        status: 500
        duration: <duration>
        waitUntil: false
        url: <origin>/api/orpc/testing/emitOutboxFailure
      user:
        id: <id>
        email: outbox@system
    timestamp: <timestamp>"
  `);
});

test("captures assigned detail in an outbox log", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `outbox-detail-${crypto.randomUUID()}`;
  await fixture.client.testing.emitOutboxFailure({
    mechanism: "throw",
    throwable: "error-with-detail",
    marker,
  });

  const captured = await fixture.logs.waitForLog({
    predicate: (log: any) =>
      log.request?.method === "OUTBOX" && JSON.stringify(log).includes(marker),
  });

  expect(captured).toMatchObject({
    request: {
      path: "outbox/testingFailureConsumer",
      method: "OUTBOX",
      status: 500,
    },
  });
  expect(normalize(captured, { marker })).toMatchInlineSnapshot(`
    "meta:
      id: <id>
      start: <start>
      end: <end>
      durationMs: <duration-ms>
    parent:
      meta:
        id: <id>
        start: <start>
      service: os
      environment: dev-misha
      request:
        path: /api/orpc/testing/emitOutboxFailure
        status: -1
        method: POST
        id: <id>
        url: <origin>/api/orpc/testing/emitOutboxFailure
        hostname: local.iterate.com
        traceparent: null
        cfRay: <cf-ray>
        timezone: <timezone>
      user:
        id: <id>
        email: unknown
      egress:
        <origin> <origin>
      messages:
        - "[INFO] <elapsed>s: [outbox] adding to pgmq:rpc:testing.emitOutboxFailure"
        - "[INFO] <elapsed>s: [outbox] Path: rpc:testing.emitOutboxFailure. Consumers: 1.
          Filtered: testingFailureConsumer"
        - "[INFO] <elapsed>s: [outbox] processing 1 messages"
        - "[INFO] <elapsed>s: [outbox] START msg_id=<job-id> consumer=testingFailureConsumer"
    request:
      id: <id>
      method: OUTBOX
      path: outbox/testingFailureConsumer
      status: 500
      waitUntil: false
    user:
      id: <id>
      email: outbox@system
    outbox:
      consumerName: testingFailureConsumer
      jobId: <job-id>
      attempt: 1
      eventName: rpc:testing.emitOutboxFailure
      eventId: <event-id>
      causation: null
      ok: false
      error: {}
    errors:
      - name: Error
        message: "[test_error_with_detail] <marker>"
        stack: >-
          Error: [test_error_with_detail] <marker>
              at createTestingThrowable (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at runTestingFailureScenario (<repo>/apps/os/backend/orpc/routers/testing.ts:<lineno>:<colno>)
              at Object.handler (<repo>/apps/os/backend/outbox/consumers.ts:<lineno>:<colno>)
              at Object.handler (<repo>/apps/os/backend/outbox/pgmq-lib.ts:<lineno>:<colno>)
              at <repo>/apps/os/backend/outbox/pgmq-lib.ts:<lineno>:<colno>
              at runHandler (<repo>/apps/os/backend/outbox/pgmq-lib.ts:<lineno>:<colno>)
              at <repo>/apps/os/backend/outbox/outbox-logging.ts:<lineno>:<colno>
              at <repo>/apps/os/backend/logging/logger.ts:<lineno>:<colno>
              at Object.run (<repo>/apps/os/backend/logging/logger.ts:<lineno>:<colno>)
              at <repo>/apps/os/backend/outbox/outbox-logging.ts:<lineno>:<colno>
        detail:
          bar: 123
          marker: <marker>
    messages:
      - "[ERROR] <elapsed>s: Error: [test_error_with_detail] <marker>""
  `);
});

test("captures a malformed outbox job error", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `malformed-${crypto.randomUUID()}`;
  await fixture.client.testing.insertMalformedOutboxJob({ marker });

  const captured = await fixture.posthog.waitForRequest({
    predicate: (body) => JSON.stringify(body).includes("invalid message"),
  });

  expect(captured.body.properties).toMatchObject({
    request: {
      path: "outbox/invalid-consumer-job",
      method: "OUTBOX",
    },
  });
  expect(normalize(captured.body, { marker })).toMatchInlineSnapshot(`
    "api_key: <api_key>
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
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: emit
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: processQueue
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: Object.handler
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: false
      $environment: <$environment>
      $lib: outbox-dlq
      request:
        id: <id>
        method: OUTBOX
        path: outbox/invalid-consumer-job
        status: 500
        duration: <duration>
        waitUntil: false
      user:
        id: <id>
        email: outbox@system
      outbox:
        consumerName: invalid-consumer-job
        jobId: <job-id>
        attempt: 1
        eventName: invalid-message
        eventId: <event-id>
        causation: null
        processingResults: []
        status: failed
    timestamp: <timestamp>"
  `);
});

test("captures a missing consumer error", async () => {
  await using fixture = await createLoggingFixture();
  const marker = `missing-consumer-${crypto.randomUUID()}`;
  await fixture.client.testing.insertMissingConsumerOutboxJob({ marker });

  const captured = await fixture.posthog.waitForRequest({
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
    "api_key: <api_key>
    event: $exception
    distinct_id: system:outbox
    properties:
      $exception_list:
        - type: OutboxDLQ:missing-consumer-<marker>
          value: "Error: [outbox] no consumer found for
            event=testing:missing-consumer:<marker>
            consumer=missing-consumer-<marker>"
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
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: emit
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: archiveFailedJob
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/outbox/pgmq-lib.ts
                function: processQueue
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/apps/os/backend/orpc/routers/testing.ts
                function: Object.handler
                lineno: <lineno>
                colno: <colno>
                in_app: true
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: next
                lineno: <lineno>
                colno: <colno>
                in_app: false
              - platform: custom
                lang: javascript
                filename: <repo>/.../node_modules/.vite/...
                function: <anonymous>
                lineno: <lineno>
                colno: <colno>
                in_app: false
      $environment: <$environment>
      $lib: outbox-dlq
      request:
        id: <id>
        method: OUTBOX
        path: outbox/missing-consumer-<marker>
        status: 500
        duration: <duration>
        waitUntil: false
      user:
        id: <id>
        email: outbox@system
      outbox:
        consumerName: missing-consumer-<marker>
        jobId: <job-id>
        attempt: 1
        eventName: testing:missing-consumer:<marker>
        eventId: <event-id>
        causation: null
        processingResults:
          - "#1 error: Error: [outbox] no consumer found for
            event=testing:missing-consumer:<marker>
            consumer=missing-consumer-<marker>. retry: false. reason: Error marked
            non-retryable."
        status: failed
    timestamp: <timestamp>"
  `);
});

test("returns a clean 400 and logs invalid orpc input", async () => {
  await using fixture = await createLoggingFixture();

  const error = await fixture.client.testing
    .emitSuccessfulOutboxEvent({ message: 123 as never })
    .catch((error) => error);

  expect(error).toMatchObject({
    code: "BAD_REQUEST",
    message: "Input validation failed",
    status: 400,
    data: { issues: [{ code: "invalid_type", expected: "string", path: ["message"] }] },
  });
  expect(normalize(error)).toMatchInlineSnapshot(`
    "defined: false
    code: BAD_REQUEST
    status: 400
    message: Input validation failed
    data:
      issues:
        - expected: string
          code: invalid_type
          path:
            - message
          message: "Invalid input: expected string, received number""
  `);

  const captured = await fixture.logs.waitForLog({
    predicate: (log) => log.request?.id === fixture.lastRequestId(),
  });

  expect(captured).toMatchObject({
    request: {
      id: fixture.lastRequestId(),
      path: "/api/orpc/testing/emitSuccessfulOutboxEvent",
      method: "POST",
      status: 400,
    },
  });
  expect(normalize(captured)).toMatchInlineSnapshot(`
    "meta:
      id: <id>
      start: <start>
      end: <end>
      durationMs: <duration-ms>
    service: os
    environment: dev-misha
    request:
      path: /api/orpc/testing/emitSuccessfulOutboxEvent
      status: 400
      method: POST
      id: <id>
      url: <origin>/api/orpc/testing/emitSuccessfulOutboxEvent
      hostname: local.iterate.com
      traceparent: null
      cfRay: <cf-ray>
      timezone: <timezone>
    user:
      id: <id>
      email: unknown
    egress:
      <origin> <origin>
    errors:
      - name: Error
        message: Input validation failed
        stack: |-
          Error: Input validation failed
              at <repo>/.../node_modules/.vite/...
    messages:
      - "[WARN] <elapsed>s: ✖ Invalid input: expected string, received number → at message""
  `);
});

type CapturedPostHogRequest = {
  path: string;
  body: Record<string, unknown>;
};

type LoggingFixture = {
  client: RouterClient<AppRouter>;
  lastRequestId(): string;
  posthog: {
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

async function createLoggingFixture(): Promise<LoggingFixture> {
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
    posthog: {
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
  const yaml = YAML.stringify(value, function replacer(this: any, key, rawValue) {
    const normalizeableKeys = `id,api_key,timestamp,start,end,lineno,colno,duration,durationMs,jobId,eventId,parentRequestId,cfRay,timezone,$environment`;
    if (normalizeableKeys.split(",").includes(key))
      return `<${key.replace(/[A-Z]/g, (letter: string) => `-${letter.toLowerCase()}`)}>`;
    if (typeof rawValue !== "string") return rawValue;
    return rawValue
      .replaceAll(repoRoot, "<repo>")
      .replaceAll(params.marker || randomUUID(), "<marker>")
      .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
      .replace(/<repo>\/[^ :)\n"]+(?::\d+:\d+)?/g, (path) => {
        if (path.includes(":")) path = `${path.split(":")[0]}:<lineno>:<colno>`;
        if (!path.includes("/node_modules/")) return path;
        return `<repo>/.../node_modules/${path.split("/node_modules/")[1].split("/")[0]}/...`;
      });
  });

  return yaml
    .replaceAll(repoRoot, "<repo>")
    .replaceAll(/https?:\/\/[^/\s]+/g, "<origin>")
    .replaceAll(/\[(DEBUG|INFO|WARN|ERROR)\] \d+(?:\.\d+)?s:/g, "[$1] <elapsed>s:")
    .replaceAll(/msg_id=\d+/g, "msg_id=<job-id>")
    .trimEnd();
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
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
