import { describe, expect, it, vi } from "vitest";
import {
  ensureSandboxReadiness,
  SANDBOX_READINESS_ATTEMPT_TIMEOUT_MS,
  SANDBOX_READINESS_RECYCLE_TIMEOUT_MS,
} from "./sandbox-readiness.ts";

describe("ensureSandboxReadiness", () => {
  it("recycles one silent placement and succeeds on one fresh placement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const firstAttempt = Promise.withResolvers<void>();
    const onAttemptDeadline = vi.fn();
    const recycle = vi.fn(async () => undefined);
    let attempts = 0;
    const attempt = vi.fn(() => {
      attempts += 1;
      return attempts === 1 ? firstAttempt.promise : Promise.resolve();
    });

    const readiness = ensureSandboxReadiness({
      attempt,
      attemptTimeoutMs: 100,
      onAttemptDeadline,
      recycle,
      recycleTimeoutMs: 50,
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      await expect(readiness).resolves.toBeUndefined();
      expect(attempt).toHaveBeenCalledTimes(2);
      expect(recycle).toHaveBeenCalledOnce();
      expect(onAttemptDeadline).toHaveBeenCalledWith({
        attempt: 1,
        attemptTimeoutMs: 100,
        maxAttempts: 2,
      });
    } finally {
      firstAttempt.reject(new Error("late rejection from recycled placement"));
      await readiness.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("destroys the final silent placement and reports bounded exhaustion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const attempts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const attempt = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(attempts[0].promise)
      .mockReturnValueOnce(attempts[1].promise);
    const recycle = vi.fn(async () => undefined);
    const readiness = ensureSandboxReadiness({
      attempt,
      attemptTimeoutMs: 100,
      recycle,
      recycleTimeoutMs: 50,
    });
    const rejected = expect(readiness).rejects.toThrow(
      "Sandbox did not become ready across 2 container placements; each readiness attempt was bounded at 100ms and each timed-out container was destroyed",
    );
    try {
      await vi.advanceTimersByTimeAsync(200);
      await rejected;
      expect(attempt).toHaveBeenCalledTimes(2);
      expect(recycle).toHaveBeenCalledTimes(2);
    } finally {
      attempts.forEach((pending) =>
        pending.reject(new Error("late rejection from exhausted placement")),
      );
      await readiness.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("keeps an immediate readiness failure terminal without recycling", async () => {
    const failure = new Error("workspace restore was denied");
    const recycle = vi.fn(async () => undefined);

    await expect(
      ensureSandboxReadiness({
        attempt: async () => {
          throw failure;
        },
        recycle,
      }),
    ).rejects.toBe(failure);
    expect(recycle).not.toHaveBeenCalled();
  });

  it("bounds and preserves a stuck recycle instead of starting an unconfirmed placement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const attempt = Promise.withResolvers<void>();
    const recycle = Promise.withResolvers<void>();
    const onRecycleDeadline = vi.fn();
    const readiness = ensureSandboxReadiness({
      attempt: () => attempt.promise,
      attemptTimeoutMs: 100,
      onRecycleDeadline,
      recycle: () => recycle.promise,
      recycleTimeoutMs: 50,
    });
    const rejected = expect(readiness).rejects.toThrow(
      "Sandbox readiness attempt 1/2 timed out and its container recycle did not settle within 50ms",
    );
    try {
      await vi.advanceTimersByTimeAsync(150);
      await rejected;
      expect(onRecycleDeadline).toHaveBeenCalledWith({
        attempt: 1,
        recycle: recycle.promise,
        recycleTimeoutMs: 50,
      });
    } finally {
      attempt.reject(new Error("late readiness rejection"));
      recycle.resolve();
      await vi.runAllTimersAsync();
      await readiness.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("exports production bounds that fit inside the catalogue operation watchdog", () => {
    expect(SANDBOX_READINESS_ATTEMPT_TIMEOUT_MS).toBe(30_000);
    expect(SANDBOX_READINESS_RECYCLE_TIMEOUT_MS).toBe(15_000);
    expect(
      2 * SANDBOX_READINESS_ATTEMPT_TIMEOUT_MS + 2 * SANDBOX_READINESS_RECYCLE_TIMEOUT_MS,
    ).toBeLessThan(150_000);
  });
});
