import { beforeEach, describe, expect, it, vi } from "vitest";

const searchBinding = vi.hoisted(() => ({
  createJob: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../env.ts", () => ({
  itxEnv: {
    SEARCH_INSTANCES: {
      get: searchBinding.get,
      list: searchBinding.list,
    },
    WORKER_SELF: "os-test",
  },
}));

import { triggerProjectSearchSyncDebounced } from "./search-index.ts";

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
});
