/**
 * These are black-box subscription checks. They only inspect public surfaces:
 * webhook traffic, stream history/SSE, and `getState()`, so the same
 * assertions can run against local or deployed workers.
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import {
  SUBSCRIPTION_CURSOR_UPDATED_TYPE,
  SUBSCRIPTION_DELIVERY_FAILED_TYPE,
  SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE,
  SUBSCRIPTION_SET_TYPE,
} from "@iterate-com/events-contract";
import { createNativeMswServer } from "../../../../packages/mock-http-proxy/src/server/msw-server-adapter.ts";
import {
  collectAsyncIterableUntilIdle,
  createEventsE2eFixture,
  requireEventsBaseUrl,
  useWebhookSink,
  waitForStreamState,
} from "../helpers.ts";

const app = createEventsE2eFixture({
  baseURL: requireEventsBaseUrl(),
});
const testTimeoutMs = 10_000;

describe.sequential("subscription e2e", () => {
  test(
    "delivers one user event to one webhook and advances the cursor",
    async () => {
      await using hook = await useWebhookSink({ pathname: "/inbox" });
      hook.replyJson(200, { ok: true });

      const path = app.newStreamPath();
      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "alpha",
            url: hook.endpointUrl,
            startFrom: "head",
          }),
          app.userEvent({ path, payload: { value: 1 } }),
        ],
      });

      const deliveries = await hook.waitForCount({ count: 1 });
      const historyAfterSuccess = await collectAsyncIterableUntilIdle({
        iterable: await app.client.stream({ path, live: false }),
        idleMs: 250,
      });
      const succeededDeliveryEvent = historyAfterSuccess.find(
        (event) => event.type === SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE,
      );

      expect(deliveries.map((delivery) => delivery.payload)).toEqual([
        {
          subscriptionSlug: "alpha",
          event: expect.objectContaining({
            offset: app.expectedOffset(2),
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { value: 1 },
          }),
        },
      ]);
      expect(succeededDeliveryEvent).toMatchObject({
        payload: {
          attempted: {
            url: hook.endpointUrl,
            headers: {
              "content-type": "application/json",
            },
            body: {
              subscriptionSlug: "alpha",
              event: {
                offset: app.expectedOffset(2),
                payload: { value: 1 },
              },
            },
          },
        },
      });

      expect(await app.getState(path)).toMatchObject({
        subscriptions: {
          alpha: {
            type: "webhook",
            url: hook.endpointUrl,
            headers: {},
            cursor: {
              lastAcknowledgedOffset: app.expectedOffset(2),
              nextDeliveryAt: null,
              retries: 0,
              lastError: null,
            },
          },
        },
      });
    },
    testTimeoutMs,
  );

  test(
    "retries after failure at the scheduled time and then succeeds",
    async () => {
      await using hook = await useWebhookSink({ pathname: "/retry" });
      hook.replySequence([
        () => new HttpResponse("nope", { status: 500 }),
        () => HttpResponse.json({ ok: true }),
      ]);

      const path = app.newStreamPath();
      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "alpha",
            url: hook.endpointUrl,
            startFrom: "head",
          }),
          app.userEvent({ path, payload: { value: 1 } }),
        ],
      });

      const failedState = await waitForStreamState({
        app,
        streamPath: path,
        predicate: (state) => subscriptionCursor(state, "alpha")?.retries === 1,
      });
      const historyAfterFailure = await collectAsyncIterableUntilIdle({
        iterable: await app.client.stream({ path, live: false }),
        idleMs: 250,
      });
      const scheduledRetryAt = Date.parse(
        subscriptionCursor(failedState, "alpha")?.nextDeliveryAt ?? "",
      );
      const failedDeliveryEvent = historyAfterFailure.find(
        (event) => event.type === SUBSCRIPTION_DELIVERY_FAILED_TYPE,
      );

      const deliveries = await hook.waitForCount({ count: 2 });
      const retryDelayMs = deliveries[1]!.startedAtMs - deliveries[0]!.startedAtMs;

      expect(failedDeliveryEvent).toMatchObject({
        payload: {
          attempted: {
            url: hook.endpointUrl,
            headers: {
              "content-type": "application/json",
            },
            body: {
              subscriptionSlug: "alpha",
              event: {
                offset: app.expectedOffset(2),
                payload: { value: 1 },
              },
            },
          },
        },
      });
      expect(retryDelayMs).toBeGreaterThanOrEqual(200);
      expect(deliveries[1]!.startedAtMs).toBeGreaterThanOrEqual(scheduledRetryAt - 50);
      expect(deliveries.map((delivery) => delivery.payload?.event.type)).toEqual([
        "https://events.iterate.com/events/example/value-recorded",
        "https://events.iterate.com/events/example/value-recorded",
      ]);

      const state = await waitForStreamState({
        app,
        streamPath: path,
        predicate: (currentState) =>
          subscriptionCursor(currentState, "alpha")?.lastAcknowledgedOffset ===
          app.expectedOffset(2),
      });

      expect(subscriptionCursor(state, "alpha")).toEqual({
        lastAcknowledgedOffset: app.expectedOffset(2),
        nextDeliveryAt: null,
        retries: 0,
        lastError: null,
      });
    },
    testTimeoutMs,
  );

  test(
    "retry still happens without extra worker traffic between attempts",
    async () => {
      /**
       * Agents explicitly tests that retries are driven by scheduler state, not
       * by incidental later calls. After the initial append we only watch the
       * sink and let the DO alarm wake itself.
       */
      await using hook = await useWebhookSink({ pathname: "/retry-alone" });
      hook.replySequence([
        () => new HttpResponse("nope", { status: 500 }),
        () => HttpResponse.json({ ok: true }),
      ]);

      const path = app.newStreamPath();
      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "alpha",
            url: hook.endpointUrl,
            startFrom: "head",
          }),
          app.userEvent({ path, payload: { value: 1 } }),
        ],
      });

      const deliveries = await hook.waitForCount({ count: 2, timeoutMs: 2_500 });

      expect(deliveries[1]!.startedAtMs - deliveries[0]!.startedAtMs).toBeGreaterThanOrEqual(200);
      expect(deliveries.map((delivery) => delivery.payload?.event.offset)).toEqual([
        app.expectedOffset(2),
        app.expectedOffset(2),
      ]);
    },
    testTimeoutMs,
  );

  test(
    "removing a subscription before its scheduled retry suppresses the retry",
    async () => {
      /**
       * The retry timer lives in reduced state, not a hidden queue. Removing the
       * slug before `nextDeliveryAt` should therefore prevent the second attempt
       * altogether.
       */
      await using hook = await useWebhookSink({ pathname: "/remove-before-retry" });
      hook.replySequence([
        () => new HttpResponse("nope", { status: 500 }),
        () => HttpResponse.json({ ok: true }),
      ]);

      const path = app.newStreamPath();
      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "alpha",
            url: hook.endpointUrl,
            startFrom: "head",
          }),
          app.userEvent({ path, payload: { value: 1 } }),
        ],
      });

      await waitForStreamState({
        app,
        streamPath: path,
        predicate: (state) => subscriptionCursor(state, "alpha")?.retries === 1,
      });

      await app.appendEvents({
        path,
        events: [app.subscriptionRemoved({ path, slug: "alpha" })],
      });

      await delay(1_000);

      expect(hook.deliveries()).toHaveLength(1);
      expect(await app.getState(path)).toMatchObject({
        subscriptions: {},
      });
    },
    testTimeoutMs,
  );

  test(
    "tail subscriptions do not backfill older events",
    async () => {
      await using hook = await useWebhookSink({ pathname: "/tail" });
      hook.replyJson(200, { ok: true });

      const path = app.newStreamPath();
      await app.appendEvent({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 1 },
      });
      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "alpha",
            url: hook.endpointUrl,
            startFrom: "tail",
          }),
          app.userEvent({ path, payload: { value: 2 } }),
        ],
      });

      const deliveries = await hook.waitForCount({ count: 1 });
      expect(deliveries[0]!.payload?.event.payload).toEqual({ value: 2 });
      expect(deliveries[0]!.payload?.event.offset).toBe(app.expectedOffset(3));
    },
    testTimeoutMs,
  );

  test(
    "multiple queued user events drain in offset order",
    async () => {
      /**
       * The scheduler only delivers one event per subscription attempt, but a
       * backlog should still drain in stream offset order without requiring new
       * external traffic.
       */
      await using hook = await useWebhookSink({ pathname: "/ordered" });
      hook.replyJson(200, { ok: true });

      const path = app.newStreamPath();
      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "alpha",
            url: hook.endpointUrl,
            startFrom: "head",
          }),
          app.userEvent({ path, payload: { value: 1 } }),
          app.userEvent({ path, payload: { value: 2 } }),
          app.userEvent({ path, payload: { value: 3 } }),
        ],
      });

      const deliveries = await hook.waitForCount({ count: 3, timeoutMs: 2_500 });

      expect(deliveries.map((delivery) => delivery.payload?.event.offset)).toEqual([
        app.expectedOffset(2),
        app.expectedOffset(3),
        app.expectedOffset(4),
      ]);
      expect(deliveries.map((delivery) => delivery.payload?.event.payload)).toEqual([
        { value: 1 },
        { value: 2 },
        { value: 3 },
      ]);
    },
    testTimeoutMs,
  );

  test(
    "never delivers internal subscription bookkeeping events, even with two subscribers",
    async () => {
      await using alpha = await useWebhookSink({ pathname: "/alpha" });
      await using beta = await useWebhookSink({ pathname: "/beta" });
      alpha.replyJson(200, { ok: true });
      beta.replyJson(200, { ok: true });

      const path = app.newStreamPath();
      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "alpha",
            url: alpha.endpointUrl,
            startFrom: "head",
          }),
          app.subscriptionSet({
            path,
            slug: "beta",
            url: beta.endpointUrl,
            startFrom: "head",
          }),
          app.userEvent({ path, payload: { value: 1 } }),
        ],
      });

      await alpha.waitForCount({ count: 1 });
      await beta.waitForCount({ count: 1 });

      expect(deliveredEventTypes(alpha)).toEqual([
        "https://events.iterate.com/events/example/value-recorded",
      ]);
      expect(deliveredEventTypes(beta)).toEqual([
        "https://events.iterate.com/events/example/value-recorded",
      ]);
      expect(deliveredEventTypes(alpha)).not.toContain(SUBSCRIPTION_SET_TYPE);
      expect(deliveredEventTypes(alpha)).not.toContain(SUBSCRIPTION_CURSOR_UPDATED_TYPE);
      expect(deliveredEventTypes(alpha)).not.toContain(SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE);
      expect(deliveredEventTypes(alpha)).not.toContain(SUBSCRIPTION_DELIVERY_FAILED_TYPE);
      expect(deliveredEventTypes(beta)).not.toContain(SUBSCRIPTION_SET_TYPE);
      expect(deliveredEventTypes(beta)).not.toContain(SUBSCRIPTION_CURSOR_UPDATED_TYPE);
      expect(deliveredEventTypes(beta)).not.toContain(SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE);
      expect(deliveredEventTypes(beta)).not.toContain(SUBSCRIPTION_DELIVERY_FAILED_TYPE);
    },
    testTimeoutMs,
  );

  test(
    "a timed-out subscriber does not block a healthy subscriber",
    async () => {
      await using slow = await useWebhookSink({ pathname: "/slow" });
      await using fast = await useWebhookSink({ pathname: "/fast" });

      slow.use(
        http.post(slow.endpointUrl, async () => {
          await delay(5_000);
          return HttpResponse.json({ ok: true });
        }),
      );
      fast.replyJson(200, { ok: true });

      const path = app.newStreamPath();
      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "slow",
            url: slow.endpointUrl,
            startFrom: "head",
          }),
          app.subscriptionSet({
            path,
            slug: "fast",
            url: fast.endpointUrl,
            startFrom: "head",
          }),
          app.userEvent({ path, payload: { value: 1 } }),
        ],
      });

      const startedAtMs = Date.now();
      const [fastDelivery] = await fast.waitForCount({ count: 1, timeoutMs: 1_500 });
      expect(fastDelivery?.payload?.event.offset).toBe(app.expectedOffset(3));
      expect(fastDelivery!.startedAtMs - startedAtMs).toBeLessThan(1_800);

      const slowState = await waitForStreamState({
        app,
        streamPath: path,
        timeoutMs: 4_000,
        predicate: (state) => subscriptionCursor(state, "slow")?.retries === 1,
      });

      expect(subscriptionCursor(slowState, "fast")?.lastAcknowledgedOffset).toBe(
        app.expectedOffset(3),
      );
      expect(subscriptionCursor(slowState, "slow")?.lastAcknowledgedOffset).toBeNull();
      expect(subscriptionCursor(slowState, "slow")?.lastError?.message).toContain("timed out");
      expect(subscriptionCursor(slowState, "slow")?.nextDeliveryAt).toEqual(expect.any(String));
    },
    testTimeoutMs,
  );

  test(
    "a never-ending response body does not stop a healthy sibling from finishing",
    async () => {
      await using hanging = await useStreamingWebhookServer({
        pathname: "/hanging-body",
        handler: http.post("/hanging-body", async () => {
          return new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("partial"));
              },
            }),
            {
              status: 200,
              headers: { "content-type": "text/plain" },
            },
          );
        }),
      });
      await using healthy = await useWebhookSink({ pathname: "/healthy-body" });

      healthy.replyJson(200, { ok: true });

      const path = app.newStreamPath();
      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "hanging",
            url: hanging.endpointUrl,
            startFrom: "head",
          }),
          app.subscriptionSet({
            path,
            slug: "healthy",
            url: healthy.endpointUrl,
            startFrom: "head",
          }),
          app.userEvent({ path, payload: { value: 1 } }),
        ],
      });

      await healthy.waitForCount({ count: 1, timeoutMs: 1_500 });
      const state = await waitForStreamState({
        app,
        streamPath: path,
        timeoutMs: 1_500,
        predicate: (currentState) =>
          subscriptionCursor(currentState, "healthy")?.lastAcknowledgedOffset ===
            app.expectedOffset(3) &&
          subscriptionCursor(currentState, "hanging")?.lastAcknowledgedOffset ===
            app.expectedOffset(3),
      });

      expect(subscriptionCursor(state, "healthy")?.lastAcknowledgedOffset).toBe(
        app.expectedOffset(3),
      );
      expect(subscriptionCursor(state, "hanging")?.lastAcknowledgedOffset).toBe(
        app.expectedOffset(3),
      );
    },
    testTimeoutMs,
  );
});

