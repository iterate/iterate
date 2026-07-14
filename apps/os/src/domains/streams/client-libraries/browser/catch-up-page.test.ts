import { describe, expect, it, vi } from "vitest";
import { readCatchUpPage } from "./catch-up-page.ts";

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
