import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { EphemeralEventBuffer } from "./ephemeral-event-buffer.ts";

function event(offset: number, type = "events.iterate.test/ephemeral"): StreamEvent {
  return {
    type,
    ephemeral: true,
    payload: { offset },
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/tests/ephemeral-buffer",
  };
}

describe("EphemeralEventBuffer", () => {
  it("evicts the oldest events by exact serialized byte size", () => {
    const sizingBuffer = new EphemeralEventBuffer(10_000);
    const first = sizingBuffer.prepare([event(1)])[0]!;
    const second = sizingBuffer.prepare([event(2)])[0]!;
    const third = sizingBuffer.prepare([event(3)])[0]!;
    const buffer = new EphemeralEventBuffer(second.byteLength + third.byteLength);

    buffer.commit([first, second, third]);

    expect(buffer.getByOffset(1)).toBeUndefined();
    expect(
      buffer
        .getRangeSized({ afterOffset: 0, beforeOffset: 4, limit: 10 })
        .map((entry) => entry.event.offset),
    ).toEqual([2, 3]);
    expect(buffer.runtimeState()).toEqual({
      maxBytes: second.byteLength + third.byteLength,
      bytes: second.byteLength + third.byteLength,
      eventCount: 2,
      oldestOffset: 2,
      newestOffset: 3,
      evictedEventCount: 1,
      evictedBytes: first.byteLength,
    });
  });

  it("rejects one event larger than the complete memory budget before mutation", () => {
    const buffer = new EphemeralEventBuffer(100);

    expect(() => buffer.prepare([event(1)])).toThrow(/memory-only limit is 100 bytes/);
    expect(buffer.runtimeState()).toMatchObject({ bytes: 0, eventCount: 0 });
  });

  it("retains only the newest suffix when one append exceeds the buffer budget", () => {
    const sizingBuffer = new EphemeralEventBuffer(10_000);
    const first = sizingBuffer.prepare([event(1)])[0]!;
    const second = sizingBuffer.prepare([event(2)])[0]!;
    const third = sizingBuffer.prepare([event(3)])[0]!;
    const buffer = new EphemeralEventBuffer(second.byteLength + third.byteLength);

    buffer.commit([first]);
    buffer.commit([second, third]);

    expect(buffer.runtimeState()).toMatchObject({
      bytes: second.byteLength + third.byteLength,
      eventCount: 2,
      oldestOffset: 2,
      newestOffset: 3,
    });
    expect(
      buffer
        .getRangeSized({ afterOffset: 0, beforeOffset: 4, limit: 10 })
        .map((entry) => entry.event.offset),
    ).toEqual([2, 3]);
  });

  it("applies offset and event-type filters before the limit", () => {
    const buffer = new EphemeralEventBuffer(10_000);
    buffer.commit(
      buffer.prepare([
        event(1, "events.iterate.test/selected"),
        event(2, "events.iterate.test/other"),
        event(3, "events.iterate.test/selected"),
      ]),
    );

    expect(
      buffer
        .getRangeSized({
          afterOffset: 0,
          beforeOffset: 4,
          eventTypes: ["events.iterate.test/selected"],
          limit: 1,
        })
        .map((entry) => entry.event.offset),
    ).toEqual([1]);
    expect(
      buffer.getRangeSized({
        afterOffset: 0,
        beforeOffset: 4,
        eventTypes: [],
        limit: 10,
      }),
    ).toEqual([]);
  });
});
