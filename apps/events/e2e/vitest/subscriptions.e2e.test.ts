/**
 * These are black-box subscription checks. They only inspect network traffic
 * and `getState()`, so the same assertions can run against local or deployed
 * workers.
 */
import { setTimeout as delay } from "node:timers/promises";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import {
  SUBSCRIPTION_CURSOR_UPDATED_TYPE,
  SUBSCRIPTION_DELIVERY_FAILED_TYPE,
  SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE,
  SUBSCRIPTION_SET_TYPE,
} from "@iterate-com/events-contract";
import { createEventsE2eFixture, requireEventsBaseUrl, useWebhookSink } from "../helpers.ts";

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
      await app.client.append({
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

      expect(await app.getParsedState(path)).toMatchObject({
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
      await app.client.append({
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

      const failedState = await app.waitForState({
        streamPath: path,
        predicate: (state) => state.subscriptions.alpha?.cursor.retries === 1,
      });
      const scheduledRetryAt = Date.parse(
        failedState.subscriptions.alpha?.cursor.nextDeliveryAt ?? "",
      );

      const deliveries = await hook.waitForCount({ count: 2 });
      const retryDelayMs = deliveries[1]!.startedAtMs - deliveries[0]!.startedAtMs;

      expect(retryDelayMs).toBeGreaterThanOrEqual(200);
      expect(deliveries[1]!.startedAtMs).toBeGreaterThanOrEqual(scheduledRetryAt - 50);
      expect(deliveries.map((delivery) => delivery.payload?.event.type)).toEqual([
        "https://events.iterate.com/events/example/value-recorded",
        "https://events.iterate.com/events/example/value-recorded",
      ]);

      const state = await app.waitForState({
        streamPath: path,
        predicate: (currentState) =>
          currentState.subscriptions.alpha?.cursor.lastAcknowledgedOffset === app.expectedOffset(2),
      });

      expect(state.subscriptions.alpha?.cursor).toEqual({
        lastAcknowledgedOffset: app.expectedOffset(2),
        nextDeliveryAt: null,
        retries: 0,
        lastError: null,
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
      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 1 },
      });
      await app.client.append({
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
    "never delivers internal subscription bookkeeping events, even with two subscribers",
    async () => {
      await using alpha = await useWebhookSink({ pathname: "/alpha" });
      await using beta = await useWebhookSink({ pathname: "/beta" });
      alpha.replyJson(200, { ok: true });
      beta.replyJson(200, { ok: true });

      const path = app.newStreamPath();
      await app.client.append({
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

      expect(alpha.eventTypes()).toEqual([
        "https://events.iterate.com/events/example/value-recorded",
      ]);
      expect(beta.eventTypes()).toEqual([
        "https://events.iterate.com/events/example/value-recorded",
      ]);
      expect(alpha.eventTypes()).not.toContain(SUBSCRIPTION_SET_TYPE);
      expect(alpha.eventTypes()).not.toContain(SUBSCRIPTION_CURSOR_UPDATED_TYPE);
      expect(alpha.eventTypes()).not.toContain(SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE);
      expect(alpha.eventTypes()).not.toContain(SUBSCRIPTION_DELIVERY_FAILED_TYPE);
      expect(beta.eventTypes()).not.toContain(SUBSCRIPTION_SET_TYPE);
      expect(beta.eventTypes()).not.toContain(SUBSCRIPTION_CURSOR_UPDATED_TYPE);
      expect(beta.eventTypes()).not.toContain(SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE);
      expect(beta.eventTypes()).not.toContain(SUBSCRIPTION_DELIVERY_FAILED_TYPE);
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
      await app.client.append({
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

      const slowState = await app.waitForState({
        streamPath: path,
        timeoutMs: 4_000,
        predicate: (state) => state.subscriptions.slow?.cursor.retries === 1,
      });

      expect(slowState.subscriptions.fast?.cursor.lastAcknowledgedOffset).toBe(
        app.expectedOffset(3),
      );
      expect(slowState.subscriptions.slow?.cursor.lastAcknowledgedOffset).toBeNull();
      expect(slowState.subscriptions.slow?.cursor.lastError?.message).toContain("timed out");
      expect(slowState.subscriptions.slow?.cursor.nextDeliveryAt).toEqual(expect.any(String));
    },
    testTimeoutMs,
  );
});
