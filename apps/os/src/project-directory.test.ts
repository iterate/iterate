import { describe, expect, it, vi } from "vitest";
import { primeProjectDirectory, type ProjectDirectoryRecord } from "./project-directory.ts";

const record: ProjectDirectoryRecord = {
  id: "prj_alpha",
  slug: "alpha",
  organizationId: null,
  name: "Alpha",
};

function directoryWithPut(put: ReturnType<typeof vi.fn>): KVNamespace {
  return { put } as unknown as KVNamespace;
}

describe("primeProjectDirectory", () => {
  it("writes both durable lookup keys", async () => {
    const put = vi.fn().mockResolvedValue(undefined);

    await primeProjectDirectory(directoryWithPut(put), record);

    const body = JSON.stringify(record);
    expect(put.mock.calls).toEqual([
      ["slug:alpha", body],
      ["project:prj_alpha", body],
    ]);
  });

  it("recovers from one timed-out attempt and observes its late rejection", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rejectLate: Array<(error: Error) => void> = [];
      const put = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectLate.push(reject);
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectLate.push(reject);
            }),
        )
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);
      const primed = primeProjectDirectory(directoryWithPut(put), record);

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(primed).resolves.toBeUndefined();

      expect(put).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledWith(
        "[project-directory] write failed; retrying",
        expect.objectContaining({ attempt: 1, maxAttempts: 2 }),
      );
      for (const reject of rejectLate) reject(new Error("late platform cancellation"));
      await Promise.resolve();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects after two failed attempts instead of swallowing the dependency error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const put = vi.fn().mockRejectedValue(new Error("KV unavailable"));

      await expect(primeProjectDirectory(directoryWithPut(put), record)).rejects.toThrow(
        "Project directory write failed after 2 attempts: KV unavailable",
      );
      expect(put).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects after two bounded attempts when KV never settles", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const put = vi.fn(() => new Promise<void>(() => {}));
      const primed = primeProjectDirectory(directoryWithPut(put), record);
      const rejected = expect(primed).rejects.toThrow(
        "Project directory write failed after 2 attempts: Project directory KV write timed out after 10000ms",
      );

      await vi.advanceTimersByTimeAsync(20_000);

      await rejected;
      expect(put).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
