import { expect, it } from "vitest";
import { postHogEventBatches, systemEvent, type PostHogEvent } from "./posthog-events.ts";

it("uses a stable top-level PostHog UUID for eventual retry and replay deduplication", () => {
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

  expect(postHogEventBatches(events, oneEventBytes * 2 + 1)).toEqual([
    [events[0], events[1]],
    [events[2]],
  ]);
});

it("keeps an individually oversized event intact for an explicit API failure", () => {
  const event = eventWithPayload("oversized", "1234567890");
  expect(postHogEventBatches([event], 1)).toEqual([[event]]);
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects an invalid capture batch byte budget (%s)",
  (budget) => {
    expect(() => postHogEventBatches([], budget)).toThrow(
      "PostHog batch event budget must be a positive safe integer",
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
