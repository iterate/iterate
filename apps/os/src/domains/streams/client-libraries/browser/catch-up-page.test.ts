import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "iterate/processors";
import {
  catchUpAvailableHistory,
  catchUpToLiveReplayBoundary,
  readCatchUpPage,
} from "./catch-up-page.ts";

const TEST_STREAM_ID = "11111111-1111-4111-8111-111111111111";
const RECREATED_STREAM_ID = "22222222-2222-4222-8222-222222222222";

describe("readCatchUpPage", () => {
  it("halves an oversized RPC page until it fits", async () => {
    const read = vi.fn(async (limit: number) => {
      if (limit > 125) {
        throw new Error(
          "Serialized RPC arguments or return values are limited to 32 MiB, but the size of this value was: 35669548 bytes.",
        );
      }
      return { streamId: TEST_STREAM_ID, events: [{ offset: 1 }] };
    });

    await expect(readCatchUpPage(500, read)).resolves.toEqual({
      limit: 125,
      streamId: TEST_STREAM_ID,
      page: [{ offset: 1 }],
    });
    expect(read.mock.calls.map(([limit]) => limit)).toEqual([500, 250, 125]);
  });

  it("does not retry unrelated failures", async () => {
    const read = vi.fn(async () => {
      throw new Error("stream unavailable");
    });

    await expect(readCatchUpPage(500, read)).rejects.toThrow("stream unavailable");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("fails closed when one event is too large", async () => {
    const error = new Error(
      "Serialized RPC arguments or return values are limited to 32 MiB, but the size of this value was: 40000000 bytes.",
    );
    const read = vi.fn(async () => {
      throw error;
    });

    await expect(readCatchUpPage(1, read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("catchUpAvailableHistory", () => {
  it("ingests buffered ephemeral events before opening after the captured maximum offset", async () => {
    const event = (offset: number, ephemeral = false): StreamEvent => ({
      type: ephemeral ? "events.iterate.com/test/chunk" : "events.iterate.com/test/durable",
      offset,
      createdAt: new Date(offset).toISOString(),
      path: "/tests/catch-up",
      ...(ephemeral && { ephemeral: true as const }),
    });
    const serverEvents = [event(1), event(2, true), event(3), event(4, true)];
    const reads: Array<{ afterOffset: number; beforeOffset: number; limit: number }> = [];
    const ingested: StreamEvent[] = [];
    const scans: Array<[number, number]> = [];

    const result = await catchUpAvailableHistory({
      afterOffset: 0,
      throughOffset: 4,
      pageLimit: 2,
      expectedStreamId: TEST_STREAM_ID,
      read: async (input) => {
        reads.push(input);
        return {
          streamId: TEST_STREAM_ID,
          events: serverEvents
            .filter((item) => item.offset > input.afterOffset && item.offset < input.beforeOffset)
            .slice(0, input.limit),
        };
      },
      ingest: async (page) => {
        ingested.push(...page.events);
        scans.push([page.scannedAfterOffset, page.scannedThroughOffset]);
      },
    });

    expect(ingested.map((item) => item.offset)).toEqual([1, 2, 3, 4]);
    expect(reads).toEqual([
      { afterOffset: 0, beforeOffset: 5, limit: 2 },
      { afterOffset: 2, beforeOffset: 5, limit: 2 },
    ]);
    expect(scans).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(result).toEqual({ pageLimit: 2, replayAfterOffset: 4 });
  });

  it("advances across a bounded range whose events are no longer available", async () => {
    const scans: Array<{ events: readonly StreamEvent[]; through: number }> = [];
    const result = await catchUpAvailableHistory<StreamEvent>({
      afterOffset: 5,
      throughOffset: 9,
      pageLimit: 500,
      expectedStreamId: TEST_STREAM_ID,
      read: async () => ({ streamId: TEST_STREAM_ID, events: [] }),
      ingest: async (page) => {
        scans.push({ events: page.events, through: page.scannedThroughOffset });
      },
    });

    expect(scans).toEqual([{ events: [], through: 9 }]);
    expect(result).toEqual({ pageLimit: 500, replayAfterOffset: 9 });
  });

  it("rejects a recreated stream before ingesting the first page from its new lifetime", async () => {
    const ingestedOffsets: number[] = [];
    let reads = 0;

    await expect(
      catchUpAvailableHistory({
        afterOffset: 0,
        throughOffset: 2,
        pageLimit: 1,
        expectedStreamId: TEST_STREAM_ID,
        read: async () => {
          reads += 1;
          return {
            streamId: reads === 1 ? TEST_STREAM_ID : RECREATED_STREAM_ID,
            events: [{ offset: reads }],
          };
        },
        ingest: async (page) => {
          ingestedOffsets.push(...page.events.map((event) => event.offset));
        },
      }),
    ).rejects.toThrow(
      `stream ID changed during catch-up page read (${TEST_STREAM_ID} -> ${RECREATED_STREAM_ID})`,
    );
    expect(ingestedOffsets).toEqual([1]);
  });
});

describe("catchUpToLiveReplayBoundary", () => {
  it("re-reads a moving maximum offset until the admitted replay is bounded", async () => {
    const ranges: Array<[number, number]> = [];
    const offsetSnapshots = [
      { streamId: TEST_STREAM_ID, maxOffset: 5_000 },
      { streamId: TEST_STREAM_ID, maxOffset: 5_100 },
    ];

    const result = await catchUpToLiveReplayBoundary({
      afterOffset: 0,
      throughOffset: 100,
      pageLimit: 500,
      maxReplayOffsetGap: 2_000,
      expectedStreamId: TEST_STREAM_ID,
      catchUp: async (input) => {
        ranges.push([input.afterOffset, input.throughOffset]);
        return { pageLimit: input.pageLimit, replayAfterOffset: input.throughOffset };
      },
      readLatestOffset: async () => offsetSnapshots.shift()!,
    });

    expect(ranges).toEqual([
      [0, 100],
      [100, 5_000],
    ]);
    expect(result).toEqual({ pageLimit: 500, replayAfterOffset: 5_000 });
  });

  it("rejects history that crosses a stream recreation", async () => {
    await expect(
      catchUpToLiveReplayBoundary({
        afterOffset: 0,
        throughOffset: 10,
        pageLimit: 500,
        maxReplayOffsetGap: 2_000,
        expectedStreamId: TEST_STREAM_ID,
        catchUp: async (input) => ({
          pageLimit: input.pageLimit,
          replayAfterOffset: input.throughOffset,
        }),
        readLatestOffset: async () => ({
          streamId: RECREATED_STREAM_ID,
          maxOffset: 10,
        }),
      }),
    ).rejects.toThrow(
      `stream ID changed during catch-up (${TEST_STREAM_ID} -> ${RECREATED_STREAM_ID})`,
    );
  });
});
