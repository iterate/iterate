/**
 * These cases pin the subtle delivery races that are easy to reintroduce while
 * changing the subscription scheduler. Keep them short and black-box.
 */
import { HttpResponse, http } from "msw";
import { describe, expect, test, vi } from "vitest";
import { createEventsE2eFixture, requireEventsBaseUrl, useWebhookSink } from "../helpers.ts";

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
      await app.client.append({
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

      const state = await app.waitForState({
        streamPath: path,
        timeoutMs: 1_500,
        predicate: (currentState) =>
          currentState.subscriptions.alpha?.cursor.nextDeliveryAt === null,
      });

      expect(hook.deliveries()).toHaveLength(0);
      expect(state.subscriptions.alpha?.cursor.nextDeliveryAt).toBeNull();
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

      await waitFor(() => {
        expect(seenRequests).toHaveLength(1);
      });

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 2 },
      });

      releaseFirstResponse.resolve(HttpResponse.json({ ok: true }));

      await hook.waitForCount({ count: 2, timeoutMs: 1_500 });
      const state = await app.waitForState({
        streamPath: path,
        timeoutMs: 1_500,
        predicate: (currentState) =>
          currentState.subscriptions.alpha?.cursor.lastAcknowledgedOffset === app.expectedOffset(3),
      });

      expect(state.subscriptions.alpha?.cursor.lastAcknowledgedOffset).toBe(app.expectedOffset(3));
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

      await waitFor(() => {
        expect(seenCount).toBe(1);
      });

      await app.client.append({
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
        const state = await app.waitForState({
          streamPath: path,
          timeoutMs: 1_500,
          predicate: (currentState) =>
            currentState.subscriptions.alpha?.cursor.lastAcknowledgedOffset === null,
        });

        expect(state.subscriptions.alpha?.cursor.lastAcknowledgedOffset).toBeNull();
        expect(state.subscriptions.alpha?.cursor.nextDeliveryAt).toEqual(expect.any(String));
      } finally {
        releaseReplayResponse.resolve(HttpResponse.json({ ok: true }));
      }
    },
    testTimeoutMs,
  );
});

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
