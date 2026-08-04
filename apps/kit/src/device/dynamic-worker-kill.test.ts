import { describe, expect, test, vi } from "vitest";
import { killDynamicWorkerGeneration } from "./dynamic-worker-kill.ts";

describe("dynamic worker generation kill", () => {
  test("recognises the exact ctx.abort acknowledgement as a completed kill", async () => {
    /*
     * A Durable Object cannot both abort every live RPC and return a normal
     * acknowledgement on the RPC which requested that abort. Production
     * therefore rejects kill() with this exact reason after doing the work.
     * Treating it as an ordinary failure left the AEC fixture selected and
     * reused a dead worker stub, so this boundary is part of provider safety.
     */
    const kill = vi.fn().mockRejectedValue(new Error("kill requested"));

    await expect(killDynamicWorkerGeneration({ kill })).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledOnce();
  });

  test("does not turn a different transport failure into a successful kill", async () => {
    /*
     * Only the object-authored abort reason proves the generation terminated.
     * A timeout or severed network can leave it alive, so accepting arbitrary
     * rejections would make the next provider mode indeterminate.
     */
    const failure = new Error("WebSocket closed before the request was delivered");

    await expect(
      killDynamicWorkerGeneration({ kill: vi.fn().mockRejectedValue(failure) }),
    ).rejects.toBe(failure);
  });

  test("also accepts a future implementation which acknowledges normally", async () => {
    await expect(
      killDynamicWorkerGeneration({ kill: vi.fn().mockResolvedValue(undefined) }),
    ).resolves.toBeUndefined();
  });
});
