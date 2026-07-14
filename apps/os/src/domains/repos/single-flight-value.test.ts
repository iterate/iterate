import { describe, expect, it, vi } from "vitest";
import { SingleFlightValue } from "./single-flight-value.ts";

describe("SingleFlightValue", () => {
  it("shares one in-flight load across concurrent callers", async () => {
    const cache = new SingleFlightValue<string>();
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const load = vi.fn(() => pending);

    const first = cache.get(load);
    const second = cache.get(load);

    expect(load).toHaveBeenCalledTimes(1);
    resolve("snapshot");
    await expect(Promise.all([first, second])).resolves.toEqual(["snapshot", "snapshot"]);
  });

  it("drops a failed load so the next caller can retry", async () => {
    const cache = new SingleFlightValue<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("clone failed"))
      .mockResolvedValueOnce("recovered");

    await expect(cache.get(load)).rejects.toThrow("clone failed");
    await expect(cache.get(load)).resolves.toBe("recovered");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("serves but does not retain a value rejected by cache admission", async () => {
    const cache = new SingleFlightValue<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("stale snapshot")
      .mockResolvedValueOnce("fresh snapshot");

    await expect(cache.get(load, (value) => value === "fresh snapshot")).resolves.toBe(
      "stale snapshot",
    );
    await expect(cache.get(load, (value) => value === "fresh snapshot")).resolves.toBe(
      "fresh snapshot",
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not let an old rejected load clear a newer value after invalidation", async () => {
    const cache = new SingleFlightValue<string>();
    let rejectOld!: (error: Error) => void;
    const oldLoad = new Promise<string>((_resolve, reject) => {
      rejectOld = reject;
    });
    const first = cache.get(() => oldLoad);

    cache.clear();
    await expect(cache.get(async () => "new snapshot")).resolves.toBe("new snapshot");
    rejectOld(new Error("old clone failed"));
    await expect(first).rejects.toThrow("old clone failed");

    const shouldNotRun = vi.fn(async () => "wrong");
    await expect(cache.get(shouldNotRun)).resolves.toBe("new snapshot");
    expect(shouldNotRun).not.toHaveBeenCalled();
  });

  it("does not let an old admission rejection clear a newer value after invalidation", async () => {
    const cache = new SingleFlightValue<string>();
    let resolveOld!: (value: string) => void;
    const oldLoad = new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
    const first = cache.get(
      () => oldLoad,
      () => false,
    );

    cache.clear();
    await expect(cache.get(async () => "new snapshot")).resolves.toBe("new snapshot");
    resolveOld("old snapshot");
    await expect(first).resolves.toBe("old snapshot");

    const shouldNotRun = vi.fn(async () => "wrong");
    await expect(cache.get(shouldNotRun)).resolves.toBe("new snapshot");
    expect(shouldNotRun).not.toHaveBeenCalled();
  });
});
