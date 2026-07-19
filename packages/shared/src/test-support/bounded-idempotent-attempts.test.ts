import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BoundedIdempotentAttemptsDeadlineError,
  runBoundedIdempotentAttempts,
} from "./bounded-idempotent-attempts.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded idempotent attempts", () => {
  test("retires an unsettled attempt before starting a fresh one", async () => {
    vi.useFakeTimers();
    const disposed: number[] = [];
    const timedOut: number[] = [];

    const result = runBoundedIdempotentAttempts({
      attemptTimeoutsMs: [10, 20],
      label: "deterministic project create",
      onAttemptTimeout: ({ attempt }) => timedOut.push(attempt),
      startAttempt: (attempt) => ({
        dispose: () => disposed.push(attempt),
        result: attempt === 1 ? new Promise<string>(() => {}) : Promise.resolve("created"),
      }),
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe("created");
    expect(timedOut).toEqual([1]);
    expect(disposed).toEqual([1, 2]);
  });

  test("does not replay an explicit operation failure", async () => {
    const failure = new Error("slug is invalid");
    const startAttempt = vi.fn(() => ({
      dispose: vi.fn(),
      result: Promise.reject(failure),
    }));

    await expect(
      runBoundedIdempotentAttempts({
        attemptTimeoutsMs: [10, 20],
        label: "deterministic project create",
        startAttempt,
      }),
    ).rejects.toBe(failure);
    expect(startAttempt).toHaveBeenCalledTimes(1);
  });

  test("fails explicitly after every bounded attempt remains unsettled", async () => {
    vi.useFakeTimers();
    const result = runBoundedIdempotentAttempts({
      attemptTimeoutsMs: [10, 20],
      label: "deterministic project create",
      startAttempt: () => ({
        dispose: vi.fn(),
        result: new Promise(() => {}),
      }),
    });
    const rejection = expect(result).rejects.toThrow(BoundedIdempotentAttemptsDeadlineError);

    await vi.advanceTimersByTimeAsync(30);
    await rejection;
  });
});
