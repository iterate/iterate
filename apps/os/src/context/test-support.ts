// context/test-support.ts — what the context unit tests share.
import { vi } from "vitest";

/** Run `run` with every wait it takes elapsed at once: its answer or error, the warns it logged
 *  (`retries`: each `retryPlatformFailures` repeat logs one), and what it logged at info. */
export async function settle<T>(run: () => Promise<T>) {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const outcome = run().then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return {
      ...(await outcome),
      retries: warn.mock.calls.map(([entry]) => entry),
      logs: info.mock.calls.map(([entry]) => entry),
    };
  } finally {
    warn.mockRestore();
    info.mockRestore();
    vi.useRealTimers();
  }
}
