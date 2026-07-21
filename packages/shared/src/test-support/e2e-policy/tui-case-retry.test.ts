import { describe, expect, it, vi } from "vitest";
import { runTuiCaseWithRetry } from "./tui-case-retry.ts";

describe("runTuiCaseWithRetry", () => {
  it("runs a failed case again as a distinct external attempt", async () => {
    const runAttempt = vi
      .fn()
      .mockResolvedValueOnce({ passed: false, failure: "first process timed out" })
      .mockResolvedValueOnce({ passed: true });
    const wait = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await expect(
      runTuiCaseWithRetry({
        maxAttempts: 2,
        retryDelayMs: 5_000,
        runAttempt,
        onRetry,
        wait,
      }),
    ).resolves.toEqual({
      attemptsUsed: 2,
      passed: true,
      firstFailure: "first process timed out",
    });
    expect(runAttempt.mock.calls).toEqual([[1], [2]]);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, failure: "first process timed out" });
    expect(wait).toHaveBeenCalledWith(5_000);
  });

  it("does not create a retry when the first attempt passes", async () => {
    const runAttempt = vi.fn().mockResolvedValue({ passed: true });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      runTuiCaseWithRetry({
        maxAttempts: 2,
        retryDelayMs: 5_000,
        runAttempt,
        wait,
      }),
    ).resolves.toEqual({ attemptsUsed: 1, passed: true });
    expect(runAttempt).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
});
