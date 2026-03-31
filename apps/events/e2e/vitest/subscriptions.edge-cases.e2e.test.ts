/**
 * These cases pin the subtle delivery races that are easy to reintroduce while
 * changing the subscription scheduler. Keep them short and black-box.
 */
import { setTimeout as delay } from "node:timers/promises";
import { HttpResponse, http } from "msw";
import { describe, expect, test, vi } from "vitest";
import { SUBSCRIPTION_CURSOR_UPDATED_TYPE } from "@iterate-com/events-contract";
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
const testTimeoutMs = 6_000;

describe.sequential("subscription edge cases", () => {
  test(
    "head subscriptions on idle streams should quiesce without sending phantom deliveries",
    async () => {
      /**
       * A brand-new `startFrom: "head"` subscription should eventually settle
       * with `nextDeliveryAt = null` if there is nothing deliverable after its
       * cursor.
       */
      await using hook = await useWebhookSink({ pathname: "/idle" });
      hook.replyJson(200, { ok: true });

      const path = app.newStreamPath("/subscriptions-edge");
      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "alpha",
            url: hook.endpointUrl,
            startFrom: "head",
          }),
        ],
      });

      const state = await waitForStreamState({
        app,
        streamPath: path,
        timeoutMs: 1_500,
        predicate: (currentState) =>
          subscriptionCursor(currentState, "alpha")?.nextDeliveryAt === null,
      });
      const history = await collectAsyncIterableUntilIdle({
        iterable: await app.client.stream({ path, live: false }),
        idleMs: 250,
      });

      expect(hook.deliveries()).toHaveLength(0);
      expect(history.map((event) => event.type)).toContain(SUBSCRIPTION_CURSOR_UPDATED_TYPE);
      expect(deliveredEventTypes(hook)).not.toContain(SUBSCRIPTION_CURSOR_UPDATED_TYPE);
      expect(subscriptionCursor(state, "alpha")?.nextDeliveryAt).toBeNull();
    },
    testTimeoutMs,
  );

  test(
    "a second user event should not be stranded while the first webhook delivery is still in flight",
    async () => {
      /**
       * Once the first delivery completes, the subscription should continue and
       * deliver the later user event too.
       */
      const releaseFirstResponse = createGate<Response>();
      const seenRequests: string[] = [];

      await using hook = await useWebhookSink({ pathname: "/stale-success" });
      hook.use(
        http.post(hook.endpointUrl, async ({ request }) => {
          seenRequests.push(await request.text());
          if (seenRequests.length === 1) {
            return releaseFirstResponse.promise;
          }

          return HttpResponse.json({ ok: true });
        }),
      );

      const path = app.newStreamPath("/subscriptions-edge");
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

      await waitFor(() => {
        expect(seenRequests).toHaveLength(1);
      });

      await app.appendEvent({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 2 },
      });

      releaseFirstResponse.resolve(HttpResponse.json({ ok: true }));

      await hook.waitForCount({ count: 2, timeoutMs: 1_500 });
      const state = await waitForStreamState({
        app,
        streamPath: path,
        timeoutMs: 1_500,
        predicate: (currentState) =>
          subscriptionCursor(currentState, "alpha")?.lastAcknowledgedOffset ===
          app.expectedOffset(3),
      });

      expect(subscriptionCursor(state, "alpha")?.lastAcknowledgedOffset).toBe(
        app.expectedOffset(3),
      );
    },
    testTimeoutMs,
  );

  test(
    "rewinding an existing slug during an in-flight delivery should win over the stale success outcome",
    async () => {
      /**
       * The second `subscription.set(startFrom: "head")` rewinds the cursor and
       * leaves the subscription due to replay from the beginning again.
       */
      const releaseFirstResponse = createGate<Response>();
      const releaseReplayResponse = createGate<Response>();
      let seenCount = 0;

      await using hook = await useWebhookSink({ pathname: "/rewind" });
      hook.use(
        http.post(hook.endpointUrl, async () => {
          seenCount += 1;
          if (seenCount === 1) {
            return releaseFirstResponse.promise;
          }

          return releaseReplayResponse.promise;
        }),
      );

      const path = app.newStreamPath("/subscriptions-edge");
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

      await waitFor(() => {
        expect(seenCount).toBe(1);
      });

      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "alpha",
            url: hook.endpointUrl,
            startFrom: "head",
          }),
        ],
      });

      releaseFirstResponse.resolve(HttpResponse.json({ ok: true }));

      try {
        const state = await waitForStreamState({
          app,
          streamPath: path,
          timeoutMs: 1_500,
          predicate: (currentState) =>
            subscriptionCursor(currentState, "alpha")?.lastAcknowledgedOffset === null,
        });

        expect(subscriptionCursor(state, "alpha")?.lastAcknowledgedOffset).toBeNull();
        expect(subscriptionCursor(state, "alpha")?.nextDeliveryAt).toEqual(expect.any(String));
      } finally {
        releaseReplayResponse.resolve(HttpResponse.json({ ok: true }));
      }
    },
    testTimeoutMs,
  );

  test(
    "rewinding during an in-flight failed delivery should not inherit the stale failure cursor",
    async () => {
      /**
       * A stale failed outcome is the dangerous branch because it could
       * otherwise schedule retries and overwrite a newer rewind. After the
       * rewind, the subscription may replay successfully, but it must not keep
       * the stale failure's retry/error state.
       */
      const releaseFirstResponse = createGate<Response>();
      let seenCount = 0;

      await using hook = await useWebhookSink({ pathname: "/rewind-failed" });
      hook.use(
        http.post(hook.endpointUrl, async () => {
          seenCount += 1;
          if (seenCount === 1) {
            return releaseFirstResponse.promise;
          }

          return HttpResponse.json({ ok: true });
        }),
      );

      const path = app.newStreamPath("/subscriptions-edge");
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

      await waitFor(() => {
        expect(seenCount).toBe(1);
      });

      await app.appendEvents({
        path,
        events: [
          app.subscriptionSet({
            path,
            slug: "alpha",
            url: hook.endpointUrl,
            startFrom: "head",
          }),
        ],
      });

      releaseFirstResponse.resolve(new HttpResponse("nope", { status: 500 }));

      const state = await waitForStreamState({
        app,
        streamPath: path,
        timeoutMs: 1_500,
        predicate: (currentState) =>
          subscriptionCursor(currentState, "alpha")?.lastAcknowledgedOffset ===
            app.expectedOffset(2) &&
          subscriptionCursor(currentState, "alpha")?.nextDeliveryAt === null,
      });

      expect(subscriptionCursor(state, "alpha")).toMatchObject({
        lastAcknowledgedOffset: app.expectedOffset(2),
        nextDeliveryAt: null,
        retries: 0,
        lastError: null,
      });
    },
    testTimeoutMs,
  );

  test(
    "removing a subscription during an in-flight delivery should leave it removed after the stale outcome lands",
    async () => {
      /**
       * A held-open webhook request can still finish after `subscription.removed`
       * has been appended, but its stale outcome must not resurrect the slug.
       */
      const releaseResponse = createGate<Response>();
      let startedRequests = 0;

      await using hook = await useWebhookSink({ pathname: "/removed" });
      hook.use(
        http.post(hook.endpointUrl, async () => {
          startedRequests += 1;
          return releaseResponse.promise;
        }),
      );

      const path = app.newStreamPath("/subscriptions-edge");
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

      await waitFor(() => {
        expect(startedRequests).toBe(1);
      });

      await app.appendEvents({
        path,
        events: [app.subscriptionRemoved({ path, slug: "alpha" })],
      });

      releaseResponse.resolve(HttpResponse.json({ ok: true }));
      await delay(250);

      const state = await waitForStreamState({
        app,
        streamPath: path,
        timeoutMs: 1_500,
        predicate: (currentState) => subscriptionCursor(currentState, "alpha") == null,
      });

      expect(subscriptionCursor(state, "alpha")).toBeUndefined();
      expect(hook.deliveries()).toHaveLength(1);
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
    retries?: number;
    lastError?: unknown;
  };
}

function createGate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, {
    interval: 50,
    timeout: 1_500,
  });
}

function deliveredEventTypes(hook: {
  deliveries(): Array<{ payload: { event?: { type?: string } } | null }>;
}) {
  return hook
    .deliveries()
    .map((delivery) => delivery.payload?.event?.type)
    .filter((type): type is string => type != null);
}
