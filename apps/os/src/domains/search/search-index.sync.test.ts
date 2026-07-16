import { beforeEach, describe, expect, it, vi } from "vitest";

const searchBinding = vi.hoisted(() => ({
  createJob: vi.fn(),
  deleteObject: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  putObject: vi.fn(),
}));

vi.mock("../../env.ts", () => ({
  itxEnv: {
    SEARCH_INSTANCES: {
      get: searchBinding.get,
      list: searchBinding.list,
    },
    SEARCH_BUCKET: {
      delete: searchBinding.deleteObject,
      put: searchBinding.putObject,
    },
    WORKER_SELF: "os-test",
  },
}));

import {
  enqueueAutomaticStreamIndex,
  indexStreamEventBatch,
  triggerProjectSearchSyncDebounced,
} from "./search-index.ts";

beforeEach(() => {
  vi.clearAllMocks();
  searchBinding.get.mockReturnValue({ jobs: { create: searchBinding.createJob } });
});

describe("passive project search sync", () => {
  it("does not touch a missing instance handle", async () => {
    searchBinding.list.mockResolvedValue({ result: [], result_info: { total_count: 0 } });
    searchBinding.createJob.mockRejectedValue(new Error("ai_search_not_found"));

    await triggerProjectSearchSyncDebounced("prj_00000000000000000000000000000001");

    expect(searchBinding.list).toHaveBeenCalledWith({
      per_page: 100,
      search: "00000000000000000000000000000001",
    });
    expect(searchBinding.get).not.toHaveBeenCalled();
    expect(searchBinding.createJob).not.toHaveBeenCalled();
  });

  it("triggers a sync when the exact instance exists", async () => {
    searchBinding.list.mockResolvedValue({
      result: [{ id: "00000000000000000000000000000002" }],
      result_info: { total_count: 1 },
    });
    searchBinding.createJob.mockResolvedValue({});

    await triggerProjectSearchSyncDebounced("prj_00000000000000000000000000000002");

    expect(searchBinding.get).toHaveBeenCalledWith("00000000000000000000000000000002");
    expect(searchBinding.createJob).toHaveBeenCalledOnce();
  });

  it("retries the instance lookup after a transient probe failure", async () => {
    searchBinding.list
      .mockRejectedValueOnce(new Error("temporary AI Search control-plane failure"))
      .mockResolvedValueOnce({
        result: [{ id: "00000000000000000000000000000004" }],
        result_info: { total_count: 1 },
      });
    searchBinding.createJob.mockResolvedValue({});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await triggerProjectSearchSyncDebounced("prj_00000000000000000000000000000004");
      await triggerProjectSearchSyncDebounced("prj_00000000000000000000000000000004");
    } finally {
      warn.mockRestore();
    }

    expect(searchBinding.list).toHaveBeenCalledTimes(2);
    expect(searchBinding.get).toHaveBeenCalledWith("00000000000000000000000000000004");
    expect(searchBinding.createJob).toHaveBeenCalledOnce();
  });
});

describe("automatic stream indexing", () => {
  it("serializes the same stream across independent target callers", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const key = {
      projectId: "prj_00000000000000000000000000000005",
      path: "/agents/reminted",
    };

    const first = enqueueAutomaticStreamIndex({
      ...key,
      run: async () => {
        order.push("first:start");
        await firstBlocked;
        order.push("first:end");
      },
    });
    const second = enqueueAutomaticStreamIndex({
      ...key,
      run: async () => {
        order.push("second");
      },
    });

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("does not delete an absent segment when the batch has no indexable events", async () => {
    const housekeepingEvent = {
      type: "events.iterate.com/stream/woken",
      offset: 1,
      createdAt: "2026-07-16T00:00:00.000Z",
      path: "/agents/test",
      payload: {},
    };

    await indexStreamEventBatch({
      batch: {
        projectId: "prj_00000000000000000000000000000003",
        path: "/agents/test",
        events: [housekeepingEvent],
        streamMaxOffset: 1,
        subscriptionKey: "project-worker",
        deliveryId: "project-worker:1-1",
        attempt: 1,
        configuredEvent: {
          type: "events.iterate.com/stream/subscription-configured",
          offset: 0,
          createdAt: "2026-07-16T00:00:00.000Z",
          path: "/agents/test",
          payload: {},
        },
      },
      readEvents: vi.fn().mockResolvedValue([housekeepingEvent]),
    });

    expect(searchBinding.deleteObject).not.toHaveBeenCalled();
    expect(searchBinding.putObject).not.toHaveBeenCalled();
  });
});
