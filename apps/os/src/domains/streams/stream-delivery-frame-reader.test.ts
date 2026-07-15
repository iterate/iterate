import { describe, expect, it, vi } from "vitest";
import { StreamDeliveryFrameReader } from "./stream-delivery-frame-reader.ts";
import type { StreamEvent } from "./schemas.ts";

const event = (offset: number, type = "selected", ephemeral = false): StreamEvent => ({
  createdAt: new Date(0).toISOString(),
  offset,
  path: "/test",
  type,
  ...(ephemeral ? { ephemeral: true } : {}),
});

describe("StreamDeliveryFrameReader.tryReadFreshEvents", () => {
  const readerWith = (events: StreamEvent[]) => {
    const readEvents = vi.fn(() => []);
    const reader = new StreamDeliveryFrameReader({ readEvents });
    reader.onWake({
      freshTail: events.map((entry) => ({ event: entry, byteLength: 64 })),
      freshTailByteLength: events.length * 64,
      retainContiguousTail: false,
    });
    return { readEvents, reader };
  };

  it("returns a complete filtered durable answer without reading storage", () => {
    const { readEvents, reader } = readerWith([
      event(3),
      event(4, "other"),
      event(5, "selected", true),
      event(6),
    ]);

    expect(
      reader.tryReadFreshEvents({
        afterOffset: 2,
        throughOffset: 6,
        eventTypes: ["selected"],
        includeEphemeral: false,
        limit: 500,
      }),
    ).toEqual([event(3), event(6)]);
    expect(readEvents).not.toHaveBeenCalled();
  });

  it("returns once the requested match limit is satisfied", () => {
    const { reader } = readerWith([event(10), event(11), event(12)]);

    expect(
      reader.tryReadFreshEvents({
        afterOffset: 9,
        throughOffset: 100,
        includeEphemeral: false,
        limit: 2,
      }),
    ).toEqual([event(10), event(11)]);
  });

  it("declines a gap before or after the retained tail", () => {
    const { reader } = readerWith([event(5), event(6)]);
    expect(
      reader.tryReadFreshEvents({
        afterOffset: 3,
        throughOffset: 6,
        includeEphemeral: false,
        limit: 500,
      }),
    ).toBeUndefined();
    expect(
      reader.tryReadFreshEvents({
        afterOffset: 4,
        throughOffset: 7,
        includeEphemeral: false,
        limit: 500,
      }),
    ).toBeUndefined();
  });

  it("honours an exclusive upper bound and wildcard or empty type filters", () => {
    const { reader } = readerWith([event(20), event(21, "other"), event(22)]);
    expect(
      reader.tryReadFreshEvents({
        afterOffset: 19,
        throughOffset: 21,
        eventTypes: ["*"],
        includeEphemeral: false,
        limit: 500,
      }),
    ).toEqual([event(20), event(21, "other")]);
    expect(
      reader.tryReadFreshEvents({
        afterOffset: 0,
        throughOffset: 100,
        eventTypes: [],
        includeEphemeral: false,
        limit: 500,
      }),
    ).toEqual([]);
  });

  it("explicitly releases an idle append tail", () => {
    const { reader } = readerWith([event(1), event(2)]);
    reader.releaseFreshTail();

    expect(
      reader.tryReadFreshEvents({
        afterOffset: 0,
        throughOffset: 2,
        includeEphemeral: true,
        limit: 500,
      }),
    ).toBeUndefined();
  });

  it("explicitly releases storage-backed parsed projections", () => {
    const readEvents = vi
      .fn()
      .mockReturnValueOnce([1, 2, 3].map((offset) => ({ event: event(offset), byteLength: 64 })))
      .mockReturnValue([]);
    const reader = new StreamDeliveryFrameReader({ readEvents });

    expect(
      reader
        .read({ afterOffset: 0, throughOffset: 3, limit: 3 })
        .events.map((entry) => entry.offset),
    ).toEqual([1, 2, 3]);
    reader.releaseRetainedPayloads();

    expect(reader.read({ afterOffset: 0, throughOffset: 3, limit: 3 }).events).toEqual([]);
    expect(readEvents).toHaveBeenCalledTimes(2);
  });
});
