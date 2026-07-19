import { afterEach, describe, expect, test, vi } from "vitest";
import { mintProjectIdWithBoundedHedges, ProjectIdMintDeadlineError } from "./project-id-mint.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("auth project-id RPC hedging", () => {
  test("returns an ordinary mint without a hedge", async () => {
    const mint = vi.fn(async () => ({ id: "prj_fast" }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(mintProjectIdWithBoundedHedges({ mint, slug: "fast" })).resolves.toEqual({
      id: "prj_fast",
    });
    expect(mint).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
  });

  test("rescues a stranded mint with one bounded hedge", async () => {
    const mint = vi
      .fn<() => Promise<{ id: string }>>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ id: "prj_hedged" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();

    const result = mintProjectIdWithBoundedHedges({ mint, slug: "hedged" });
    await vi.advanceTimersByTimeAsync(999);
    expect(mint).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ id: "prj_hedged" });
    expect(mint).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      "auth project-id RPC exceeded its hedge threshold",
      expect.objectContaining({ attempt: 2, slug: "hedged" }),
    );
  });

  test("fails explicitly after the bounded hedge deadline", async () => {
    const mint = vi.fn<() => Promise<{ id: string }>>(() => new Promise(() => {}));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();

    const result = mintProjectIdWithBoundedHedges({ mint, slug: "stranded" });
    const rejected = expect(result).rejects.toBeInstanceOf(ProjectIdMintDeadlineError);
    await vi.advanceTimersByTimeAsync(8_000);

    await rejected;
    expect(mint).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(
      "auth project-id RPC exhausted its bounded deadline",
      expect.objectContaining({ attempts: 3, elapsedMs: 8_000, slug: "stranded" }),
    );
  });

  test("does not retry a dependency rejection", async () => {
    const dependencyError = new Error("auth unavailable");
    const mint = vi.fn<() => Promise<{ id: string }>>().mockRejectedValue(dependencyError);

    await expect(mintProjectIdWithBoundedHedges({ mint, slug: "rejected" })).rejects.toBe(
      dependencyError,
    );
    expect(mint).toHaveBeenCalledOnce();
  });
});
