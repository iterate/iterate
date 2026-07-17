import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "iterate/processors";
import {
  catchUpDurableHistory,
  catchUpToLiveReplayBoundary,
  readCatchUpPage,
} from "./catch-up-page.ts";

describe("readCatchUpPage", () => {
  it("halves an oversized RPC page until it fits", async () => {
    const read = vi.fn(async (limit: number) => {
      if (limit > 125) {
        throw new Error(
          "Serialized RPC arguments or return values are limited to 32 MiB, but the size of this value was: 35669548 bytes.",
        );
      }
      return [{ offset: 1 }];
    });

    await expect(readCatchUpPage(500, read)).resolves.toEqual({
      limit: 125,
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

describe("catchUpDurableHistory", () => {
  it("skips pre-existing ephemeral rows and subscribes after the captured head", async () => {
    const event = (offset: number, ephemeral = false): StreamEvent => ({
      type: ephemeral ? "events.iterate.com/test/chunk" : "events.iterate.com/test/durable",
      offset,
      createdAt: new Date(offset).toISOString(),
      path: "/tests/catch-up",
      ...(ephemeral ? { ephemeral: true as const } : {}),
    });
    const serverEvents = [event(1), event(2, true), event(3), event(4, true)];
    const reads: Array<{ afterOffset: number; beforeOffset: number; limit: number }> = [];
    const ingested: StreamEvent[] = [];
    const scans: Array<[number, number]> = [];

    const result = await catchUpDurableHistory({
      afterOffset: 0,
      throughOffset: 4,
      pageLimit: 2,
      read: async (input) => {
        reads.push(input);
        return serverEvents
          .filter(
            (item) =>
              item.ephemeral !== true &&
              item.offset > input.afterOffset &&
              item.offset < input.beforeOffset,
          )
          .slice(0, input.limit);
      },
      ingest: async (page) => {
        ingested.push(...page.events);
        scans.push([page.scannedAfterOffset, page.scannedThroughOffset]);
      },
    });

    expect(ingested.map((item) => item.offset)).toEqual([1, 3]);
    expect(reads).toEqual([
      { afterOffset: 0, beforeOffset: 5, limit: 2 },
      { afterOffset: 3, beforeOffset: 5, limit: 2 },
    ]);
    expect(scans).toEqual([
      [0, 3],
      [3, 4],
    ]);
    // Offsets 2 and 4 were scanned historical ephemerals. Starting the live
    // subscription after the captured head prevents either from replaying.
    expect(result).toEqual({ pageLimit: 2, replayAfterOffset: 4 });
  });

  it("advances across an all-ephemeral bounded range with an empty scan", async () => {
    const scans: Array<{ events: readonly StreamEvent[]; through: number }> = [];
    const result = await catchUpDurableHistory<StreamEvent>({
      afterOffset: 5,
      throughOffset: 9,
      pageLimit: 500,
      read: async () => [],
      ingest: async (page) => {
        scans.push({ events: page.events, through: page.scannedThroughOffset });
      },
    });

    expect(scans).toEqual([{ events: [], through: 9 }]);
    expect(result).toEqual({ pageLimit: 500, replayAfterOffset: 9 });
  });
});

describe("catchUpToLiveReplayBoundary", () => {
  it("re-reads a moving head until the admitted live replay is bounded", async () => {
    const ranges: Array<[number, number]> = [];
    const heads = [
      { createdAt: "incarnation-a", maxOffset: 5_000 },
      { createdAt: "incarnation-a", maxOffset: 5_100 },
    ];

    const result = await catchUpToLiveReplayBoundary({
      afterOffset: 0,
      throughOffset: 100,
      pageLimit: 500,
      maxReplayOffsetGap: 2_000,
      expectedIncarnation: "incarnation-a",
      catchUp: async (input) => {
        ranges.push([input.afterOffset, input.throughOffset]);
        return { pageLimit: input.pageLimit, replayAfterOffset: input.throughOffset };
      },
      readHead: async () => heads.shift()!,
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
        expectedIncarnation: "incarnation-a",
        catchUp: async (input) => ({
          pageLimit: input.pageLimit,
          replayAfterOffset: input.throughOffset,
        }),
        readHead: async () => ({ createdAt: "incarnation-b", maxOffset: 10 }),
      }),
    ).rejects.toThrow(
      "stream incarnation changed during catch-up (incarnation-a -> incarnation-b)",
    );
  });
});
