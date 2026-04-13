import { describe, expect, it, vi } from "vitest";
import { ensurePreviewInventory } from "./preview-inventory.ts";

describe("ensurePreviewInventory", () => {
  it("adds missing preview slots for a new preview app type", async () => {
    const add = vi.fn(async () => undefined);
    const list = vi.fn(async () => []);

    await ensurePreviewInventory({
      appSlug: "codemode",
      client: { add, list },
      count: 3,
      type: "codemode-preview-environment",
    });

    expect(list).toHaveBeenCalledWith({
      type: "codemode-preview-environment",
    });
    expect(add.mock.calls).toEqual([
      [
        {
          slug: "codemode-preview-1",
          type: "codemode-preview-environment",
        },
      ],
      [
        {
          slug: "codemode-preview-2",
          type: "codemode-preview-environment",
        },
      ],
      [
        {
          slug: "codemode-preview-3",
          type: "codemode-preview-environment",
        },
      ],
    ]);
  });

  it("skips existing slots and ignores duplicate add conflicts", async () => {
    const add = vi.fn(async ({ slug }: { slug: string; type: string }) => {
      if (slug === "codemode-preview-3") {
        throw new Error("Resource already exists for this type and slug.");
      }
    });
    const list = vi.fn(async () => [
      { slug: "codemode-preview-1" },
      { slug: "codemode-preview-4" },
    ]);

    await ensurePreviewInventory({
      appSlug: "codemode",
      client: { add, list },
      count: 4,
      type: "codemode-preview-environment",
    });

    expect(add.mock.calls).toEqual([
      [
        {
          slug: "codemode-preview-2",
          type: "codemode-preview-environment",
        },
      ],
      [
        {
          slug: "codemode-preview-3",
          type: "codemode-preview-environment",
        },
      ],
    ]);
  });
});
