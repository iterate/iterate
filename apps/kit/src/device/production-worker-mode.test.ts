import { describe, expect, test, vi } from "vitest";
import { waitForProductionWorkerMode } from "./production-worker-mode.ts";

function health(mode: "grok" | "tone") {
  return Response.json({ mode, ok: true, service: "iterate-kit-voice" });
}

describe("production worker mode propagation fence", () => {
  test("waits until the worker location itself observes the new KV mode", async () => {
    /*
     * Project KV acknowledges a write before every edge cache observes it.
     * Reading through the same worker object which will accept `/pcm` is the
     * only useful fence: polling the writer can say tone while the physical
     * device still reaches a worker which constructs Grok.
     */
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(health("grok"))
      .mockResolvedValueOnce(health("grok"))
      .mockResolvedValueOnce(health("tone"));
    const pause = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForProductionWorkerMode({
        expectedMode: "tone",
        fetch,
        now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(10).mockReturnValueOnce(20),
        pause,
        retryDelayMs: 1,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ mode: "tone", ok: true, service: "iterate-kit-voice" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
  });

  test("fails visibly when health is malformed instead of trusting an attractive mode field", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ mode: "tone" }));

    await expect(
      waitForProductionWorkerMode({
        expectedMode: "tone",
        fetch,
        now: () => 0,
        pause: vi.fn(),
        retryDelayMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/malformed health response/u);
  });

  test("retains the last observed mode in a bounded timeout", async () => {
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(50).mockReturnValueOnce(101);

    await expect(
      waitForProductionWorkerMode({
        expectedMode: "tone",
        fetch: vi.fn(async () => health("grok")),
        now,
        pause: vi.fn().mockResolvedValue(undefined),
        retryDelayMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/still reported grok/u);
  });
});
