import { describe, expect, it, vi } from "vitest";
import { settleByDeadline } from "./execution-deadline.ts";

describe("settleByDeadline", () => {
  it("returns a fulfilled result before the absolute deadline", async () => {
    await expect(settleByDeadline(Promise.resolve(42), 1_100, () => 1_000)).resolves.toEqual({
      status: "fulfilled",
      value: 42,
    });
  });

  it("returns at the deadline while continuing to observe the losing promise", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      let rejectLate: ((error: Error) => void) | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      });
      const outcome = settleByDeadline(late, 1_100, Date.now);

      await vi.advanceTimersByTimeAsync(100);
      await expect(outcome).resolves.toEqual({ status: "deadline" });

      // The rejection handler was attached before the race. A cancellation
      // rejection after the deadline is therefore consumed, not unhandled.
      rejectLate?.(new Error("execution context cancelled"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns immediately when the absolute deadline already passed", async () => {
    let rejectLate: ((error: Error) => void) | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });

    await expect(settleByDeadline(late, 999, () => 1_000)).resolves.toEqual({
      status: "deadline",
    });

    // The rejection observer is installed before the expired fast path, so a
    // worker cancellation arriving afterward is still consumed.
    rejectLate?.(new Error("worker cancelled after an already-expired call"));
    await Promise.resolve();
  });
});