function subscriptionCursor(state: Record<string, unknown>, slug: string) {
  const subscriptions = state.subscriptions;
  if (typeof subscriptions !== "object" || subscriptions == null || Array.isArray(subscriptions)) {
    return undefined;
  }

  const subscription = (subscriptions as Record<string, unknown>)[slug];
  if (typeof subscription !== "object" || subscription == null || Array.isArray(subscription)) {
    return undefined;
  }

  const cursor = (subscription as Record<string, unknown>).cursor;
  if (typeof cursor !== "object" || cursor == null || Array.isArray(cursor)) {
    return undefined;
  }

  return cursor as {
    lastAcknowledgedOffset: string | null;
    nextDeliveryAt: string | null;
    retries: number;
    lastError: { message?: string } | null;
  };
}

async function useStreamingWebhookServer(args: {
  pathname: string;
  handler: ReturnType<typeof http.post>;
}) {
  const server = createNativeMswServer(args.handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  const endpointUrl = new URL(args.pathname, `http://127.0.0.1:${String(address.port)}`).toString();

  return {
    endpointUrl,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function deliveredEventTypes(hook: {
  deliveries(): Array<{ payload: { event?: { type?: string } } | null }>;
}) {
  return hook
    .deliveries()
    .map((delivery) => delivery.payload?.event?.type)
    .filter((type): type is string => type != null);
}
