import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  postHogEventBatches,
  sendPostHogEvents,
  systemEvent,
  type PostHogEvent,
} from "./posthog-events.ts";

it("uses a stable top-level PostHog UUID for retry and replay deduplication", () => {
  const first = systemEvent("ci test finished", "stable-source-occurrence", "ci-test:1", {});
  const replay = systemEvent("ci test finished", "stable-source-occurrence", "ci-test:1", {});
  const other = systemEvent("ci test finished", "different-occurrence", "ci-test:1", {});

  expect(first.uuid).toBe(replay.uuid);
  expect(first.uuid).not.toBe(other.uuid);
  expect(first.uuid).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(first.properties.$insert_id).toBe("stable-source-occurrence");
});

it("packs capture batches by encoded payload size", () => {
  const events = [
    eventWithPayload("a", "1234"),
    eventWithPayload("b", "5678"),
    eventWithPayload("c", "9"),
  ];
  const oneEventBytes = Buffer.byteLength(JSON.stringify(events[0]));

  expect(postHogEventBatches(events, oneEventBytes * 2 + 1, 100)).toEqual([
    [events[0], events[1]],
    [events[2]],
  ]);
});

it("bounds capture batches by event count before a valid large request becomes a burst", () => {
  const events = [
    eventWithPayload("a", "1"),
    eventWithPayload("b", "2"),
    eventWithPayload("c", "3"),
    eventWithPayload("d", "4"),
    eventWithPayload("e", "5"),
  ];

  expect(postHogEventBatches(events, 1_000_000, 2)).toEqual([
    [events[0], events[1]],
    [events[2], events[3]],
    [events[4]],
  ]);
});

it("paces consecutive capture requests instead of bursting a complete CI run", async () => {
  await using endpoint = await postHogCaptureEndpoint();
  const events = Array.from({ length: 201 }, (_, index) =>
    eventWithPayload(String(index), "payload"),
  );

  await sendPostHogEvents(events, { apiKey: "phc_test", host: endpoint.url });

  expect(endpoint.requestTimes).toHaveLength(3);
  expect(endpoint.requestTimes[1]! - endpoint.requestTimes[0]!).toBeGreaterThanOrEqual(450);
  expect(endpoint.requestTimes[2]! - endpoint.requestTimes[1]!).toBeGreaterThanOrEqual(450);
});

it("keeps an individually oversized event intact for an explicit API failure", () => {
  const event = eventWithPayload("oversized", "1234567890");
  expect(postHogEventBatches([event], 1, 100)).toEqual([[event]]);
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects an invalid capture batch byte budget (%s)",
  (budget) => {
    expect(() => postHogEventBatches([], budget, 100)).toThrow(
      "PostHog batch event budget must be a positive safe integer",
    );
  },
);

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects an invalid capture batch event limit (%s)",
  (eventLimit) => {
    expect(() => postHogEventBatches([], 1_000_000, eventLimit)).toThrow(
      "PostHog batch event limit must be a positive safe integer",
    );
  },
);

function eventWithPayload(id: string, payload: string): PostHogEvent {
  return {
    event: "ci test finished",
    uuid: id,
    properties: { distinct_id: `ci-test:${id}`, payload },
  };
}

async function postHogCaptureEndpoint() {
  const requestTimes: number[] = [];
  const server = createServer((request, response) => {
    requestTimes.push(performance.now());
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"Ok"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as any;
  return {
    requestTimes,
    url: `http://127.0.0.1:${address.port}`,
    async [Symbol.asyncDispose]() {
      server.close();
      await once(server, "close");
    },
  };
}
