import { describe, expect, it, vi } from "vitest";
import type { ProcessorProgress, ProcessorProgressStore } from "iterate/processors";
import { reconcileBrowserProcessorCache } from "./processor-cache-reconciliation.ts";

const STREAM_A = "11111111-1111-4111-8111-111111111111";
const STREAM_B = "22222222-2222-4222-8222-222222222222";

function progressAt(offset: number, streamId = STREAM_B): ProcessorProgress<unknown> {
  return {
    streamId,
    reduction: { reducerVersion: "test", reducedThroughOffset: offset, state: {} },
    processing: { acknowledgedThroughOffset: offset, cursorRevision: 0 },
  };
}

function progressStore(offset: number, operations: string[]): ProcessorProgressStore<unknown> {
  return {
    read: () => {
      operations.push("read-progress");
      return progressAt(offset);
    },
    commit: () => {
      throw new Error("commit is not part of cache reconciliation");
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("reconcileBrowserProcessorCache", () => {
  it("starts no local operation after its writer election was already superseded", async () => {
    const operations: string[] = [];
    await expect(
      reconcileBrowserProcessorCache({
        streamPath: "/tests/cache",
        serverState: { streamId: STREAM_B, maxOffset: 5 },
        processors: [
          {
            processor: { slug: "feed", schemaVersion: 2 },
            progress: progressStore(5, operations),
          },
        ],
        isCurrentWriter: () => false,
        actions: {
          readRecordedStreamId: async () => STREAM_B,
          recordStreamId: async () => {},
          readRecordedSchemaVersion: async () => 2,
          recordSchemaVersion: async () => {},
          clearProcessorData: async () => {},
          finishDiscard: async () => {},
        },
      }),
    ).rejects.toThrow(/writer election was superseded/);
    expect(operations).toEqual([]);
  });

  it("allows only the already-posted SQLite operation to finish when superseded mid-clear", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const operations: string[] = [];
      const clearStarted = deferred();
      const releaseClear = deferred();
      let current = true;
      const reconciliation = reconcileBrowserProcessorCache({
        streamPath: "/tests/cache",
        serverState: { streamId: STREAM_B, maxOffset: 5 },
        processors: [
          {
            processor: { slug: "feed", schemaVersion: 2 },
            progress: progressStore(5, operations),
          },
        ],
        isCurrentWriter: () => current,
        actions: {
          readRecordedStreamId: async () => {
            operations.push("read-stream-id");
            return STREAM_A;
          },
          recordStreamId: async () => void operations.push("record-stream-id"),
          readRecordedSchemaVersion: async () => 2,
          recordSchemaVersion: async () => void operations.push("record-schema"),
          clearProcessorData: async () => {
            operations.push("clear:start");
            clearStarted.resolve();
            await releaseClear.promise;
            operations.push("clear:committed");
          },
          finishDiscard: async () => void operations.push("finish-discard"),
        },
      });

      await clearStarted.promise;
      current = false;
      releaseClear.resolve();

      await expect(reconciliation).rejects.toThrow(/writer election was superseded/);
      expect(operations).toEqual([
        "read-progress",
        "read-stream-id",
        "clear:start",
        "clear:committed",
      ]);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it.each([
    {
      name: "records an empty cache without clearing it",
      localOffset: 0,
      localStreamId: undefined,
      localSchemaVersion: undefined,
      processor: { slug: "feed", schemaVersion: 2, resetOnSchemaVersionChange: true },
      expected: [
        "read-progress",
        "read-stream-id",
        "read-schema",
        "record-schema:2",
        `record-stream-id:${STREAM_B}`,
      ],
    },
    {
      name: "clears rows written by an older processor schema",
      localOffset: 5,
      localStreamId: STREAM_B,
      localSchemaVersion: 1,
      processor: { slug: "feed", schemaVersion: 2, resetOnSchemaVersionChange: true },
      expected: [
        "read-progress",
        "read-stream-id",
        "read-schema",
        `clear:${STREAM_B}`,
        "record-schema:2",
        `record-stream-id:${STREAM_B}`,
        "finish-discard",
      ],
    },
    {
      name: "clears rows written from a previous stream lifetime",
      localOffset: 5,
      localStreamId: STREAM_A,
      localSchemaVersion: 2,
      processor: { slug: "feed", schemaVersion: 2 },
      expected: [
        "read-progress",
        "read-stream-id",
        `clear:${STREAM_B}`,
        `record-stream-id:${STREAM_B}`,
        "finish-discard",
      ],
    },
    {
      name: "clears a cursor beyond the server's current head",
      localOffset: 8,
      localStreamId: STREAM_B,
      localSchemaVersion: 2,
      processor: { slug: "feed", schemaVersion: 2, resetOnSchemaVersionChange: true },
      expected: [
        "read-progress",
        "read-stream-id",
        "read-schema",
        `clear:${STREAM_B}`,
        "record-schema:2",
        `record-stream-id:${STREAM_B}`,
        "finish-discard",
      ],
    },
  ] satisfies {
    name: string;
    localOffset: number;
    localStreamId: string | undefined;
    localSchemaVersion: number | undefined;
    processor: {
      slug: string;
      schemaVersion: number;
      resetOnSchemaVersionChange?: boolean;
    };
    expected: string[];
  }[])("$name", async (fixture) => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const operations: string[] = [];
      const result = await reconcileBrowserProcessorCache({
        streamPath: "/tests/cache",
        serverState: { streamId: STREAM_B, maxOffset: 5 },
        processors: [
          {
            processor: fixture.processor,
            progress: progressStore(fixture.localOffset, operations),
          },
        ],
        isCurrentWriter: () => true,
        actions: {
          readRecordedStreamId: async () => {
            operations.push("read-stream-id");
            return fixture.localStreamId;
          },
          recordStreamId: async (_slug, streamId) =>
            void operations.push(`record-stream-id:${streamId}`),
          readRecordedSchemaVersion: async () => {
            operations.push("read-schema");
            return fixture.localSchemaVersion;
          },
          recordSchemaVersion: async (_slug, version) =>
            void operations.push(`record-schema:${version}`),
          clearProcessorData: async (_processor, streamId) =>
            void operations.push(`clear:${streamId}`),
          finishDiscard: async () => void operations.push("finish-discard"),
        },
      });

      expect(result).toEqual({ serverMaxOffset: 5, serverStreamId: STREAM_B });
      expect(operations).toEqual(fixture.expected);
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
