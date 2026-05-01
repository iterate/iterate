import { describe, expect, it, vi } from "vitest";
import {
  ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  parseEnvironmentConfigLeaseData,
  syncPreviewInventory,
} from "./preview-inventory.ts";

describe("syncPreviewInventory", () => {
  it("adds missing shared environment config lease resources", async () => {
    const add = vi.fn(async () => undefined);
    const deleteResource = vi.fn(async () => undefined);
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await syncPreviewInventory({
      client: { add, delete: deleteResource, list },
      inventory: [
        {
          data: { dopplerConfig: "preview_1" },
          slug: "preview-1",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
        {
          data: { dopplerConfig: "preview_2" },
          slug: "preview-2",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
      ],
    });

    expect(deleteResource).not.toHaveBeenCalled();
    expect(add.mock.calls).toEqual([
      [
        {
          data: { dopplerConfig: "preview_1" },
          slug: "preview-1",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
      ],
      [
        {
          data: { dopplerConfig: "preview_2" },
          slug: "preview-2",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
      ],
    ]);
  });

  it("deletes drifted resources before recreating expected resources", async () => {
    const add = vi.fn(async () => undefined);
    const deleteResource = vi.fn(async () => undefined);
    const list = vi
      .fn()
      .mockResolvedValueOnce([
        { data: {}, slug: "preview-1" },
        { data: { dopplerConfig: "preview_2" }, slug: "preview-2" },
        { data: { dopplerConfig: "preview_99" }, slug: "preview-99" },
      ])
      .mockResolvedValueOnce([{ data: { dopplerConfig: "preview_2" }, slug: "preview-2" }]);

    await syncPreviewInventory({
      client: { add, delete: deleteResource, list },
      inventory: [
        {
          data: { dopplerConfig: "preview_1" },
          slug: "preview-1",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
        {
          data: { dopplerConfig: "preview_2" },
          slug: "preview-2",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
      ],
    });

    expect(deleteResource.mock.calls).toEqual([
      [{ slug: "preview-1", type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE }],
      [{ slug: "preview-99", type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE }],
    ]);
    expect(add.mock.calls).toEqual([
      [
        {
          data: { dopplerConfig: "preview_1" },
          slug: "preview-1",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
      ],
    ]);
  });
});

describe("parseEnvironmentConfigLeaseData", () => {
  it("requires a dopplerConfig string", () => {
    expect(parseEnvironmentConfigLeaseData({ dopplerConfig: " preview_1 " })).toEqual({
      dopplerConfig: "preview_1",
    });
    expect(() => parseEnvironmentConfigLeaseData({})).toThrow(
      "Environment config lease data must include dopplerConfig.",
    );
  });
});
