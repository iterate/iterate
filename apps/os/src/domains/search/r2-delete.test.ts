import { describe, expect, it, vi } from "vitest";
import { deleteR2ObjectIfPresent } from "./r2-delete.ts";

describe("deleteR2ObjectIfPresent", () => {
  it("models a missing key without issuing an error-producing delete", async () => {
    const bucket = {
      delete: vi.fn(async () => undefined),
      head: vi.fn(async () => null),
    };

    await expect(deleteR2ObjectIfPresent(bucket, "missing.md")).resolves.toBe(false);
    expect(bucket.head).toHaveBeenCalledWith("missing.md");
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("deletes an existing key", async () => {
    const bucket = {
      delete: vi.fn(async () => undefined),
      head: vi.fn(async () => ({ key: "present.md" })),
    };

    await expect(deleteR2ObjectIfPresent(bucket, "present.md")).resolves.toBe(true);
    expect(bucket.delete).toHaveBeenCalledWith("present.md");
  });

  it("preserves real storage failures", async () => {
    const failure = new Error("R2 unavailable");
    const bucket = {
      delete: vi.fn(async () => {
        throw failure;
      }),
      head: vi.fn(async () => ({ key: "present.md" })),
    };

    await expect(deleteR2ObjectIfPresent(bucket, "present.md")).rejects.toBe(failure);
  });
});
