import { beforeEach, describe, expect, it, vi } from "vitest";

const bindings = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("../../env.ts", () => ({
  itxEnv: {
    SEARCH_INDEX_QUEUE: { send: bindings.send },
  },
}));

vi.mock("./search-index.ts", () => ({
  indexStreamSegments: vi.fn(),
  mirrorFileToSearchIndexStrict: vi.fn(),
  removeFileFromSearchIndexStrict: vi.fn(),
  triggerProjectSearchSyncDebounced: vi.fn(),
}));

import {
  enqueueStreamSearchIndex,
  parseSearchIndexQueueTask,
  type SearchIndexQueueTask,
} from "./search-index-queue.ts";
import {
  handleSearchIndexQueueBatch,
  searchIndexRetryDelaySeconds,
} from "./search-index-queue-entrypoint.ts";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("search-index queue task contract", () => {
  it("normalizes paths and de-duplicates stream segments", () => {
    expect(
      parseSearchIndexQueueTask({
        type: "search-index/reconcile-stream-segments",
        version: 1,
        projectId: "prj_123",
        path: "agents/test",
        segments: [2, 1, 2],
      }),
    ).toEqual({
      type: "search-index/reconcile-stream-segments",
      version: 1,
      projectId: "prj_123",
      path: "/agents/test",
      segments: [2, 1],
    });
  });

  it.each([
    null,
    { type: "search-index/reconcile-file", version: 2, projectId: "prj_123", path: "/a" },
    { type: "search-index/reconcile-file", version: 1, projectId: "other", path: "/a" },
    {
      type: "search-index/reconcile-stream-segments",
      version: 1,
      projectId: "prj_123",
      path: "/a",
      segments: [],
    },
  ])("rejects malformed task %#", (body) => {
    expect(() => parseSearchIndexQueueTask(body)).toThrow();
  });

  it("enqueues only an authoritative-state pointer", async () => {
    bindings.send.mockResolvedValue(undefined);

    await enqueueStreamSearchIndex({
      path: "/agents/test",
      projectId: "prj_123",
      segments: [0, 1],
    });

    expect(bindings.send).toHaveBeenCalledWith(
      {
        type: "search-index/reconcile-stream-segments",
        version: 1,
        path: "/agents/test",
        projectId: "prj_123",
        segments: [0, 1],
      },
      { contentType: "json" },
    );
  });
});

describe("search-index queue batch handling", () => {
  it.each([
    [0, 60],
    [1, 60],
    [2, 120],
    [6, 1_920],
    [100, 1_920],
  ])("backs off attempt %i by %i seconds", (attempts, expected) => {
    expect(searchIndexRetryDelaySeconds(attempts)).toBe(expected);
  });

  it("acks successful tasks serially with spacing", async () => {
    const first = queueMessage("first", fileTask("/first"));
    const second = queueMessage("second", fileTask("/second"));
    const order: string[] = [];

    await handleSearchIndexQueueBatch(batch([first, second]), queueEnv(), {
      pause: async (ms) => {
        order.push(`pause:${ms}`);
      },
      processTask: async (task) => {
        order.push(task.path);
      },
    });

    expect(order).toEqual(["/first", "pause:50", "/second", "pause:50"]);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(second.retry).not.toHaveBeenCalled();
  });

  it("retries one failure and defers untouched messages without another R2 call", async () => {
    const first = queueMessage("first", fileTask("/first"));
    const failed = queueMessage("failed", fileTask("/failed"));
    const deferred = queueMessage("deferred", fileTask("/deferred"));
    const processed: string[] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await handleSearchIndexQueueBatch(batch([first, failed, deferred]), queueEnv(), {
        pause: async () => undefined,
        processTask: async (task) => {
          processed.push(task.path);
          if (task.path === "/failed") throw new Error("bucket locked");
        },
      });
    } finally {
      errorLog.mockRestore();
    }

    expect(processed).toEqual(["/first", "/failed"]);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(deferred.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(deferred.ack).not.toHaveBeenCalled();
  });

  it("retries malformed messages instead of dropping them", async () => {
    const malformed = queueMessage("malformed", { nope: true });
    const processTask = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await handleSearchIndexQueueBatch(batch([malformed]), queueEnv(), { processTask });
    } finally {
      errorLog.mockRestore();
    }

    expect(processTask).not.toHaveBeenCalled();
    expect(malformed.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(malformed.ack).not.toHaveBeenCalled();
  });
});

function fileTask(path: string): SearchIndexQueueTask {
  return {
    type: "search-index/reconcile-file",
    version: 1,
    path,
    projectId: "prj_123",
  };
}

function queueMessage(id: string, body: unknown) {
  return {
    ack: vi.fn(),
    attempts: 1,
    body,
    id,
    retry: vi.fn(),
    timestamp: new Date(0),
  };
}

function batch(messages: ReturnType<typeof queueMessage>[]): MessageBatch<unknown> {
  return {
    ackAll: vi.fn(),
    messages,
    queue: "os-test-search-index-writes",
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

function queueEnv(): Parameters<typeof handleSearchIndexQueueBatch>[1] {
  return { WORKER_SELF: "os-test" } as Parameters<typeof handleSearchIndexQueueBatch>[1];
}
